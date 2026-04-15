// Fetches an XMLTV feed from epg.pw and extracts channels + programmes using a
// streaming parser. The large-feed case (US is ~30MB+ decoded) blows past the
// Cloudflare free tier's 128MB memory limit if we hold the full body + regex
// iterator state simultaneously, so we read the response as chunks, append to
// a buffer, and splice out each `<channel>...</channel>` / `<programme>...
// </programme>` element as soon as it arrives. Buffer size stays bounded by
// the largest single element (a few KB), not the whole body.
//
// Every failure mode is tracked in the returned SourceStats so /__status can
// surface completeness issues even when the refresh "succeeded". We deliberately
// do NOT throw on soft failures — a partial feed is more useful than no feed.

import { SourceStats } from "./types";

export interface ParsedProgramme {
  start: Date;
  stop: Date;
  title: string;
  description?: string;
}

export interface XmltvResult {
  stats: SourceStats;
  // epg.pw channel id → all display-names from its <channel> block. Multiple
  // names are common ("TSN 1", "TSN One", "The Sports Network 1") and the
  // matcher uses every one of them as a possible alias key.
  channelDisplayNames: Map<string, string[]>;
  // epg.pw channel id → programmes, pre-sorted by start ASC.
  programmesByChannel: Map<string, ParsedProgramme[]>;
}

export type EpgpwResult = XmltvResult;

export interface XmltvParseOptions {
  minBytes?: number;
  minChannels?: number;
  minProgrammes?: number;
}

// XMLTV time format: "20260414120000 -0500" → Date
// Returns null for unparseable input; caller tallies the failure in stats.
function parseXmltvTime(s: string): Date | null {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?$/);
  if (!m) return null;
  const [, yy, mo, da, hr, mi, se, tz] = m;
  const tzIso = tz ? `${tz.slice(0, 3)}:${tz.slice(3, 5)}` : "Z";
  const iso = `${yy}-${mo}-${da}T${hr}:${mi}:${se}${tzIso}`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

// Minimal XML entity decoder — XMLTV uses standard named entities plus numeric.
// `&amp;` must be last to avoid double-decoding (e.g. "&amp;lt;" → "&lt;" not "<").
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, "&");
}

// Pull a single attribute value from a tag's attribute fragment. XMLTV attrs
// can appear in any order, so we can't rely on positional regex capture.
function extractAttr(tagFragment: string, attr: string): string | null {
  const regex = new RegExp(`\\b${attr}="([^"]*)"`);
  const match = tagFragment.match(regex);
  return match ? match[1] : null;
}

// Find the inner text of the first `<tag ...>...</tag>` element inside `inner`.
// Returns null if either the open or close tag isn't found.
function firstChildText(inner: string, tag: string): string | null {
  const openIdx = inner.indexOf(`<${tag}`);
  if (openIdx < 0) return null;
  const openEnd = inner.indexOf(">", openIdx);
  if (openEnd < 0) return null;
  const close = inner.indexOf(`</${tag}>`, openEnd + 1);
  if (close < 0) return null;
  return inner.slice(openEnd + 1, close);
}

// Process a single `<channel ...>...</channel>` block.
function processChannel(
  block: string,
  stats: SourceStats,
  channelDisplayNames: Map<string, string[]>
): void {
  stats.channelsFound++;
  const tagEnd = block.indexOf(">");
  if (tagEnd < 0) return;
  const attrs = block.slice("<channel".length, tagEnd);
  const inner = block.slice(tagEnd + 1, block.lastIndexOf("</channel>"));
  const id = extractAttr(attrs, "id");
  if (!id) {
    stats.channelsWithoutDisplayName++;
    return;
  }
  // Collect every <display-name>. Each feed may include multiple languages
  // or aliases; all of them feed the matcher's alias set.
  const names: string[] = [];
  let scan = 0;
  while (true) {
    const dStart = inner.indexOf("<display-name", scan);
    if (dStart < 0) break;
    const dOpenEnd = inner.indexOf(">", dStart);
    if (dOpenEnd < 0) break;
    const dClose = inner.indexOf("</display-name>", dOpenEnd + 1);
    if (dClose < 0) break;
    const text = inner.slice(dOpenEnd + 1, dClose);
    const decoded = decodeEntities(text).trim();
    if (decoded) names.push(decoded);
    scan = dClose + "</display-name>".length;
  }
  if (names.length === 0) {
    stats.channelsWithoutDisplayName++;
    return;
  }
  // Some XMLTV feeds repeat the same name. Dedupe.
  channelDisplayNames.set(id, [...new Set(names)]);
}

// Process a single `<programme ...>...</programme>` block.
function processProgramme(
  block: string,
  stats: SourceStats,
  programmesByChannel: Map<string, ParsedProgramme[]>
): void {
  stats.programmesFound++;
  const tagEnd = block.indexOf(">");
  if (tagEnd < 0) return;
  const attrs = block.slice("<programme".length, tagEnd);
  const inner = block.slice(tagEnd + 1, block.lastIndexOf("</programme>"));
  const channelId = extractAttr(attrs, "channel");
  if (!channelId) {
    stats.programmesWithoutChannel++;
    return;
  }
  const startStr = extractAttr(attrs, "start");
  const stopStr = extractAttr(attrs, "stop");
  const start = startStr ? parseXmltvTime(startStr) : null;
  const stop = stopStr ? parseXmltvTime(stopStr) : null;
  if (!start || !stop) {
    stats.programmesWithUnparseableTime++;
    return;
  }
  const titleRaw = firstChildText(inner, "title");
  if (!titleRaw) {
    stats.programmesWithoutTitle++;
    return;
  }
  const title = decodeEntities(titleRaw).trim();
  if (!title) {
    stats.programmesWithoutTitle++;
    return;
  }
  const descRaw = firstChildText(inner, "desc");
  const descText = descRaw ? decodeEntities(descRaw).trim() : "";
  const description = descText.length > 0 ? descText : undefined;

  const p: ParsedProgramme = { start, stop, title, description };
  const list = programmesByChannel.get(channelId);
  if (list) list.push(p);
  else programmesByChannel.set(channelId, [p]);
}

// Streaming parse loop: scan `buffer` for complete elements starting at cursor
// and process each one. Returns the index up to which the buffer was consumed
// (caller slices the buffer to [consumed..] for the next iteration).
function drainBuffer(
  buffer: string,
  stats: SourceStats,
  channelDisplayNames: Map<string, string[]>,
  programmesByChannel: Map<string, ParsedProgramme[]>
): number {
  let cursor = 0;
  while (true) {
    // Find the next element-start. Channels come before programmes in XMLTV,
    // but we scan for both every iteration — cheaper than maintaining a phase
    // flag and handles interleaved feeds.
    const chStart = buffer.indexOf("<channel ", cursor);
    const prStart = buffer.indexOf("<programme ", cursor);

    if (chStart < 0 && prStart < 0) return cursor;
    const useChannel =
      chStart >= 0 && (prStart < 0 || chStart < prStart);
    const elStart = useChannel ? chStart : prStart;
    const closeTag = useChannel ? "</channel>" : "</programme>";
    const elEnd = buffer.indexOf(closeTag, elStart);
    if (elEnd < 0) {
      // Element isn't complete in this buffer yet. Keep the partial tail.
      return cursor;
    }
    const block = buffer.slice(elStart, elEnd + closeTag.length);
    if (useChannel) {
      processChannel(block, stats, channelDisplayNames);
    } else {
      processProgramme(block, stats, programmesByChannel);
    }
    cursor = elEnd + closeTag.length;
  }
}

export async function fetchAndParseXmltv(
  url: string,
  sourceName: SourceStats["name"],
  options: XmltvParseOptions = {}
): Promise<XmltvResult> {
  const stats: SourceStats = {
    name: sourceName,
    url,
    fetchedAt: new Date().toISOString(),
    httpStatus: 0,
    bytes: 0,
    channelsFound: 0,
    programmesFound: 0,
    channelsWithoutDisplayName: 0,
    programmesWithUnparseableTime: 0,
    programmesWithoutChannel: 0,
    programmesWithoutTitle: 0,
    completenessErrors: [],
  };
  const channelDisplayNames = new Map<string, string[]>();
  const programmesByChannel = new Map<string, ParsedProgramme[]>();

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": "stream-live-tv-guide" },
    });
  } catch (err) {
    stats.completenessErrors.push(`fetch failed: ${(err as Error).message}`);
    return { stats, channelDisplayNames, programmesByChannel };
  }
  stats.httpStatus = res.status;
  if (!res.ok) {
    stats.completenessErrors.push(`HTTP ${res.status} ${res.statusText}`);
    return { stats, channelDisplayNames, programmesByChannel };
  }
  if (!res.body) {
    stats.completenessErrors.push("response body missing (no stream reader)");
    return { stats, channelDisplayNames, programmesByChannel };
  }
  const lm = res.headers.get("last-modified");
  if (lm) stats.lastModified = lm;

  // Stream-decode chunks into a rolling buffer. We decode progressively so
  // multi-byte UTF-8 codepoints split across chunk boundaries are handled
  // correctly (TextDecoder with stream:true buffers the incomplete tail).
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let sawOpenRoot = false;
  let sawCloseRoot = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stats.bytes += value.byteLength;
      // Drop any XML comments that arrived in this chunk before they get
      // spliced across buffer boundaries — comments can contain `<channel`
      // stubs that would otherwise poison the parser.
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/<!--[\s\S]*?-->/g, "");
      if (!sawOpenRoot && buffer.includes("<tv")) sawOpenRoot = true;
      const consumed = drainBuffer(
        buffer,
        stats,
        channelDisplayNames,
        programmesByChannel
      );
      if (consumed > 0) buffer = buffer.slice(consumed);
      // Safety: if buffer grows wildly (some malformed element), flush it to
      // prevent runaway memory use. Real elements are always a few KB.
      if (buffer.length > 5_000_000) {
        stats.completenessErrors.push(
          `buffer exceeded 5MB without a complete element — parser may be stuck`
        );
        buffer = "";
      }
    }
  } catch (err) {
    stats.completenessErrors.push(`stream read failed: ${(err as Error).message}`);
  }
  // Flush any final bytes the decoder was holding.
  buffer += decoder.decode();
  buffer = buffer.replace(/<!--[\s\S]*?-->/g, "");
  drainBuffer(buffer, stats, channelDisplayNames, programmesByChannel);
  if (buffer.includes("</tv>")) sawCloseRoot = true;

  finalizeStats(stats, channelDisplayNames, programmesByChannel, {
    minBytes: options.minBytes ?? 500_000,
    minChannels: options.minChannels ?? 50,
    minProgrammes: options.minProgrammes ?? 1000,
    sawOpenRoot,
    sawCloseRoot,
  });

  return { stats, channelDisplayNames, programmesByChannel };
}

function finalizeStats(
  stats: SourceStats,
  channelDisplayNames: Map<string, string[]>,
  programmesByChannel: Map<string, ParsedProgramme[]>,
  opts: Required<XmltvParseOptions> & { sawOpenRoot: boolean; sawCloseRoot: boolean }
): void {
  const { minBytes, minChannels, minProgrammes, sawOpenRoot, sawCloseRoot } = opts;

  // Completeness gate 1: body must be non-trivially sized. epg.pw country feeds
  // are typically 5-30MB; anything <500KB is almost certainly truncated or wrong.
  if (stats.bytes < minBytes) {
    stats.completenessErrors.push(
      `response body unexpectedly small (${stats.bytes} bytes; expected >=${minBytes}B)`
    );
  }
  // Completeness gate 2: must actually be XMLTV.
  if (!sawOpenRoot) {
    stats.completenessErrors.push("response missing <tv root element — not XMLTV");
  }
  // Completeness gate 3: must end with </tv>, otherwise the upstream cut us off
  // mid-stream and we'd be silently missing the tail of the programmes list.
  if (!sawCloseRoot) {
    stats.completenessErrors.push("stream did not include </tv> — likely truncated mid-stream");
  }

  // Sort each channel's programme list by start ASC so pickCurrentAndNext can
  // early-exit on the first programme whose start > now.
  for (const list of programmesByChannel.values()) {
    list.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  // Completeness gate 4: sanity-check volumes. Real CA/US feeds have 500+
  // channels and tens of thousands of programmes. If we're far below that,
  // either the parse broke or the upstream gave us a shell file.
  if (stats.channelsFound < minChannels) {
    stats.completenessErrors.push(
      `channelsFound=${stats.channelsFound} is unexpectedly low (expected >=${minChannels})`
    );
  }
  if (stats.programmesFound < minProgrammes) {
    stats.completenessErrors.push(
      `programmesFound=${stats.programmesFound} is unexpectedly low (expected >=${minProgrammes})`
    );
  }
  // Completeness gate 5: flag if a big chunk of programmes silently dropped.
  const dropRate =
    stats.programmesFound === 0
      ? 0
      : (stats.programmesWithUnparseableTime +
          stats.programmesWithoutChannel +
          stats.programmesWithoutTitle) /
        stats.programmesFound;
  if (dropRate > 0.05) {
    stats.completenessErrors.push(
      `${(dropRate * 100).toFixed(1)}% of programmes dropped during parse (>5% threshold)`
    );
  }
}

export function parseXmltvText(
  text: string,
  url: string,
  sourceName: SourceStats["name"],
  options: XmltvParseOptions = {}
): XmltvResult {
  const stats: SourceStats = {
    name: sourceName,
    url,
    fetchedAt: new Date().toISOString(),
    httpStatus: 200,
    bytes: new TextEncoder().encode(text).byteLength,
    channelsFound: 0,
    programmesFound: 0,
    channelsWithoutDisplayName: 0,
    programmesWithUnparseableTime: 0,
    programmesWithoutChannel: 0,
    programmesWithoutTitle: 0,
    completenessErrors: [],
  };
  const channelDisplayNames = new Map<string, string[]>();
  const programmesByChannel = new Map<string, ParsedProgramme[]>();
  const cleaned = text.replace(/<!--[\s\S]*?-->/g, "");
  const sawOpenRoot = cleaned.includes("<tv");
  const sawCloseRoot = cleaned.includes("</tv>");
  drainBuffer(cleaned, stats, channelDisplayNames, programmesByChannel);
  finalizeStats(stats, channelDisplayNames, programmesByChannel, {
    minBytes: options.minBytes ?? 1_000,
    minChannels: options.minChannels ?? 1,
    minProgrammes: options.minProgrammes ?? 1,
    sawOpenRoot,
    sawCloseRoot,
  });
  return { stats, channelDisplayNames, programmesByChannel };
}
