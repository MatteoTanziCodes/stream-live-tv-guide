import { CHANNELS } from "./channels";
import { Channel, ChannelState } from "./types";

// "TSN 1" / "TSN-1" / "TSN1" / "debtv:ca-tsn1" → "tsn1"
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Strip common id prefixes like "debtv:ca-" to isolate the channel slug.
function slugOfId(id: string): string {
  const afterColon = id.split(":").pop() ?? id;
  const afterDash = afterColon.includes("-") ? afterColon.split("-").slice(1).join("-") : afterColon;
  return normalize(afterDash);
}

// Strip country suffix from tvgId (e.g. "TSN 1.ca" → "TSN 1").
function bareTvg(tvg: string): string {
  return tvg.replace(/\.[a-z]+$/i, "");
}

const INDEX = new Map<string, Channel>();
for (const c of CHANNELS) INDEX.set(normalize(c.name), c);

export interface ItemLike {
  id?: string;
  name?: string;
  tvgId?: string;
}

function stateFor(states: ChannelState[], channelId: string): ChannelState | undefined {
  return states.find(s => s.channel.id === channelId);
}

// States are passed in rather than imported so the matcher stays pure and easy to test.
// Order of match attempts: name → id-slug → tvgId.
export function findChannelForItem(
  item: ItemLike,
  states: ChannelState[]
): ChannelState | undefined {
  if (item.name) {
    const c = INDEX.get(normalize(item.name));
    if (c) return stateFor(states, c.id);
  }
  if (item.id) {
    const c = INDEX.get(slugOfId(item.id));
    if (c) return stateFor(states, c.id);
  }
  if (item.tvgId) {
    const c = INDEX.get(normalize(bareTvg(item.tvgId)));
    if (c) return stateFor(states, c.id);
  }
  return undefined;
}

// Build a Stremio-facing description blurb from a channel's current / next programs.
// Falls back to "Up next:" when nothing is currently airing.
export function blurbFor(state: ChannelState | undefined): string | undefined {
  if (!state) return undefined;
  const cur = state.current;
  const nxt = state.next;
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
