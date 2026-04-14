import { DateTime } from "luxon";
import { Program } from "./types";

// tvpassport.com serves a stripped page to identifiable bot UAs, so we pose as Chrome.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_TZ = "America/Toronto";

// Each listing on tvpassport is rendered as:
//   <div id="itemheader1" ...data-st="2026-04-14 05:30:00" data-duration="60"
//     data-showName="SportsCentre" data-description="..." ...>
const DIV_RE = /<div id="itemheader\d+"([^>]*?)>/g;

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
}

function getAttr(block: string, name: string): string | undefined {
  const m = new RegExp(`data-${name}="([^"]*)"`, "i").exec(block);
  return m ? decodeHtml(m[1]) : undefined;
}

function parseListings(html: string, zone: string): Program[] {
  const listings: Program[] = [];
  DIV_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIV_RE.exec(html)) !== null) {
    const attrs = m[1];
    const st = getAttr(attrs, "st");
    const title = getAttr(attrs, "showName");
    if (!st || !title) continue;
    const dt = DateTime.fromFormat(st, "yyyy-MM-dd HH:mm:ss", { zone });
    if (!dt.isValid) continue;
    const minutes = Number(getAttr(attrs, "duration")) || 30;
    const description = getAttr(attrs, "description");
    listings.push({
      title,
      description: description || undefined,
      start: dt.toJSDate(),
      stop: new Date(dt.toJSDate().getTime() + minutes * 60_000),
    });
  }
  listings.sort((a, b) => a.start.getTime() - b.start.getTime());
  return listings;
}

export async function fetchCurrentAndNext(
  tvpassportId: string,
  now: Date = new Date(),
  zone: string = DEFAULT_TZ
): Promise<{ current?: Program; next?: Program }> {
  const url = `https://www.tvpassport.com/tv-listings/stations/${tvpassportId}`;
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`tvpassport fetch failed (${res.status}): ${url}`);
  const html = await res.text();
  const listings = parseListings(html, zone);
  // Walk forward; return the first listing we haven't finished yet.
  // If one straddles `now`, it's current. If all are future, return the first as next.
  for (let i = 0; i < listings.length; i++) {
    const l = listings[i];
    if (l.start <= now && now < l.stop) return { current: l, next: listings[i + 1] };
    if (l.start > now) return { next: l };
  }
  return {};
}
