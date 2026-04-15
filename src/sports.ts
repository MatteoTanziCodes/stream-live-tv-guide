import { DebridioChannel } from "./types";

const SPORTS_NAME_RE =
  /\b(?:acc|altitude|baseball|basketball|bein|big\s*ten|boxing|cbs\s*sports|cricket|espn|fan\s*duel|fanduel|fight|football|fox\s*sports|game\+|golf|hockey|marquee|mlb|mma|motorsport|msg|nba|nbc\s*sports|nesn|nfl|nhl|outdoor|rac(?:e|ing)|redzone|rugby|sec|soccer|sports|sportsnet|spectrum\s*sportsnet|sny|tennis|the\s*ocho|tsn|tudn|tvg|ufc|willow|world\s*fishing|wwe|yes\s*network)\b/i;
const SPORTS_GENRE_RE = /\bsports?\b/i;

export function isSportsChannel(
  channel: Pick<DebridioChannel, "id" | "name" | "tvgId" | "genres">
): boolean {
  const genres = channel.genres ?? [];
  if (genres.some(genre => SPORTS_GENRE_RE.test(genre))) return true;
  return [channel.name, channel.tvgId, channel.id].some(value =>
    value ? SPORTS_NAME_RE.test(value) : false
  );
}
