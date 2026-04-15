// Build the full CachedBlob (parse + match + report) and read/write it to KV.
//
// The `buildBlob` function is pure and has no Cloudflare-specific runtime
// dependencies — it's called from both the worker (if ever moved to a paid
// plan with >10ms CPU budget) AND from scripts/refresh-kv.ts running in
// GitHub Actions, which fetches + parses the 200MB+ US XMLTV feed in Node
// and pushes the resulting blob to Cloudflare KV via the REST API. That
// split exists because the free-plan worker can't possibly process the US
// feed in its 10ms per-invocation CPU budget.

import { DEBRIDIO_CHANNELS } from "./channels";
import { fetchAndParseXmltv, ParsedProgramme, XmltvResult } from "./epgpw";
import { aliasesFor, debridioAliases } from "./matcher";
import { isSportsChannel } from "./sports";
import { CachedBlob, ChannelState, DebridioChannel, MatchReport, Program } from "./types";

// v3: ChannelState.current/next replaced with programmes[] window (4h back,
// 6h ahead). blurbFor() now scans the window at request time so it's always
// current — not a stale snapshot. Bumping the key forces a clean slate.
export const KV_STATE_KEY = "states:v3";

// How far back / ahead of refresh time to include programmes in the window.
// Back: covers any long show that started before the cron fired.
// Ahead: covers enough future slots that even a late cron still has data.
export const WINDOW_BACK_MS  = 4 * 60 * 60 * 1000; // 4 hours
export const WINDOW_AHEAD_MS = 6 * 60 * 60 * 1000; // 6 hours

const EPG_URLS = {
  ca: "https://epg.pw/xmltv/epg_CA.xml",
  usa: "https://epg.pw/xmltv/epg_US.xml",
} as const;

interface FeedDescriptor {
  kind: "primary" | "fallback" | "sports";
  countryHint?: "ca" | "usa";
  result: XmltvResult;
}

interface FeedCandidate {
  channelId: string;
  feedIndex: number;
}

export interface AdditionalGuideFeed {
  kind?: "fallback" | "sports";
  countryHint?: "ca" | "usa";
  result: XmltvResult;
}

// Pick the current and next programmes for a sorted programme list.
// Lists are pre-sorted ASC by start time, so we can early-exit as soon as
// we've seen a start > now.
function pickCurrentAndNext(
  programmes: ParsedProgramme[],
  nowMs: number
): { current?: ParsedProgramme; next?: ParsedProgramme } {
  let current: ParsedProgramme | undefined;
  let next: ParsedProgramme | undefined;
  for (const p of programmes) {
    const startMs = p.start.getTime();
    const stopMs = p.stop.getTime();
    if (startMs <= nowMs && nowMs < stopMs) {
      current = p;
    } else if (startMs > nowMs) {
      next = p;
      break;
    }
  }
  return { current, next };
}

export function hasUsableProgrammeWindow(
  programmes: ParsedProgramme[],
  nowMs: number
): boolean {
  const { current, next } = pickCurrentAndNext(programmes, nowMs);
  return !!current || (!!next && next.start.getTime() < nowMs + WINDOW_AHEAD_MS);
}

function toProgram(p: ParsedProgramme): Program {
  return {
    title: p.title,
    description: p.description,
    start: p.start.toISOString(),
    stop: p.stop.toISOString(),
  };
}

// Pure pipeline: fetch both feeds sequentially (memory-bound even at 128MB+,
// the US feed is 200MB+ decoded, so we rely on streaming in epgpw.ts to keep
// peak live memory low). Match every Debridio channel against the combined
// epg.pw data and build the CachedBlob. Produces a detailed MatchReport so
// /__status can surface exactly what happened during the refresh.
//
// If `channels` is provided (fetched dynamically from Debridio at cron time),
// it is used in place of the hardcoded DEBRIDIO_CHANNELS fallback.
export async function buildBlob(
  channels?: DebridioChannel[],
  extraFeeds: AdditionalGuideFeed[] = []
): Promise<CachedBlob> {
  const startMs = Date.now();
  const windowEnd = startMs + WINDOW_AHEAD_MS;
  const debridioChannels = channels && channels.length > 0 ? channels : DEBRIDIO_CHANNELS;

  const ca = await fetchAndParseXmltv(EPG_URLS.ca, "epg.pw CA");
  const us = await fetchAndParseXmltv(EPG_URLS.usa, "epg.pw US");
  const feeds: FeedDescriptor[] = [
    { kind: "primary", countryHint: "ca", result: ca },
    { kind: "primary", countryHint: "usa", result: us },
    ...extraFeeds.map(feed => ({
      kind: feed.kind ?? "fallback",
      countryHint: feed.countryHint,
      result: feed.result,
    })),
  ];

  // Build the alias → candidate channels lookup table from all feeds.
  // Primary epg.pw feeds come first; extra feeds act as fallback candidates.
  const aliasToChannel = new Map<string, FeedCandidate[]>();
  const ingestFeed = (
    feedIndex: number,
    channelDisplayNames: Map<string, string[]>
  ) => {
    for (const [channelId, names] of channelDisplayNames) {
      const channelBase = channelId.replace(/@.*$/, "");
      const channelBare = channelBase.replace(/\.(?:ca|us|usa)$/i, "");
      for (const aliasSource of [channelId, channelBase, channelBare, ...names]) {
        for (const alias of aliasesFor(aliasSource)) {
          const existing = aliasToChannel.get(alias);
          const candidate = { feedIndex, channelId };
          if (!existing) aliasToChannel.set(alias, [candidate]);
          else if (!existing.some(e => e.feedIndex === feedIndex && e.channelId === channelId)) existing.push(candidate);
        }
      }
    }
  };
  feeds.forEach((feed, index) => ingestFeed(index, feed.result.channelDisplayNames));

  // For each Debridio channel, pick the best epg.pw match (preferring the
  // same-country feed) and record its current+next programme state under every
  // alias we could derive from its name/id/tvgId. Multiple alias writes let
  // the matcher resolve requests no matter which identifier Debridio passes.
  const states: Record<string, ChannelState> = {};
  const unmatched: MatchReport["unmatched"] = [];
  let matched = 0;
  let matchedWithCurrent = 0;
  let matchedWithOnlyNext = 0;
  let matchedWithNothing = 0;

  for (const ch of debridioChannels) {
    const sportsChannel = isSportsChannel(ch);
    const debAliases = debridioAliases({ id: ch.id, name: ch.name, tvgId: ch.tvgId });

    // Find the best match. Preference order: same-country first, then other.
    const preferredFeed: "ca" | "usa" = ch.country === "ca" ? "ca" : "usa";
    let best: FeedCandidate | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    const seenCandidates = new Set<string>();
    for (const a of debAliases) {
      const hits = aliasToChannel.get(a);
      if (!hits) continue;
      for (const hit of hits) {
        const dedupeKey = `${hit.feedIndex}:${hit.channelId}`;
        if (seenCandidates.has(dedupeKey)) continue;
        seenCandidates.add(dedupeKey);

        const feed = feeds[hit.feedIndex];
        const programmes = feed.result.programmesByChannel.get(hit.channelId);
        if (!programmes || programmes.length === 0) continue;
        if (!hasUsableProgrammeWindow(programmes, startMs)) continue;
        const kindPenalty =
          feed.kind === "sports"
            ? sportsChannel
              ? -10_000
              : 5_000
            : feed.kind === "fallback"
              ? 2_000
              : 0;
        const score =
          kindPenalty +
          (feed.countryHint === preferredFeed ? 0 : feed.countryHint ? 1 : 2) * 1000 +
          hit.feedIndex;
        if (score < bestScore) {
          best = hit;
          bestScore = score;
        }
      }
    }

    if (!best) {
      unmatched.push({
        id: ch.id,
        name: ch.name,
        tvgId: ch.tvgId,
        country: ch.country,
      });
      continue;
    }
    matched++;

    const feedResult = feeds[best.feedIndex].result;
    const programmes = feedResult.programmesByChannel.get(best.channelId) ?? [];

    // Reporting: snapshot current/next at refresh time for /__status coverage stats.
    const { current, next } = pickCurrentAndNext(programmes, startMs);
    if (current) matchedWithCurrent++;
    else if (next) matchedWithOnlyNext++;
    else matchedWithNothing++;

    // Storage: collect all programmes in the window so blurbFor() can compute
    // current/next accurately at any point during the refresh interval, not just
    // at the moment the cron ran.
    const windowStart = startMs - WINDOW_BACK_MS;
    const windowProgrammes = programmes
      .filter(p => p.stop.getTime() > windowStart && p.start.getTime() < windowEnd)
      .map(toProgram);

    const displayName =
      feedResult.channelDisplayNames.get(best.channelId)?.[0] ?? best.channelId;

    const state: ChannelState = {
      displayName,
      programmes: windowProgrammes,
    };
    // Primary key: the canonical Debridio id (e.g. "debtv:ca-tsn1").
    // This is what Debridio sends as `item.id` in catalog/meta responses, so
    // request-time lookup is a single O(1) map hit instead of scanning aliases.
    states[ch.id] = state;
  }

  const report: MatchReport = {
    refreshedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    sources: feeds.map(feed => feed.result.stats),
    debridioChannelCount: debridioChannels.length,
    matched,
    matchedWithCurrent,
    matchedWithOnlyNext,
    matchedWithNothing,
    unmatched,
    indexKeys: Object.keys(states).length,
  };

  console.log(
    `[buildBlob] refresh ok: ${matched}/${debridioChannels.length} matched ` +
      `(current=${matchedWithCurrent} nextOnly=${matchedWithOnlyNext} ` +
      `empty=${matchedWithNothing}), ${report.indexKeys} index keys, ` +
      `${report.durationMs}ms`
  );
  for (const feed of feeds) {
    if (feed.result.stats.completenessErrors.length > 0) {
      console.warn(
        `[buildBlob] ${feed.result.stats.name} completeness issues:`,
        feed.result.stats.completenessErrors
      );
    }
  }

  return { report, states };
}

// Cloudflare KV-backed wrapper. Only usable when running inside a Worker that
// has a CHANNEL_STATE binding. On free-tier Workers the underlying buildBlob()
// call will exceed the 10ms CPU budget on the US feed — that's why production
// runs buildBlob from a GitHub Action (see scripts/refresh-kv.ts) which then
// uses Cloudflare's REST API to set this same key.
export async function refreshAllToKV(ns: KVNamespace): Promise<void> {
  const blob = await buildBlob();
  await ns.put(KV_STATE_KEY, JSON.stringify(blob));
}

// Request-path helpers. loadBlob returns the whole CachedBlob (report+states)
// for /__status. loadAllStates strips it down to just the lookup map for the
// hot rewrite path.
export async function loadBlob(ns: KVNamespace): Promise<CachedBlob | undefined> {
  const raw = await ns.get(KV_STATE_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as CachedBlob;
  } catch (err) {
    console.error("[kvcache] failed to parse stored blob:", (err as Error).message);
    return undefined;
  }
}

export async function loadAllStates(
  ns: KVNamespace
): Promise<Record<string, ChannelState>> {
  const blob = await loadBlob(ns);
  return blob?.states ?? {};
}
