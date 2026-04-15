import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseXmltvText, XmltvResult } from "../src/epgpw";
import { aliasesFor, debridioAliases } from "../src/matcher";
import { isSportsChannel } from "../src/sports";
import { DebridioChannel } from "../src/types";

type UnmatchedChannel = {
  id: string;
  name: string;
  tvgId: string;
  country: string;
};

interface IptvOrgChannelDef {
  site: string;
  siteId: string;
  lang: string;
  xmltvId: string;
  name: string;
  sourcePath: string;
  sourceRank: number;
}

interface SelectedChannelDef extends IptvOrgChannelDef {
  outputXmltvId: string;
  outputName: string;
}

const REPO_DIR = path.join(os.tmpdir(), "iptv-org-epg");
const GENERATED_DIR = path.join(os.tmpdir(), "stream-live-tv-guide-iptv-org");
const GENERAL_SITE_FILES = [
  "sites/directv.com/directv.com.channels.xml",
  "sites/tvpassport.com/tvpassport.com.channels.xml",
  "sites/tvguide.com/tvguide.com.channels.xml",
  "sites/tvinsider.com/tvinsider.com.channels.xml",
  "sites/plex.tv/plex.tv_us.channels.xml",
  "sites/pluto.tv/pluto.tv_us.channels.xml",
  "sites/streamingtvguides.com/streamingtvguides.com.channels.xml",
  "sites/ontvtonight.com/ontvtonight.com_us.channels.xml",
  "sites/ontvtonight.com/ontvtonight.com_ca.channels.xml",
  "sites/tvhebdo.com/tvhebdo.com.channels.xml",
  "sites/tvtv.us/tvtv.us.channels.xml",
];
const SPORTS_SITE_FILES = [
  "sites/tvhebdo.com/tvhebdo.com.channels.xml",
  "sites/tvpassport.com/tvpassport.com.channels.xml",
  "sites/plex.tv/plex.tv_ca.channels.xml",
  "sites/plex.tv/plex.tv_us.channels.xml",
  "sites/pluto.tv/pluto.tv_us.channels.xml",
  "sites/tvinsider.com/tvinsider.com.channels.xml",
  "sites/streamingtvguides.com/streamingtvguides.com.channels.xml",
];
const LANGUAGE_RE = /\b(?:English|French)\b/gi;
const SPORTS_GAP_FILL_MS = 4 * 60 * 60 * 1000;

type TargetChannel = Pick<DebridioChannel, "id" | "name" | "tvgId" | "country" | "genres">;

interface SelectOptions {
  sitePriority?: (target: TargetChannel, def: IptvOrgChannelDef) => number;
}

interface GrabOptions {
  currDate?: string;
  days?: number;
  outputDir?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function exec(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "null"}`));
    });
    child.on("error", reject);
  });
}

async function ensureRepo(): Promise<string> {
  try {
    await fs.access(REPO_DIR);
  } catch {
    console.log("[iptv-org] cloning upstream repo…");
    await exec("git", ["clone", "--depth", "1", "https://github.com/iptv-org/epg.git", REPO_DIR]);
  }

  try {
    await fs.access(path.join(REPO_DIR, "node_modules"));
  } catch {
    console.log("[iptv-org] installing upstream dependencies…");
    await exec("npm", ["install", "--no-audit", "--no-fund"], REPO_DIR);
  }

  return REPO_DIR;
}

async function loadChannelDefs(
  repoDir: string,
  siteFiles: string[]
): Promise<IptvOrgChannelDef[]> {
  const defs: IptvOrgChannelDef[] = [];
  const re =
    /<channel\s+site="([^"]+)"\s+site_id="([^"]+)"\s+lang="([^"]*)"\s+xmltv_id="([^"]*)">([\s\S]*?)<\/channel>/g;

  for (const [sourceRank, relPath] of siteFiles.entries()) {
    const sourcePath = path.join(repoDir, relPath);
    const xml = await fs.readFile(sourcePath, "utf8");
    for (const match of xml.matchAll(re)) {
      const [, site, siteId, lang, xmltvId, nameRaw] = match;
      defs.push({
        site,
        siteId,
        lang: lang || "en",
        xmltvId: decodeEntities(xmltvId.trim()),
        name: decodeEntities(nameRaw.trim()),
        sourcePath: relPath,
        sourceRank,
      });
    }
  }

  return defs;
}

function canonicalTvgId(tvgId: string): string {
  return tvgId.replace(/\.usa$/i, ".us");
}

function candidateAliases(def: IptvOrgChannelDef): Set<string> {
  const out = new Set<string>();
  const xmltvBase = def.xmltvId.replace(/@.*$/, "");
  const bare = xmltvBase.replace(/\.(?:ca|us|usa)$/i, "");
  const stripped = bare.replace(LANGUAGE_RE, " ").trim();
  const aliasSources = [def.name, def.xmltvId, xmltvBase, bare, stripped];

  for (const source of aliasSources) {
    for (const alias of aliasesFor(source)) out.add(alias);
  }

  return out;
}

function candidateCountry(def: IptvOrgChannelDef): "ca" | "usa" | undefined {
  const xmltvBase = def.xmltvId.replace(/@.*$/, "");
  if (/\.ca$/i.test(xmltvBase)) return "ca";
  if (/\.(?:us|usa)$/i.test(xmltvBase)) return "usa";
  return undefined;
}

function selectChannels(
  targets: TargetChannel[],
  defs: IptvOrgChannelDef[],
  options: SelectOptions = {}
): Map<string, SelectedChannelDef> {
  const selected = new Map<string, SelectedChannelDef>();
  const defCache = new Map<IptvOrgChannelDef, Set<string>>();

  for (const ch of targets) {
    const target = {
      id: ch.id,
      name: ch.name,
      tvgId: canonicalTvgId(ch.tvgId),
    };
    const targetAliases = new Set(debridioAliases(target));
    const tvgBase = target.tvgId.replace(/@.*$/, "");
    const targetPrefixes = new Set([
      ...aliasesFor(tvgBase),
      ...aliasesFor(tvgBase.replace(/\.(?:ca|us|usa)$/i, "")),
    ]);

    let best: IptvOrgChannelDef | undefined;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const def of defs) {
      const aliases = defCache.get(def) ?? candidateAliases(def);
      if (!defCache.has(def)) defCache.set(def, aliases);

      const sharedAliases: string[] = [];
      for (const alias of aliases) {
        if (targetAliases.has(alias)) {
          sharedAliases.push(alias);
        }
      }
      if (sharedAliases.length === 0) continue;

      const xmltvBase = def.xmltvId.replace(/@.*$/, "");
      const xmltvPrefixes = new Set([
        ...aliasesFor(xmltvBase),
        ...aliasesFor(xmltvBase.replace(/\.(?:ca|us|usa)$/i, "")),
        ...aliasesFor(xmltvBase.replace(LANGUAGE_RE, " ")),
      ]);
      const exactPrefix = [...xmltvPrefixes].some(alias => targetPrefixes.has(alias));
      const exactName = aliasesFor(ch.name).some(alias => aliases.has(alias));
      const strongShared = sharedAliases.some(alias => alias.length >= 6);
      if (!exactPrefix && !exactName && !strongShared) continue;
      const country = candidateCountry(def);
      const countryPenalty = country === ch.country ? 0 : country ? 50 : 100;
      const exactPenalty = exactPrefix || exactName ? 0 : 10;
      const sitePenalty = options.sitePriority?.(ch, def) ?? 0;
      const score = countryPenalty + exactPenalty + def.sourceRank + sitePenalty;

      if (score < bestScore) {
        best = def;
        bestScore = score;
      }
    }

    if (best) {
      selected.set(ch.id, {
        ...best,
        outputXmltvId: canonicalTvgId(ch.tvgId),
        outputName: ch.name,
      });
    }
  }

  return selected;
}

async function writeChannelsXml(selected: Iterable<SelectedChannelDef>): Promise<string> {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const file = path.join(GENERATED_DIR, "channels.xml");
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<channels>",
    ...[...selected].map(def =>
      `  <channel site="${escapeXml(def.site)}" site_id="${escapeXml(def.siteId)}" lang="${escapeXml(def.lang)}" xmltv_id="${escapeXml(def.outputXmltvId)}">${escapeXml(def.outputName)}</channel>`
    ),
    "</channels>",
    "",
  ].join("\n");
  await fs.writeFile(file, body, "utf8");
  return file;
}

async function runGrab(
  repoDir: string,
  channelsPath: string,
  options: GrabOptions = {}
): Promise<string> {
  const outputDir = options.outputDir ?? GENERATED_DIR;
  await fs.mkdir(outputDir, { recursive: true });
  const guidePath = path.join(outputDir, "guide.xml");

  const env = {
    ...process.env,
    ...(options.currDate ? { CURR_DATE: options.currDate } : {}),
  };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "npm",
      [
        "run",
        "grab",
        "---",
        `--channels=${channelsPath}`,
        `--output=${guidePath}`,
        `--days=${options.days ?? 1}`,
        "--maxConnections=4",
      ],
      {
        cwd: repoDir,
        stdio: "inherit",
        shell: process.platform === "win32",
        env,
      }
    );
    child.on("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`npm run grab failed with exit code ${code ?? "null"}`));
    });
    child.on("error", reject);
  });
  return guidePath;
}

function sportsSitePriority(target: TargetChannel, def: IptvOrgChannelDef): number {
  const name = `${target.name} ${target.tvgId}`.toLowerCase();
  if (target.country === "ca") {
    if (def.site === "tvhebdo.com") return -20;
    if (def.site === "tvpassport.com") return 10;
    if (def.site === "plex.tv") return -5;
    if (def.site === "tvinsider.com") return 30;
    if (def.site === "pluto.tv") return 35;
    if (def.site === "streamingtvguides.com") return 45;
  } else {
    if (def.site === "tvpassport.com") return -20;
    if (def.site === "plex.tv") return -10;
    if (def.site === "pluto.tv") return -5;
    if (def.site === "tvinsider.com") return 5;
    if (def.site === "tvhebdo.com") return 15;
    if (def.site === "streamingtvguides.com") return 20;
  }

  if (/(sportsnet|tsn|game\+|the ocho)/i.test(name) && def.site === "tvhebdo.com") {
    return -40;
  }
  if (/(golazo|hq|abc news|ufc)/i.test(name) && def.site === "plex.tv") {
    return -25;
  }
  if (/(hq|fox sports|ufc)/i.test(name) && def.site === "pluto.tv") {
    return -15;
  }
  if (/(sny|willow xtra)/i.test(name) && def.site === "streamingtvguides.com") {
    return -15;
  }
  if (/(espn|acc|sec|big ten|nba|nfl|nhl|mlb|golf|tennis|willow|tudn|msg|nesn|altitude|yes network|marquee|spectrum sportsnet|fan ?duel|tvg)/i.test(name) &&
      def.site === "tvpassport.com") {
    return -10;
  }

  return 0;
}

function fallbackSitePriority(target: TargetChannel, def: IptvOrgChannelDef): number {
  const name = `${target.name} ${target.tvgId}`.toLowerCase();

  if (def.site === "tvpassport.com") return -20;
  if (def.site === "tvguide.com") return -10;
  if (def.site === "tvinsider.com") return 0;
  if (def.site === "plex.tv") return 5;
  if (def.site === "pluto.tv") return 10;
  if (def.site === "streamingtvguides.com") return 15;
  if (def.site === "ontvtonight.com") return 20;
  if (def.site === "tvhebdo.com") return target.country === "ca" ? 5 : 20;
  if (def.site === "directv.com") return 40;
  if (def.site === "tvtv.us") return 60;

  // Prefer TV Guide for premium rebrands that are exposed there under clean ids.
  if (/(hbo family|showtime|oxygen|reelz|thriller|max|tcm|telemundo)/i.test(name) &&
      def.site === "tvguide.com") {
    return -20;
  }

  return 0;
}

function dedupeAndFillSportsGaps(result: XmltvResult): XmltvResult {
  for (const [channelId, programmes] of result.programmesByChannel) {
    const deduped = programmes
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .filter((programme, index, list) => {
        if (index === 0) return true;
        const prev = list[index - 1];
        return !(
          prev.start.getTime() === programme.start.getTime() &&
          prev.stop.getTime() === programme.stop.getTime() &&
          prev.title === programme.title &&
          prev.description === programme.description
        );
      });

    for (let i = 1; i < deduped.length; i++) {
      const prev = deduped[i - 1];
      const next = deduped[i];
      const gapMs = next.start.getTime() - prev.stop.getTime();
      if (gapMs > 0 && gapMs <= SPORTS_GAP_FILL_MS) {
        prev.stop = new Date(next.start);
      }
    }

    result.programmesByChannel.set(channelId, deduped);
  }

  return result;
}

export async function buildIptvOrgFallback(
  unmatched: UnmatchedChannel[]
): Promise<XmltvResult | undefined> {
  if (unmatched.length === 0) return undefined;

  const repoDir = await ensureRepo();
  const defs = await loadChannelDefs(repoDir, GENERAL_SITE_FILES);
  const selected = selectChannels(unmatched, defs, {
    sitePriority: fallbackSitePriority,
  });

  console.log(`[iptv-org] matched ${selected.size}/${unmatched.length} unmatched channels to upstream site definitions`);
  if (selected.size === 0) return undefined;

  const channelsPath = await writeChannelsXml(selected.values());
  const guidePath = await runGrab(repoDir, channelsPath);
  const xml = await fs.readFile(guidePath, "utf8");
  return parseXmltvText(xml, guidePath, "iptv-org fallback", {
    minBytes: 1_000,
    minChannels: 1,
    minProgrammes: 1,
  });
}

export async function buildIptvOrgSportsOverlay(
  channels: DebridioChannel[]
): Promise<XmltvResult | undefined> {
  const sportsChannels = channels.filter(isSportsChannel);
  if (sportsChannels.length === 0) return undefined;

  const repoDir = await ensureRepo();
  const defs = await loadChannelDefs(repoDir, SPORTS_SITE_FILES);
  const selected = selectChannels(sportsChannels, defs, {
    sitePriority: sportsSitePriority,
  });

  console.log(
    `[iptv-org sports] matched ${selected.size}/${sportsChannels.length} sports channels to overlay sources`
  );
  if (selected.size === 0) return undefined;

  const outputDir = path.join(os.tmpdir(), "stream-live-tv-guide-iptv-org-sports");
  const channelsPath = await writeChannelsXml(selected.values());
  const currDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const guidePath = await runGrab(repoDir, channelsPath, {
    currDate,
    days: 3,
    outputDir,
  });
  const xml = await fs.readFile(guidePath, "utf8");
  const parsed = parseXmltvText(xml, guidePath, "iptv-org sports overlay", {
    minBytes: 1_000,
    minChannels: 1,
    minProgrammes: 1,
  });

  return dedupeAndFillSportsGaps(parsed);
}
