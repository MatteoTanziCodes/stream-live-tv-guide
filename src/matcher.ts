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

const RESOLUTION_RE = /\b(?:HD|SD|UHD|FHD|4K)\b/gi;
const DIRECTION_RE = /\b(?:East|West|Eastern|Western|North|South|Central|Pacific|Mountain|National)\b/gi;
const MEDIUM_RE = /\b(?:Channel|Network|Television|TV|Stream|Feed)\b/gi;

function addVariant(set: Set<string>, value: string): void {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed) set.add(trimmed);
}

function extractDelimited(raw: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const match of raw.matchAll(re)) {
    const inner = match[1]?.trim();
    if (inner) out.push(inner);
  }
  return out;
}

function addSynonymVariants(set: Set<string>, raw: string): void {
  const pairs: Array<[RegExp, string]> = [
    [/\bHGTV\b/gi, "Home and Garden Television"],
    [/\bHome\s+(?:&|and)\s+Garden(?:\s+Television)?\b/gi, "HGTV"],
    [/\bID\b/gi, "Investigation Discovery"],
    [/\bInvestigation Discovery\b/gi, "ID"],
    [/\bNat(?:ional)?\s+Geo(?:graphic)?\s+Wild\b/gi, "National Geographic Wild"],
    [/\bNational Geographic Wild\b/gi, "Nat Geo Wild"],
    [/\bOWN\b/gi, "Oprah Winfrey Network"],
    [/\bOprah Winfrey Network\b/gi, "OWN"],
    [/\bFX Movie\b/gi, "FXM"],
    [/\bFXM\b/gi, "FX Movie"],
    [/\bEPIX\b/gi, "MGM Plus"],
    [/\bMGM\s*\+\b/gi, "EPIX"],
    [/\bViceland\b/gi, "Vice"],
    [/\bVice\b/gi, "Viceland"],
    [/\bTVG\b/gi, "FanDuel TV"],
    [/\bFanDuel TV\b/gi, "TVG"],
    [/\bLifetime Movies\b/gi, "Lifetime Movie Network"],
    [/\bLifetime Movie Network\b/gi, "Lifetime Movies"],
    [/\bHallmark Movies\s+(?:&|and)\s+Mysteries\b/gi, "Hallmark Mystery"],
    [/\bHallmark Mystery\b/gi, "Hallmark Movies and Mysteries"],
    [/\bBBC World News\b/gi, "BBC News"],
    [/\bBBC News\b/gi, "BBC World News"],
    [/\bABC News\b/gi, "ABC News Live"],
    [/\bABC News Live\b/gi, "ABC News"],
    [/\bGame\+\b/gi, "Game Plus"],
    [/\bGame Plus\b/gi, "Game+"],
    [/\bESPN The Ocho\b/gi, "TSN The Ocho"],
    [/\bTSN The Ocho\b/gi, "ESPN The Ocho"],
    [/\bSNY\b/gi, "SportsNet New York"],
    [/\bSportsNet New York\b/gi, "SNY"],
    [/\bCinemax MoreMax\b/gi, "More MAX"],
    [/\bMore\s+MAX\b/gi, "Cinemax MoreMax"],
    [/\bCinemax Thriller\s*Max\b/gi, "ThrillerMAX"],
    [/\bThriller\s*MAX\b/gi, "Cinemax Thriller Max"],
    [/\bEPIX 2\b/gi, "MGM+ Marquee"],
    [/\bMGM\+\s*Marquee\b/gi, "EPIX 2"],
    [/\bEPIX Hits\b/gi, "MGM+ Hits"],
    [/\bMGM\+\s*Hits\b/gi, "EPIX Hits"],
    [/\bEPIX Drive-?In\b/gi, "MGM+ Drive-In"],
    [/\bMGM\+\s*Drive-?In\b/gi, "EPIX Drive-In"],
  ];

  for (const [re, replacement] of pairs) {
    re.lastIndex = 0;
    if (re.test(raw)) addVariant(set, raw.replace(re, replacement));
  }
}

// Generate plausible spelling variants of a name, before normalization.
// Each variant feeds into `normalize()` to form an alias. The goal is for
// "Disney Jr." (Debridio) and "Disney Junior" (epg.pw) to share at least one
// normalized key — we don't need them to be equal, just to intersect.
function variantsOf(raw: string): string[] {
  const v = new Set<string>([raw]);

  // Pull out the text inside delimiters as standalone aliases:
  // "Cable Pulse 24 (CP24) HD" -> "CP24", "[CPAC] ..." -> "CPAC".
  for (const inner of extractDelimited(raw, /\(([^)]+)\)/g)) addVariant(v, inner);
  for (const inner of extractDelimited(raw, /\[([^\]]+)\]/g)) addVariant(v, inner);

  // Drop parenthesised qualifiers: "Sportsnet (East)" → "Sportsnet".
  const noParens = raw.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  addVariant(v, noParens);

  // Drop bracketed qualifiers: "[CPAC] Cable Public Affairs Channel HD" → "Cable Public Affairs Channel HD".
  const noBrackets = raw.replace(/\s*\[[^\]]*\]\s*/g, " ").trim();
  addVariant(v, noBrackets);

  // Drop resolution markers: "ABC HD" → "ABC".
  const noRes = raw.replace(RESOLUTION_RE, "").trim();
  addVariant(v, noRes);
  addVariant(v, noParens.replace(RESOLUTION_RE, "").trim());
  addVariant(v, noBrackets.replace(RESOLUTION_RE, "").trim());

  // Drop directional qualifiers: "Fox East" → "Fox", "ABC West" → "ABC".
  // Feeds often append East/West for time-zone variants of the same network.
  const noDir = raw.replace(DIRECTION_RE, "").trim();
  addVariant(v, noDir);
  addVariant(v, noDir.replace(RESOLUTION_RE, "").trim());

  // Drop generic medium words: "Fox News Channel" → "Fox News",
  // "USA Network" → "USA", "CBC Television" → "CBC".
  const noMedium = raw.replace(MEDIUM_RE, "").trim();
  addVariant(v, noMedium);
  addVariant(v, noMedium.replace(DIRECTION_RE, "").trim());
  addVariant(v, noMedium.replace(RESOLUTION_RE, "").trim());
  addVariant(v, noMedium.replace(DIRECTION_RE, "").replace(RESOLUTION_RE, "").trim());
  addVariant(v, raw.replace(DIRECTION_RE, "").replace(MEDIUM_RE, "").replace(RESOLUTION_RE, "").trim());

  // Drop leading "The": "The CW" → "CW".
  addVariant(v, raw.replace(/^The\s+/i, "").trim());

  // Bidirectional Jr <-> Junior — different feeds prefer different forms.
  addVariant(v, raw.replace(/\bJr\.?\b/gi, "Junior"));
  addVariant(v, raw.replace(/\bJunior\b/gi, "Jr"));

  addSynonymVariants(v, raw);
  for (const cur of [...v]) addSynonymVariants(v, cur);

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
