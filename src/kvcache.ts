import { CHANNELS } from "./channels";
import { fetchCurrentAndNext } from "./tvpassport";
import { ChannelState, Program } from "./types";

// Single KV key holding a {channelId: ChannelState} map. Using one blob (~1-2KB total
// for 5 channels) keeps reads to 1 per request instead of 5.
const KEY = "states:v1";

// tvpassport.com timezone for parsing listing times. TSN is Toronto-based.
const TZ = "America/Toronto";

interface StoredState {
  channel: ChannelState["channel"];
  current?: SerializedProgram;
  next?: SerializedProgram;
  refreshedAt: number;
}
interface SerializedProgram {
  title: string;
  description?: string;
  start: string; // ISO
  stop: string; // ISO
}

function serializeProgram(p: Program | undefined): SerializedProgram | undefined {
  if (!p) return undefined;
  return {
    title: p.title,
    description: p.description,
    start: p.start.toISOString(),
    stop: p.stop.toISOString(),
  };
}

function deserializeProgram(p: SerializedProgram | undefined): Program | undefined {
  if (!p) return undefined;
  return {
    title: p.title,
    description: p.description,
    start: new Date(p.start),
    stop: new Date(p.stop),
  };
}

// Scrape all channels, write the combined blob to KV. Called by the scheduled handler.
export async function refreshAllToKV(ns: KVNamespace): Promise<void> {
  const now = new Date();
  const stored: Record<string, StoredState> = {};

  // Sequential to be kind to tvpassport (5 requests over ~a few seconds).
  for (const ch of CHANNELS) {
    try {
      const { current, next } = await fetchCurrentAndNext(ch.tvpassportId, now, TZ);
      stored[ch.id] = {
        channel: ch,
        current: serializeProgram(current),
        next: serializeProgram(next),
        refreshedAt: Date.now(),
      };
      const parts: string[] = [];
      if (current) parts.push(`now: ${current.title}`);
      if (next) parts.push(`next: ${next.title}`);
      console.log(`[kvcache] ${ch.name}: ${parts.length ? parts.join(", ") : "(no listings)"}`);
    } catch (err) {
      console.error(`[kvcache] ${ch.name} refresh failed:`, (err as Error).message);
    }
  }

  await ns.put(KEY, JSON.stringify(stored));
  console.log(`[kvcache] wrote ${Object.keys(stored).length} channel states to KV`);
}

// Read all channel states from KV for the matcher to consume. Returns [] if KV is empty
// (fresh deploy, before first cron) — in that case we gracefully pass responses through.
export async function loadAllStates(ns: KVNamespace): Promise<ChannelState[]> {
  const raw = await ns.get(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Record<string, StoredState>;
    return Object.values(parsed).map(s => ({
      channel: s.channel,
      current: deserializeProgram(s.current),
      next: deserializeProgram(s.next),
      refreshedAt: s.refreshedAt,
    }));
  } catch (err) {
    console.error(`[kvcache] failed to parse stored states:`, (err as Error).message);
    return [];
  }
}
