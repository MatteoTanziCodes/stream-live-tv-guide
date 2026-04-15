// Fetches the current channel list directly from Debridio at refresh time,
// replacing the hardcoded channels.ts. This keeps coverage up to date when
// Debridio adds or removes channels without needing manual edits.
//
// How it works:
//   1. Fetch /manifest.json to discover which catalog ids are advertised.
//   2. For each catalog of type "tv", paginate through all items.
//   3. Map each Stremio meta item to a DebridioChannel (id, name, tvgId, country).
//   4. Filter: CA + USA only, no USA locals (matching user's mandate).
//
// Completeness gates (same philosophy as epgpw.ts):
//   - HTTP 200 required
//   - At least one TV catalog must be advertised in the manifest
//   - Each catalog must return ≥1 item
//   - Overall channel count must be ≥10

import { DebridioChannel } from "./types";

const DEBRIDIO_BASE_DEFAULT = "https://tv.lb.debridio.com";

interface StremioManifest {
  id?: string;
  name?: string;
  catalogs?: Array<{
    type: string;
    id: string;
    name?: string;
    extra?: Array<{ name: string; isRequired?: boolean }>;
  }>;
}

interface DebridioMeta {
  id: string;
  type: string;
  name: string;
  tvgId?: string;
  // Debridio-specific extension fields
  country?: string;
  genres?: string[];
  description?: string;
}

interface StremioCatalogResponse {
  metas?: DebridioMeta[];
}

// Infer CA vs USA country from catalog id, tvgId, or name.
// USA locals are channels whose tvgId or name explicitly contains
// a call-sign style suffix like ".us" locality markers or is tagged
// as a local affiliate. We keep national feeds, drop sub-market locals.
function inferCountry(
  catalogId: string,
  item: DebridioMeta
): "ca" | "usa" | "skip" {
  const lower = catalogId.toLowerCase();

  // CA catalogs
  if (lower.includes("-ca") || lower.includes("_ca") || lower === "ca" ||
      lower.endsWith("canada") || lower.includes("canadian")) {
    return "ca";
  }
  // USA locals — skip these per the "no USA locals" mandate
  if (lower.includes("local") || lower.includes("locals")) {
    return "skip";
  }
  // USA catalogs
  if (lower.includes("-us") || lower.includes("_us") || lower.includes("-usa") ||
      lower === "us" || lower === "usa" || lower.endsWith("united-states") ||
      lower.includes("american")) {
    // Double-check tvgId for locality markers
    const tvg = (item.tvgId || "").toLowerCase();
    // USA locals typically have tvgId ending in a city/state code like ".us.nbc.chicago"
    // or contain a DMA market name. Skip obvious patterns.
    if (tvg.match(/\.(abc|nbc|cbs|fox|cw)\.[a-z]+$/)) return "skip";
    return "usa";
  }

  // Fallback: infer from tvgId suffix
  const tvg = (item.tvgId || "").toLowerCase();
  if (tvg.endsWith(".ca")) return "ca";
  if (tvg.endsWith(".us") || tvg.endsWith(".usa")) return "usa";

  // Unknown country — skip rather than misattribute
  return "skip";
}

// Fetch a single catalog page. Returns the items array (may be empty).
async function fetchCatalogPage(
  baseUrl: string,
  token: string,
  catalogType: string,
  catalogId: string,
  skip: number
): Promise<DebridioMeta[]> {
  const url =
    `${baseUrl}/${token}/catalog/${catalogType}/${catalogId}` +
    (skip > 0 ? `/skip=${skip}` : "") +
    ".json";
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": "stream-live-tv-guide", accept: "application/json" },
    });
  } catch (err) {
    console.warn(`[debridio] catalog fetch error (${url}): ${(err as Error).message}`);
    return [];
  }
  if (!res.ok) {
    console.warn(`[debridio] catalog ${catalogId} skip=${skip}: HTTP ${res.status}`);
    return [];
  }
  let json: StremioCatalogResponse;
  try {
    json = await res.json() as StremioCatalogResponse;
  } catch {
    return [];
  }
  return json.metas ?? [];
}

// Paginate through an entire catalog, following Stremio's skip= convention.
async function fetchEntireCatalog(
  baseUrl: string,
  token: string,
  catalogType: string,
  catalogId: string
): Promise<DebridioMeta[]> {
  const PAGE = 100; // Stremio addons typically page at 100 items
  const all: DebridioMeta[] = [];
  let skip = 0;
  // Hard cap at 50 pages (5 000 items) to avoid infinite loops on buggy endpoints.
  for (let page = 0; page < 50; page++) {
    const items = await fetchCatalogPage(baseUrl, token, catalogType, catalogId, skip);
    if (!items.length) break;
    all.push(...items);
    if (items.length < PAGE) break; // Last page
    skip += PAGE;
  }
  return all;
}

export interface FetchDebridioChannelsResult {
  channels: DebridioChannel[];
  completenessErrors: string[];
}

export async function fetchDebridioChannels(
  token: string,
  baseUrl = DEBRIDIO_BASE_DEFAULT
): Promise<FetchDebridioChannelsResult> {
  const errors: string[] = [];
  const base = baseUrl.replace(/\/+$/, "");

  // Step 1: fetch manifest to discover catalog ids.
  let manifest: StremioManifest;
  try {
    const mRes = await fetch(`${base}/${token}/manifest.json`, {
      headers: { "user-agent": "stream-live-tv-guide", accept: "application/json" },
    });
    if (!mRes.ok) {
      errors.push(`manifest fetch failed: HTTP ${mRes.status}`);
      return { channels: [], completenessErrors: errors };
    }
    manifest = await mRes.json() as StremioManifest;
  } catch (err) {
    errors.push(`manifest fetch error: ${(err as Error).message}`);
    return { channels: [], completenessErrors: errors };
  }

  const tvCatalogs = (manifest.catalogs ?? []).filter(c => c.type === "tv");
  if (tvCatalogs.length === 0) {
    errors.push("manifest advertises no tv-type catalogs");
    return { channels: [], completenessErrors: errors };
  }
  console.log(`[debridio] manifest has ${tvCatalogs.length} TV catalog(s): ${tvCatalogs.map(c => c.id).join(", ")}`);

  // Step 2: fetch each catalog and collect channels.
  const channels: DebridioChannel[] = [];
  const seen = new Set<string>();

  for (const catalog of tvCatalogs) {
    const items = await fetchEntireCatalog(base, token, "tv", catalog.id);
    if (items.length === 0) {
      errors.push(`catalog "${catalog.id}" returned 0 items`);
      continue;
    }
    console.log(`[debridio] catalog "${catalog.id}": ${items.length} items`);

    for (const item of items) {
      if (!item.id || !item.name) continue;
      if (seen.has(item.id)) continue; // dedup across catalogs

      const country = inferCountry(catalog.id, item);
      if (country === "skip") continue;

      seen.add(item.id);
      channels.push({
        id: item.id,
        name: item.name,
        tvgId: item.tvgId ?? "",
        country,
        genres: item.genres,
      });
    }
  }

  // Completeness gate
  if (channels.length < 10) {
    errors.push(
      `only ${channels.length} CA/USA channels found across all catalogs (expected ≥10)`
    );
  }

  console.log(
    `[debridio] discovered ${channels.length} channels ` +
      `(CA: ${channels.filter(c => c.country === "ca").length}, ` +
      `USA: ${channels.filter(c => c.country === "usa").length})`
  );

  return { channels, completenessErrors: errors };
}
