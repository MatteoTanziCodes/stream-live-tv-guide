// Request-time lookup + blurb construction.
//
// The design: every channel (both Debridio-side and epg.pw-side) produces a
// set of normalized "alias" keys. When we refresh KV, we write the same
// ChannelState under every alias we can derive from the Debridio channel's
// name/id/tvgId. At request time, we derive aliases from the incoming item the
// same way and look them up directly. This keeps the request path O(1) per
// alias and avoids running matching logic on the hot path.

import { ChannelState, Program } from "./types";

export interface ItemLike {
  id?: string;
  name?: string;
  tvgId?: string;
}

// Produce a single canonical lookup key from a raw name fragment.
// "TSN 1" / "TSN-1" / "tsn1" all collapse to "tsn1". "A&E" → "aande".
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

// Generate plausible spelling variants of a name, before normalization.
// Each variant feeds into `normalize()` to form an alias. The goal is for
// "Disney Jr." (Debridio) and "Disney Junior" (epg.pw) to share at least one
// normalized key — we don't need them to be equal, just to intersect.
function variantsOf(raw: string): string[] {
  const v = new Set<string>([raw]);

  // Drop parenthesised qualifiers: "Sportsnet (East)" → "Sportsnet".
  const noParens = raw.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  v.add(noParens);

  // Drop resolution markers: "ABC HD" → "ABC".
  const noRes = raw.replace(/\b(?:HD|SD|UHD|FHD|4K)\b/gi, "").trim();
  v.add(noRes);
  v.add(noParens.replace(/\b(?:HD|SD|UHD|FHD|4K)\b/gi, "").trim());

  // Drop directional qualifiers: "Fox East" → "Fox", "ABC West" → "ABC".
  // Feeds often append East/West for time-zone variants of the same network.
  const noDir = raw.replace(/\b(?:East|West|Eastern|Western|North|South)\b/gi, "").trim();
  v.add(noDir);
  v.add(noDir.replace(/\b(?:HD|SD|UHD|FHD|4K)\b/gi, "").trim());

  // Drop generic medium words: "Fox News Channel" → "Fox News",
  // "USA Network" → "USA", "CBC Television" → "CBC".
  const noMedium = raw.replace(/\b(?:Channel|Network|Television)\b/gi, "").trim();
  v.add(noMedium);
  v.add(noMedium.replace(/\b(?:East|West|Eastern|Western|North|South)\b/gi, "").trim());

  // Drop leading "The": "The CW" → "CW".
  v.add(raw.replace(/^The\s+/i, "").trim());

  // Bidirectional Jr <-> Junior — different feeds prefer different forms.
  v.add(raw.replace(/\bJr\.?\b/gi, "Junior"));
  v.add(raw.replace(/\bJunior\b/gi, "Jr"));

  return [...v].filter(s => s.length > 0);
}

// Full alias set for a single raw name. Used on BOTH sides of the match
// (Debridio-side when building the index, and epg.pw-side when ingesting
// display-names).
export function aliasesFor(raw: string): string[] {
  const keys = variantsOf(raw)
    .map(normalize)
    .filter(k => k.length > 0);
  return [...new Set(keys)];
}

// Produce aliases for a Debridio item, in priority order: most-specific first.
// Most-specific = includes country suffix or full id, so colliding channels
// between CA and USA (e.g. "Love Nature" exists in both) still resolve to the
// right state when the Debridio client passes us tvgId or id.
export function debridioAliases(item: ItemLike): string[] {
  const lists: string[][] = [];
  if (item.tvgId) {
    // Full tvgId like "Love Nature.ca" → "lovenatureca" (country-specific)
    lists.push(aliasesFor(item.tvgId));
    const bare = item.tvgId.replace(/\.[a-z]+$/i, "");
    if (bare !== item.tvgId) lists.push(aliasesFor(bare));
  }
  if (item.id) {
    // Full id like "debtv:usa-lovenature" → "debtvusalovenature"
    lists.push(aliasesFor(item.id));
    const afterColon = item.id.split(":").pop() ?? item.id;
    const afterDash = afterColon.includes("-")
      ? afterColon.split("-").slice(1).join("-")
      : afterColon;
    if (afterDash !== item.id) lists.push(aliasesFor(afterDash));
  }
  if (item.name) lists.push(aliasesFor(item.name));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const a of list) {
      if (!seen.has(a)) {
        seen.add(a);
        out.push(a);
      }
    }
  }
  return out;
}

// Look up the ChannelState for an incoming Debridio item.
// Primary path: exact match on item.id (the canonical Debridio id like
// "debtv:ca-tsn1"). O(1) map hit — covers ~100% of real Debridio responses.
// Fallback: alias scan for tvgId-only items or any future id format changes.
export function findChannelState(
  item: ItemLike,
  states: Record<string, ChannelState>
): ChannelState | undefined {
  if (item.id) {
    const direct = states[item.id];
    if (direct) return direct;
  }
  // Alias fallback: handles items that arrive without a canonical id.
  for (const a of debridioAliases(item)) {
    const s = states[a];
    if (s) return s;
  }
  return undefined;
}

// Build the Stremio-facing "Now: … • Next: …" blurb from a channel state.
// Scans the stored programme window at request time so the result always
// reflects the live clock — no stale snapshot from the last cron run.
export function blurbFor(state: ChannelState | undefined): string | undefined {
  if (!state?.programmes?.length) return undefined;
  const nowMs = Date.now();
  let cur: Program | undefined;
  let nxt: Program | undefined;

  // programmes[] is sorted ASC by start; early-exit once we pass now.
  for (const p of state.programmes) {
    const startMs = new Date(p.start).getTime();
    const stopMs  = new Date(p.stop).getTime();
    if (startMs <= nowMs && nowMs < stopMs) {
      cur = p;
    } else if (startMs > nowMs) {
      nxt = p;
      break;
    }
  }

  if (cur) {
    const curPart = cur.description
      ? `Now: ${cur.title} — ${cur.description}`
      : `Now: ${cur.title}`;
    return nxt ? `${curPart} • Next: ${nxt.title}` : curPart;
  }
  if (nxt) {
    return nxt.description
      ? `Up next: ${nxt.title} — ${nxt.description}`
      : `Up next: ${nxt.title}`;
  }
  return undefined;
}
