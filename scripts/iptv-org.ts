import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseXmltvText, XmltvResult } from "../src/epgpw";
import { aliasesFor, debridioAliases } from "../src/matcher";

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

const REPO_DIR = path.join(os.tmpdir(), "iptv-org-epg");
const GENERATED_DIR = path.join(os.tmpdir(), "stream-live-tv-guide-iptv-org");
const SITE_FILES = [
  "sites/tvguide.com/tvguide.com.channels.xml",
  "sites/tvtv.us/tvtv.us.channels.xml",
  "sites/directv.com/directv.com.channels.xml",
  "sites/tvpassport.com/tvpassport.com.channels.xml",
  "sites/ontvtonight.com/ontvtonight.com_us.channels.xml",
  "sites/ontvtonight.com/ontvtonight.com_ca.channels.xml",
  "sites/tvhebdo.com/tvhebdo.com.channels.xml",
];
const LANGUAGE_RE = /\b(?:English|French)\b/gi;

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

async function loadChannelDefs(repoDir: string): Promise<IptvOrgChannelDef[]> {
  const defs: IptvOrgChannelDef[] = [];
  const re =
    /<channel\s+site="([^"]+)"\s+site_id="([^"]+)"\s+lang="([^"]*)"\s+xmltv_id="([^"]*)">([\s\S]*?)<\/channel>/g;

  for (const [sourceRank, relPath] of SITE_FILES.entries()) {
    const sourcePath = path.join(repoDir, relPath);
    const xml = await fs.readFile(sourcePath, "utf8");
    for (const match of xml.matchAll(re)) {
      const [, site, siteId, lang, xmltvId, nameRaw] = match;
      if (!xmltvId.trim()) continue;
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
  unmatched: UnmatchedChannel[],
  defs: IptvOrgChannelDef[]
): Map<string, IptvOrgChannelDef> {
  const selected = new Map<string, IptvOrgChannelDef>();
  const defCache = new Map<IptvOrgChannelDef, Set<string>>();

  for (const ch of unmatched) {
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
      const strongShared = sharedAliases.some(alias => alias.length >= 6);
      if (!exactPrefix && !strongShared) continue;
      const country = candidateCountry(def);
      const countryPenalty =
        country === ch.country ? 0 : country ? 50 : 100;
      const exactPenalty = exactPrefix ? 0 : 10;
      const score = countryPenalty + exactPenalty + def.sourceRank;

      if (score < bestScore) {
        best = def;
        bestScore = score;
      }
    }

    if (best) {
      selected.set(ch.id, best);
    }
  }

  return selected;
}

async function writeChannelsXml(selected: Iterable<IptvOrgChannelDef>): Promise<string> {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const file = path.join(GENERATED_DIR, "channels.xml");
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<channels>",
    ...[...selected].map(def =>
      `  <channel site="${escapeXml(def.site)}" site_id="${escapeXml(def.siteId)}" lang="${escapeXml(def.lang)}" xmltv_id="${escapeXml(def.xmltvId)}">${escapeXml(def.name)}</channel>`
    ),
    "</channels>",
    "",
  ].join("\n");
  await fs.writeFile(file, body, "utf8");
  return file;
}

async function runGrab(repoDir: string, channelsPath: string): Promise<string> {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const guidePath = path.join(GENERATED_DIR, "guide.xml");
  await exec(
    "npm",
    ["run", "grab", "---", `--channels=${channelsPath}`, `--output=${guidePath}`, "--days=1", "--maxConnections=4"],
    repoDir
  );
  return guidePath;
}

export async function buildIptvOrgFallback(
  unmatched: UnmatchedChannel[]
): Promise<XmltvResult | undefined> {
  if (unmatched.length === 0) return undefined;

  const repoDir = await ensureRepo();
  const defs = await loadChannelDefs(repoDir);
  const selected = selectChannels(unmatched, defs);

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
