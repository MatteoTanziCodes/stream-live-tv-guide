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
import { fetchAndParseXmltv, ParsedProgramme } from "./epgpw";
import { aliasesFor, debridioAliases } from "./matcher";
import { CachedBlob, ChannelState, MatchReport, Program } from "./types";

// v2: format changed from `Record<id, StoredState>` (tvpassport era) to
// `{ report, states }` (epg.pw era). Bumping the key forces a clean slate
// rather than silently mis-parsing a legacy blob on the first deploy.
export const KV_STATE_KEY = "states:v2";

const EPG_URLS = {
  ca: "https://epg.pw/xmltv/epg_CA.xml",
  usa: "https://epg.pw/xmltv/epg_US.xml",
} as const;

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
export async function buildBlob(): Promise<CachedBlob> {
  const startMs = Date.now();

  const ca = await fetchAndParseXmltv(EPG_URLS.ca, "epg.pw CA");
  const us = await fetchAndParseXmltv(EPG_URLS.usa, "epg.pw US");

  // Build the alias → (feed, channelId) lookup table from both feeds.
  // First write wins, so CA's entries take precedence for any shared channel
  // name. We iterate CA first because it's smaller and easier to sanity-check.
  const aliasToChannel = new Map<string, { feed: "ca" | "usa"; channelId: string }>();
  const ingestFeed = (
    feed: "ca" | "usa",
    channelDisplayNames: Map<string, string[]>
  ) => {
    for (const [channelId, names] of channelDisplayNames) {
      for (const name of names) {
        for (const alias of aliasesFor(name)) {
          if (!aliasToChannel.has(alias)) {
            aliasToChannel.set(alias, { feed, channelId });
          }
        }
      }
    }
  };
  ingestFeed("ca", ca.channelDisplayNames);
  ingestFeed("usa", us.channelDisplayNames);

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

  for (const ch of DEBRIDIO_CHANNELS) {
    const debAliases = debridioAliases({ id: ch.id, name: ch.name, tvgId: ch.tvgId });

    // Find the best match. Preference order: same-country first, then other.
    const preferredFeed: "ca" | "usa" = ch.country === "ca" ? "ca" : "usa";
    let best: { feed: "ca" | "usa"; channelId: string } | undefined;
    for (const a of debAliases) {
      const hit = aliasToChannel.get(a);
      if (!hit) continue;
      if (hit.feed === preferredFeed) {
        best = hit;
        break;
      }
      if (!best) best = hit; // remember non-preferred match but keep looking
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

    const feedResult = best.feed === "ca" ? ca : us;
    const programmes = feedResult.programmesByChannel.get(best.channelId) ?? [];
    const { current, next } = pickCurrentAndNext(programmes, startMs);
    if (current) matchedWithCurrent++;
    else if (next) matchedWithOnlyNext++;
    else matchedWithNothing++;

    const displayName =
      feedResult.channelDisplayNames.get(best.channelId)?.[0] ?? best.channelId;

    const state: ChannelState = {
      displayName,
      current: current ? toProgram(current) : undefined,
      next: next ? toProgram(next) : undefined,
    };
    for (const a of debAliases) {
      states[a] = state;
    }
  }

  const report: MatchReport = {
    refreshedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    sources: [ca.stats, us.stats],
    debridioChannelCount: DEBRIDIO_CHANNELS.length,
    matched,
    matchedWithCurrent,
    matchedWithOnlyNext,
    matchedWithNothing,
    unmatched,
    indexKeys: Object.keys(states).length,
  };

  console.log(
    `[buildBlob] refresh ok: ${matched}/${DEBRIDIO_CHANNELS.length} matched ` +
      `(current=${matchedWithCurrent} nextOnly=${matchedWithOnlyNext} ` +
      `empty=${matchedWithNothing}), ${report.indexKeys} index keys, ` +
      `${report.durationMs}ms`
  );
  if (ca.stats.completenessErrors.length) {
    console.warn("[buildBlob] CA completeness issues:", ca.stats.completenessErrors);
  }
  if (us.stats.completenessErrors.length) {
    console.warn("[buildBlob] US completeness issues:", us.stats.completenessErrors);
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
