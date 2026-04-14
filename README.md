# stream-live-tv-guide

A Cloudflare Worker that sits in front of the [Debridio TV](https://debridio.com) Stremio addon
and fills in the **live "Now playing"** description for all supported Canadian and US
channels (209 total), sourced from free [epg.pw](https://epg.pw) XMLTV feeds and refreshed
every 15 minutes by a GitHub Action.

Debridio's TV catalog normally leaves channel descriptions empty. Install this worker
instead, and matched channels show "Now: {title} — {blurb} • Next: {title}" in Stremio.
Unmatched or international channels pass through untouched.

## Install in Stremio

You need your own Debridio TV addon URL (set up at <https://debridio.com>). It looks like:

```
https://tv.lb.debridio.com/<your-long-base64-token>/manifest.json
```

Take the `<your-long-base64-token>` portion, then install this in Stremio instead:

```
https://stream-live-tv-guide.matteo-beatstanzi.workers.dev/<your-long-base64-token>/manifest.json
```

That's it. Descriptions refresh automatically every 15 minutes.

## How it works

```
   Stremio  ->  this worker  ->  Debridio
                   |
                   v  (read every request)
                Workers KV
                   ^
                   |  (write every 15 min)
              GitHub Action  ->  epg.pw CA + US XMLTV
```

- **Worker (request path)**: every request is forwarded to Debridio. On JSON responses,
  the worker walks `metas[]` / `meta` and rewrites `description` for any item whose
  name/id/tvgId matches a known channel. Streams and other responses pass through.
  The worker only reads from KV — it never refreshes the data itself.
- **GitHub Action (refresh path)**: every 15 minutes the workflow fetches
  `https://epg.pw/xmltv/epg_CA.xml` and `https://epg.pw/xmltv/epg_US.xml`,
  streaming-parses channels + programmes (the US feed alone is ~200MB), matches each
  Debridio channel against the epg.pw data by normalized aliases (HD/SD/parens-tolerant,
  Jr↔Junior bidirectional), and PUTs the combined blob to Cloudflare KV via the REST
  API under key `states:v2`.
- **Why the split?** A free-plan Cloudflare Worker is capped at 10ms CPU per
  invocation, which is nowhere near enough to parse 200MB of XML. Running the parse
  in GitHub Actions (a real Node runner with no CPU limit) sidesteps that, and the
  worker stays a fast, pure reader.
- **Multi-tenant**: the epg.pw data is the same for every user, so one refresh
  serves all Debridio tokens. Your token is only used as the upstream path to Debridio.
- **Completeness tracking**: every stage of the pipeline (HTTP fetch, parse, match)
  emits metrics. Hit `/__status` to see how many channels matched, how many bytes
  each feed returned, which Debridio channels are unmatched, and any parse failures.

## Self-hosting

```sh
git clone https://github.com/MatteoTanziCodes/stream-live-tv-guide.git
cd stream-live-tv-guide
npm install
npx wrangler login           # OAuth into your Cloudflare account
npx wrangler kv namespace create CHANNEL_STATE
#   -> copy the returned id into wrangler.toml
npx wrangler deploy
```

The worker is deployed but KV is empty until the GitHub Action runs. Set up the
action next.

### GitHub Actions setup (required)

The 15-minute refresh runs as a workflow, which needs three repository secrets so
it can write to your Cloudflare KV namespace via the REST API.

1. In your repo: **Settings → Secrets and variables → Actions → New repository secret**.
   Add three secrets:

   | Name | Value |
   |---|---|
   | `CF_ACCOUNT_ID` | Your Cloudflare account ID (Workers dashboard sidebar). |
   | `CF_KV_NAMESPACE_ID` | The KV namespace id (same one in `wrangler.toml`). |
   | `CF_API_TOKEN` | A Cloudflare API token with **Workers KV Storage: Edit**. Create at <https://dash.cloudflare.com/profile/api-tokens> using the "Workers KV Storage" template, scoped to your account. |

2. Trigger the first run manually: **Actions → Refresh EPG to Cloudflare KV → Run workflow**.

3. After the workflow completes (~30s), hit `https://<your-worker>.workers.dev/__status`
   to verify coverage. You should see `matched ≈ 180+` of 209 channels and zero
   `completenessErrors` per source.

The cron is set to `*/15 * * * *`. GitHub's scheduled runs routinely skew several
minutes under load, so a tighter cadence wouldn't actually be more "live".

### Cloudflare Worker Builds (optional, recommended)

If you've enabled Cloudflare's git integration on the worker, deployments happen
automatically on every push to `main`. The repo defaults work as-is:

- **Build command**: *(none)* — wrangler bundles the TypeScript on deploy
- **Deploy command**: `npx wrangler deploy`
- **Version command**: `npx wrangler versions upload`
- **Root directory**: `/`
- **Production branch**: `main`

No Cloudflare-side env vars are required for the worker; the only KV binding is
declared in `wrangler.toml` and resolved automatically at deploy time.

## Layout

```
src/
  worker.ts       fetch handler, proxy + rewrite logic, /__status
  epgpw.ts        XMLTV streaming fetch + extraction with completeness gates
  kvcache.ts      buildBlob (parse + match + report), KV read helpers
  matcher.ts      request-time lookup + blurb construction + alias generation
  channels.ts     the 209 Debridio CA + US channels we try to enrich
  types.ts        shared type definitions (including SourceStats, MatchReport)
scripts/
  refresh-kv.ts   GitHub-Action entry: buildBlob + PUT to Cloudflare KV REST API
.github/workflows/
  refresh-kv.yml  cron schedule + workflow_dispatch trigger
wrangler.toml     worker name, KV binding (no cron — the worker can't fit the parse)
```

To expand coverage, regenerate `channels.ts` from Debridio's catalog, or adjust
the alias generation in `matcher.ts` (e.g. add more word-substitutions) to close
specific gaps visible in `/__status` output.

## Debug endpoints

- `GET /` — landing page with install instructions.
- `GET /__status` — returns the latest MatchReport from KV: per-source HTTP/byte
  stats, parse-drop counts, matched/unmatched breakdown, completeness errors.
  Returns 503 if no refresh has completed yet (run the GitHub workflow).
- `GET /__refresh` — retired. Returns 410 with a pointer to the GitHub Action.
  Free-plan Cloudflare Workers can't fit the 200MB US feed parse in their 10ms
  CPU budget; the workflow does the same job in Node.

## Attribution

- [Debridio TV](https://debridio.com) — the upstream Stremio addon this wraps.
- [epg.pw](https://epg.pw) — free XMLTV EPG data source.
