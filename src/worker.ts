import { blurbFor, findChannelState, ItemLike } from "./matcher";
import { loadAllStates, loadBlob } from "./kvcache";
import { ChannelState } from "./types";

// Where Debridio lives. Overridable via a var if they ever change host.
const DEBRIDIO_BASE_DEFAULT = "https://tv.lb.debridio.com";

export interface Env {
  CHANNEL_STATE: KVNamespace;
  DEBRIDIO_BASE?: string;
}

interface StremioManifest {
  id?: string;
  name?: string;
  description?: string;
  behaviorHints?: Record<string, unknown>;
  [key: string]: unknown;
}

function enhanceItem<T extends ItemLike & { description?: string }>(
  item: T,
  states: Record<string, ChannelState>
): T {
  const state = findChannelState(item, states);
  const blurb = blurbFor(state);
  if (!blurb) return item;
  return { ...item, description: blurb };
}

function rewriteManifest(data: unknown, host: string): unknown {
  if (!data || typeof data !== "object") return data;
  const manifest = data as StremioManifest;
  const name = typeof manifest.name === "string" && manifest.name.trim()
    ? `${manifest.name} + Live Guide`
    : "Debridio TV + Live Guide";
  return {
    ...manifest,
    name,
    description:
      `Proxy via ${host} with live Now/Up next guide data for supported CA/US channels.`,
    behaviorHints: {
      ...(manifest.behaviorHints ?? {}),
      configurable: false,
    },
  };
}

// Walk a JSON response body and rewrite manifest metadata plus descriptions on
// recognised items. `streams[]` is intentionally left alone — Debridio's stream
// descriptions ("A1X Media", "TVPass HD") are identifiers, not TV listings.
function rewriteBody(
  data: unknown,
  states: Record<string, ChannelState>,
  forwardPath: string,
  host: string
): unknown {
  if (!data || typeof data !== "object") return data;
  if (forwardPath === "/manifest.json") {
    return rewriteManifest(data, host);
  }
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.metas)) {
    obj.metas = (obj.metas as ItemLike[]).map(m => enhanceItem(m, states));
  }
  if (obj.meta && typeof obj.meta === "object") {
    obj.meta = enhanceItem(obj.meta as ItemLike, states);
  }
  return obj;
}

// URL shape:
//   https://<worker>/<debridio-token>/<stremio-path>[?query]
// The token is the full base64 config segment from the user's Debridio URL.
// Every Debridio token is base64-encoded JSON starting with `{`, which encodes to `eyJ`.
// We use that prefix as a sanity check and show helpful errors for common mistakes.
const DEBRIDIO_TOKEN_PREFIX = "eyJ";
const STREMIO_PATH_MARKERS = ["manifest.json", "catalog/", "meta/", "stream/", "configure"];

type UrlResult =
  | { kind: "ok"; token: string; forwardPath: string }
  | { kind: "landing" }
  | { kind: "badToken"; reason: "not-base64" | "too-short" | "no-stremio-path" };

function parseRequestUrl(url: URL): UrlResult {
  const pathname = url.pathname.replace(/^\/+/, "");
  if (!pathname) return { kind: "landing" };

  let token: string;
  let forwardPath: string;

  const slashIdx = pathname.indexOf("/");
  if (slashIdx > 0) {
    token = pathname.slice(0, slashIdx);
    forwardPath = "/" + pathname.slice(slashIdx + 1);
  } else {
    // No `/` in the path. Common mistake: user pasted `.../TOKENmanifest.json` without
    // a separator. Try to find a Stremio path marker and split at its start.
    let markerIdx = -1;
    for (const marker of STREMIO_PATH_MARKERS) {
      const idx = pathname.indexOf(marker);
      if (idx > 0 && (markerIdx === -1 || idx < markerIdx)) markerIdx = idx;
    }
    if (markerIdx < 0) return { kind: "badToken", reason: "no-stremio-path" };
    token = pathname.slice(0, markerIdx);
    forwardPath = "/" + pathname.slice(markerIdx);
  }

  if (!token.startsWith(DEBRIDIO_TOKEN_PREFIX)) return { kind: "badToken", reason: "not-base64" };
  if (token.length < 40) return { kind: "badToken", reason: "too-short" };
  return { kind: "ok", token, forwardPath };
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

async function handleProxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // /__refresh used to trigger a synchronous re-scrape. It's been retired —
  // the 200MB US epg.pw feed can't be parsed inside the free-plan Cloudflare
  // Worker's 10ms CPU budget. Refreshes now come from a GitHub Action that
  // runs the same pipeline on a full Node runner and PUTs the result to KV
  // via the Cloudflare REST API (see .github/workflows/refresh-kv.yml).
  if (url.pathname === "/__refresh") {
    return new Response(
      JSON.stringify(
        {
          error: "refresh runs in GitHub Actions, not in the worker",
          howTo:
            "Run the 'Refresh EPG to Cloudflare KV' workflow manually from the repo's Actions tab, or wait for the 15-min cron.",
        },
        null,
        2
      ),
      { status: 410, headers: { "content-type": "application/json", ...CORS_HEADERS } }
    );
  }

  // Coverage + completeness inspector. Returns the MatchReport from the last
  // refresh. Missing KV blob → 503, meaning the GitHub Action hasn't run yet.
  if (url.pathname === "/__status") {
    const blob = await loadBlob(env.CHANNEL_STATE);
    if (!blob) {
      return new Response(
        JSON.stringify(
          {
            error: "no refresh has completed yet",
            howTo:
              "Run the 'Refresh EPG to Cloudflare KV' GitHub Actions workflow once to populate KV, or wait for the 15-min cron.",
          },
          null,
          2
        ),
        { status: 503, headers: { "content-type": "application/json", ...CORS_HEADERS } }
      );
    }
    return new Response(JSON.stringify(blob.report, null, 2), {
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  const result = parseRequestUrl(url);
  if (result.kind === "landing") return landingPage(url.host);
  if (result.kind === "badToken") return badTokenPage(result.reason, url.host);

  const base = (env.DEBRIDIO_BASE || DEBRIDIO_BASE_DEFAULT).replace(/\/+$/, "");
  const target = `${base}/${result.token}${result.forwardPath}${url.search}`;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: {
        "user-agent": request.headers.get("user-agent") || "stream-live-tv-guide",
        accept: "application/json",
      },
    });
  } catch (err) {
    console.error(`[proxy] upstream fetch failed for ${result.forwardPath}:`, (err as Error).message);
    return new Response(
      JSON.stringify({ error: "upstream error", detail: (err as Error).message }),
      { status: 502, headers: { "content-type": "application/json", ...CORS_HEADERS } }
    );
  }

  const ct = upstream.headers.get("content-type") ?? "";

  // Only rewrite JSON bodies. Everything else (HTML, m3u8, images) passes through.
  if (ct.includes("application/json")) {
    const body = await upstream.text();
    try {
      const json = JSON.parse(body);
      const states = await loadAllStates(env.CHANNEL_STATE);
      const rewritten = rewriteBody(json, states, result.forwardPath, url.host);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...CORS_HEADERS,
      };
      if (result.forwardPath === "/manifest.json") {
        headers["cache-control"] = "no-store, no-cache, max-age=0, must-revalidate";
        headers.pragma = "no-cache";
        headers.expires = "0";
      }
      return new Response(JSON.stringify(rewritten), {
        status: upstream.status,
        headers,
      });
    } catch {
      // Upstream said JSON but gave us garbage — pass through raw.
      return new Response(body, {
        status: upstream.status,
        headers: { "content-type": ct, ...CORS_HEADERS },
      });
    }
  }

  // Binary or other text — stream through untouched.
  const buf = await upstream.arrayBuffer();
  return new Response(buf, {
    status: upstream.status,
    headers: { "content-type": ct, ...CORS_HEADERS },
  });
}

function badTokenPage(reason: "not-base64" | "too-short" | "no-stremio-path", host: string): Response {
  const hint = {
    "not-base64":
      "The URL segment after this worker's hostname isn't a valid Debridio token. Debridio tokens are long base64 strings that start with <code>eyJ</code> — they're the whole base64 blob in your Debridio URL between <code>debridio.com/</code> and <code>/manifest.json</code>, not the api_key value inside.",
    "too-short":
      "The token in your URL is too short to be a Debridio token. You probably pasted the api_key (the 32-character hex string inside the token) instead of the full base64 token. Use the whole base64 blob that starts with <code>eyJ</code>.",
    "no-stremio-path":
      "The URL is missing the Stremio path (e.g. <code>/manifest.json</code>). Make sure your URL ends with <code>/manifest.json</code> — with a slash between the token and <code>manifest.json</code>.",
  }[reason];

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>stream-live-tv-guide — invalid URL</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; color: #1a1a1a; }
  code { background: #f3f3f3; padding: 0.1em 0.35em; border-radius: 4px; word-break: break-all; }
  .box { background: #fef6e4; border-left: 3px solid #f0a640; padding: 0.9rem 1.1rem; border-radius: 6px; margin: 1rem 0; }
  .muted { color: #666; }
</style></head>
<body>
<h1>Invalid URL</h1>
<div class="box">${hint}</div>
<h2>Correct shape</h2>
<p><code>https://${host}/<strong>&lt;long-base64-token&gt;</strong>/manifest.json</code></p>
<p class="muted">The token is the whole base64 string from your Debridio URL — the part between <code>tv.lb.debridio.com/</code> and <code>/manifest.json</code>. It starts with <code>eyJ</code> and is usually 200–400 characters.</p>
</body></html>`;
  return new Response(html, {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", ...CORS_HEADERS },
  });
}

function landingPage(host: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>stream-live-tv-guide</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; color: #1a1a1a; }
  h1 { margin-bottom: 0.25rem; }
  h2 { margin-top: 2rem; }
  code { background: #f3f3f3; padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.92em; word-break: break-all; }
  .muted { color: #666; }
  ol li { margin: 0.5rem 0; }
  .box { background: #f7f7f7; padding: 1rem 1.25rem; border-radius: 8px; margin: 1rem 0; }
</style>
</head>
<body>
<h1>stream-live-tv-guide</h1>
<p class="muted">A proxy for the Debridio TV Stremio addon that fills in live "now playing" descriptions for Canadian and US TV channels, sourced from epg.pw with targeted iptv-org fallback guides for channels epg.pw misses.</p>

<h2>How to install</h2>
<ol>
  <li>Open Stremio and find your Debridio TV addon's manifest URL. It looks like:
    <div class="box"><code>https://tv.lb.debridio.com/<strong>&lt;long-base64-token&gt;</strong>/manifest.json</code></div>
  </li>
  <li>Take the long base64 token (the part between <code>debridio.com/</code> and <code>/manifest.json</code>).</li>
  <li>Install this URL instead, replacing <code>TOKEN</code> with your real token:
    <div class="box"><code>https://${host}/<strong>TOKEN</strong>/manifest.json</code></div>
  </li>
  <li>All supported Canadian and US channels will now show <strong>"Now:…"</strong> and <strong>"Up next:…"</strong> descriptions. Unmatched channels pass through unchanged.</li>
</ol>

<h2>Status / debug</h2>
<p>Call <code>/__status</code> on this worker to see the last refresh's coverage report (how many Debridio channels were matched, completeness errors per feed, list of unmatched channels).</p>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", ...CORS_HEADERS },
  });
}

// No scheduled() handler: refreshes are driven by GitHub Actions because the
// US epg.pw feed (~200MB decoded) blows past the free plan's 10ms-per-invocation
// CPU limit. The worker is a pure reader of a KV blob that the action owns.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    return handleProxy(request, env);
  },
};
