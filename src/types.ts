// Minimal channel definition — what we need to scrape tvpassport and match against Debridio items.
export interface Channel {
  id: string;
  name: string;
  tvpassportId: string;
  logo?: string;
  genre?: string;
  country?: string;
}

// A single program in a schedule.
// Dates are serialized to ISO strings in KV — revive with new Date() on read.
export interface Program {
  title: string;
  description?: string;
  start: Date;
  stop: Date;
}

// Current state for one channel: what's on now, what's on next.
// Stored in KV as JSON; Date fields become strings and must be revived on load.
export interface ChannelState {
  channel: Channel;
  current?: Program;
  next?: Program;
  refreshedAt: number;
}
