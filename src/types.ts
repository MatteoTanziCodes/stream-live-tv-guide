// A channel we try to enrich, as advertised by Debridio. The `id`, `name`, `tvgId`
// match what Debridio returns in its catalog. Used both as an input list and as
// the baseline to measure coverage against.
export interface DebridioChannel {
  id: string; // e.g. "debtv:ca-tsn1"
  name: string; // e.g. "TSN 1"
  tvgId: string; // e.g. "TSN 1.ca"
  country: "ca" | "usa";
}

// One programme (TV listing). Stored in KV as ISO strings, revived to Date on use.
export interface Program {
  title: string;
  description?: string;
  start: string; // ISO 8601
  stop: string; // ISO 8601
}

// Current + next for a single matched channel.
export interface ChannelState {
  displayName: string; // original epg.pw display name (for debugging)
  current?: Program;
  next?: Program;
}

// Per-source stats — captured during every scheduled refresh so we can prove the
// XMLTV fetch was complete and the parse didn't silently drop data.
export interface SourceStats {
  name: "epg.pw CA" | "epg.pw US";
  url: string;
  fetchedAt: string;
  httpStatus: number;
  bytes: number;
  lastModified?: string;
  channelsFound: number;
  programmesFound: number;
  channelsWithoutDisplayName: number;
  programmesWithUnparseableTime: number;
  programmesWithoutChannel: number;
  programmesWithoutTitle: number;
  completenessErrors: string[]; // non-fatal issues that should be surfaced
}

// Coverage report — captured every refresh, surfaced via /__status.
// Existence of this in KV means the refresh completed; missing = nothing ran yet.
export interface MatchReport {
  refreshedAt: string;
  durationMs: number;
  sources: SourceStats[];
  debridioChannelCount: number;
  matched: number;
  matchedWithCurrent: number;
  matchedWithOnlyNext: number;
  matchedWithNothing: number;
  unmatched: Array<{ id: string; name: string; tvgId: string; country: string }>;
  indexKeys: number;
}

// What we actually store in KV. `states` is keyed by a normalized lookup key —
// multiple keys may point at the same epg.pw channel (alias support).
export interface CachedBlob {
  report: MatchReport;
  states: Record<string, ChannelState>;
}
