import { blurbFor, findChannelForItem, ItemLike } from "./matcher";
import { loadAllStates, refreshAllToKV } from "./kvcache";
import { ChannelState } from "./types";

// Where Debridio lives. Overridable via a var if they ever change host.
const DEBRIDIO_BASE_DEFAULT = "https://tv.lb.debridio.com";

export interface Env {
  CHANNEL_STATE: KVNamespace;
  DEBRIDIO_BASE?: string;
}

function enhanceItem<T extends ItemLike & { description?: string }>(
  item: T,
  states: ChannelState[]
): T {
  const state = findChannelForItem(item, states);
  const blurb = blurbFor(state);
  if (!blurb) return item;
  return { ...item, description: blurb };
}

// Walk a JSON response body and rewrite description on any recognised items.
// Only touches `metas[]` (catalog response) and `meta` (single-meta response).
// `streams[]` is intentionally left alone — Debridio's stream descriptions
// ("A1X Media", "TVPass HD") are identifiers, not TV listings.
function rewriteBody(data: unknown, states: ChannelState[]): unknown {
  if (!data || typeof data !== "object") return data;
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
// If the first path segment isn't long enough to plausibly be a token, we treat
// it as "no token present" and serve the landing page.
function parseRequestUrl(url: URL): { token: string; forwardPath: string } | null {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const [token, ...rest] = segments;
  // Debridio tokens are base64-encoded JSON configs ~200+ chars. Anything under
  // 40 chars is almost certainly not a token — probably someone hitting /manifest.json
  // directly or a bot. Show the landing page instead.
  if (token.length < 40) return null;
  return { token, forwardPath: "/" + rest.join("/") };
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

async function handleProxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Manual trigger for the scrape job. Harmless — it just re-fetches the same 5
  // tvpassport pages the cron would fetch. Used to warm KV right after deploy.
  if (url.pathname === "/__refresh") {
    await refreshAllToKV(env.CHANNEL_STATE);
    return new Response(JSON.stringify({ ok: true, refreshedAt: new Date().toISOString() }), {
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  const parsed = parseRequestUrl(url);
  if (!parsed) return landingPage();

  const base = (env.DEBRIDIO_BASE || DEBRIDIO_BASE_DEFAULT).replace(/\/+$/, "");
  const target = `${base}/${parsed.token}${parsed.forwardPath}${url.search}`;

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
    console.error(`[proxy] upstream fetch failed for ${parsed.forwardPath}:`, (err as Error).message);
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
      const rewritten = rewriteBody(json, states);
      return new Response(JSON.stringify(rewritten), {
        status: upstream.status,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
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

function landingPage(): Response {
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
<p class="muted">A proxy for the Debridio TV Stremio addon that fills in live "now playing" descriptions for TSN 1-5 (Canada), scraped from tvpassport.com.</p>

<h2>How to install</h2>
<ol>
  <li>Open Stremio and find your Debridio TV addon's manifest URL. It looks like:
    <div class="box"><code>https://tv.lb.debridio.com/<strong>&lt;long-base64-token&gt;</strong>/manifest.json</code></div>
  </li>
  <li>Take the long base64 token (the part between <code>debridio.com/</code> and <code>/manifest.json</code>).</li>
  <li>Install this URL instead, replacing <code>TOKEN</code> with your real token:
    <div class="box"><code>https://<em>this-worker-host</em>/<strong>TOKEN</strong>/manifest.json</code></div>
  </li>
  <li>Your TSN 1-5 channels will now show <strong>"Now:…"</strong> and <strong>"Up next:…"</strong> descriptions. Other channels pass through unchanged.</li>
</ol>

<h2>Privacy</h2>
<p class="muted">Requests are proxied to Debridio and your token is visible in the URL. Don't use this if you don't want to share the token with whoever operates this instance. You can self-host from the source.</p>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    return handleProxy(request, env);
  },

  // Cron: scrape tvpassport and refresh the KV cache.
  // Runs regardless of whether anyone has requested anything — fresh data is ready
  // the moment a Stremio client asks.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshAllToKV(env.CHANNEL_STATE));
  },
};
