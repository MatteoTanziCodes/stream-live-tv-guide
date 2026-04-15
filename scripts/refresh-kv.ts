// GitHub Actions runs this every 15 minutes to keep the Cloudflare KV blob
// fresh. It exists because the epg.pw US XMLTV feed is ~200MB decoded — far
// beyond what a free-plan Cloudflare Worker can parse in its 10ms-per-invocation
// CPU budget. Running the same parse + match pipeline on a full Node runner
// sidesteps that entirely. The resulting CachedBlob is PUT to Cloudflare KV
// via the REST API so the worker's request-path is unchanged.
//
// Required env vars (wired up as GitHub repo secrets in the workflow):
//   CF_ACCOUNT_ID         — the Cloudflare account that owns the worker
//   CF_KV_NAMESPACE_ID    — the id of the CHANNEL_STATE KV namespace
//   CF_API_TOKEN          — API token with "Workers KV Storage: Edit" scope
//   DEBRIDIO_TOKEN        — your Debridio token (from tv.lb.debridio.com/<TOKEN>/manifest.json)
//                           used to fetch the live Debridio CA+USA channel catalog;
//                           falls back to the hardcoded channels.ts if not set or fetch fails.

import { buildBlob, KV_STATE_KEY } from "../src/kvcache";
import { DEBRIDIO_CHANNELS } from "../src/channels";
import { fetchDebridioChannels } from "../src/debridio";
import { buildIptvOrgFallbacks, buildIptvOrgSportsOverlays } from "./iptv-org";

async function putToKV(
  accountId: string,
  namespaceId: string,
  apiToken: string,
  key: string,
  value: string
): Promise<void> {
  // https://api.cloudflare.com/#workers-kv-namespace-write-key-value-pair
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${apiToken}`,
      // KV's REST API accepts any body as-is; we keep it JSON for readability
      // in the Cloudflare dashboard preview.
      "content-type": "application/json",
    },
    body: value,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Cloudflare KV PUT failed: ${res.status} ${res.statusText}\n${text}`);
  }
  // The Cloudflare API wraps every response in `{success, errors, messages, result}`.
  // Double-check the success flag even on 2xx, since some error paths return 200.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare KV PUT returned non-JSON body: ${text.slice(0, 200)}`);
  }
  if (typeof parsed === "object" && parsed !== null && "success" in parsed) {
    const wrapper = parsed as { success: boolean; errors?: unknown };
    if (!wrapper.success) {
      throw new Error(`Cloudflare KV PUT returned success=false: ${JSON.stringify(wrapper.errors)}`);
    }
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`missing required env var ${name}`);
  }
  return v;
}

async function main() {
  const accountId = requireEnv("CF_ACCOUNT_ID");
  const namespaceId = requireEnv("CF_KV_NAMESPACE_ID");
  const apiToken = requireEnv("CF_API_TOKEN");

  // Attempt to fetch the live Debridio channel catalog. This keeps coverage
  // up to date when Debridio adds or removes channels — no manual channels.ts
  // edits required. Falls back to the hardcoded list if the token is absent
  // or the catalog fetch fails (so existing refreshes keep working during
  // any Debridio outage).
  const debridioToken = process.env.DEBRIDIO_TOKEN;
  let dynamicChannels: Awaited<ReturnType<typeof fetchDebridioChannels>>["channels"] | undefined;

  if (debridioToken) {
    console.log("[refresh-kv] fetching Debridio channel catalog…");
    const result = await fetchDebridioChannels(debridioToken);
    if (result.completenessErrors.length > 0) {
      console.warn("[refresh-kv] Debridio catalog completeness errors:");
      for (const e of result.completenessErrors) console.warn(`  - ${e}`);
    }
    if (result.channels.length > 0) {
      dynamicChannels = result.channels;
      console.log(
        `[refresh-kv] using dynamic catalog: ${result.channels.length} channels ` +
          `(CA: ${result.channels.filter(c => c.country === "ca").length}, ` +
          `USA: ${result.channels.filter(c => c.country === "usa").length})`
      );
    } else {
      console.warn("[refresh-kv] dynamic catalog returned 0 channels — falling back to hardcoded list");
    }
  } else {
    console.log("[refresh-kv] DEBRIDIO_TOKEN not set — using hardcoded channels.ts fallback");
  }

  const channelsForRefresh = dynamicChannels && dynamicChannels.length > 0
    ? dynamicChannels
    : [...DEBRIDIO_CHANNELS];

  const extraFeeds: Parameters<typeof buildBlob>[1] = [];
  const sportsOverlays = await buildIptvOrgSportsOverlays(channelsForRefresh);
  for (const overlay of sportsOverlays) {
    extraFeeds.push({ kind: "sports", result: overlay });
  }

  console.log("[refresh-kv] building blob from epg.pw feeds…");
  let blob = await buildBlob(dynamicChannels, extraFeeds);

  if (blob.report.unmatched.length > 0) {
    console.log(
      `[refresh-kv] primary pass left ${blob.report.unmatched.length} unmatched channels; ` +
        `trying iptv-org fallback…`
    );
    const fallbacks = await buildIptvOrgFallbacks(blob.report.unmatched);
    if (fallbacks.length > 0) {
      blob = await buildBlob(dynamicChannels, [
        ...extraFeeds,
        ...fallbacks.map(result => ({ kind: "fallback" as const, result })),
      ]);
      console.log(
        `[refresh-kv] fallback merged: ${blob.report.matched}/${blob.report.debridioChannelCount} matched`
      );
    } else {
      console.log("[refresh-kv] iptv-org fallback did not produce any additional guide data");
    }
  }
  const body = JSON.stringify(blob);

  console.log(
    `[refresh-kv] blob ready: ${body.length} bytes, ` +
      `${blob.report.matched}/${blob.report.debridioChannelCount} Debridio channels matched`
  );

  // Hard-fail if completeness looked bad. The GitHub Actions run will go red
  // and we'd rather skip an update than overwrite KV with half-parsed data.
  const totalErrors =
    blob.report.sources.reduce((n, s) => n + s.completenessErrors.length, 0);
  if (totalErrors > 0) {
    console.error("[refresh-kv] completeness errors detected:");
    for (const s of blob.report.sources) {
      if (s.completenessErrors.length > 0) {
        console.error(`  ${s.name}:`);
        for (const e of s.completenessErrors) console.error(`    - ${e}`);
      }
    }
  }
  if (blob.report.matched < 10) {
    throw new Error(
      `refusing to push: only ${blob.report.matched} channels matched, feeds likely broken`
    );
  }

  console.log(`[refresh-kv] pushing to Cloudflare KV at key=${KV_STATE_KEY}…`);
  await putToKV(accountId, namespaceId, apiToken, KV_STATE_KEY, body);
  console.log("[refresh-kv] done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
