# stream-live-tv-guide

A Cloudflare Worker that sits in front of the [Debridio TV](https://debridio.com) Stremio addon
and fills in the **live "Now playing"** description for Canadian TSN channels (TSN 1-5),
scraped from [tvpassport.com](https://www.tvpassport.com) every 10 minutes.

Debridio's TV catalog normally leaves channel descriptions empty. Install this worker
instead, and TSN channels show "Now: {title} -- {blurb} * Next: {title}" in Stremio.
Every other channel passes through untouched.

## Install in Stremio

You need your own Debridio TV addon URL (set up at <https://debridio.com>). It looks like:

```
https://tv.lb.debridio.com/<your-long-base64-token>/manifest.json
```

Take the `<your-long-base64-token>` portion, then install this in Stremio instead:

```
https://stream-live-tv-guide.matteo-beatstanzi.workers.dev/<your-long-base64-token>/manifest.json
```

That's it. TSN 1-5 descriptions will refresh automatically every 10 minutes.

## How it works

```
   Stremio  ->  this worker  ->  Debridio
                   |
                   v  (every 10 min)
              tvpassport.com
                   |
                   v
                Workers KV
```

- **Fetch handler**: every request is forwarded to Debridio. On JSON responses, the
  worker walks `metas[]` / `meta` and rewrites `description` for any matching TSN
  channel. Streams and other responses pass through unchanged.
- **Scheduled handler**: every 10 minutes the worker scrapes tvpassport for each of
  TSN 1-5, parses current/next programs in Toronto local time, and stores the result
  in Workers KV under key `states:v1`.
- **Multi-tenant**: the tvpassport data is the same for every user, so one scrape
  serves all Debridio tokens. Your token is only used as the upstream path to Debridio.

## Privacy

Your Debridio token is visible in the URL you install. Requests to this worker
transit through Cloudflare and are proxied to Debridio. If that's not acceptable,
self-host -- the source is below and the whole thing fits in ~300 lines.

## Self-hosting

```sh
git clone https://github.com/MatteoTanziCodes/stream-live-tv-guide.git
cd stream-live-tv-guide
npm install
npx wrangler login           # OAuth into your Cloudflare account
npx wrangler kv namespace create CHANNEL_STATE
#   -> copy the returned id into wrangler.toml
npx wrangler deploy
curl https://<your-worker>.workers.dev/__refresh   # warm KV immediately
```

`wrangler dev` runs it locally against remote KV. `wrangler tail` streams logs.

## Layout

```
src/
  worker.ts       fetch + scheduled handlers, proxy + rewrite logic
  kvcache.ts      KV read/write for channel state, invokes the scraper
  tvpassport.ts   scraper for tvpassport.com listings
  matcher.ts      match Debridio item -> our channel, build blurb
  channels.ts     the 5 TSN channels we enrich (edit to add more)
  types.ts        shared type definitions
wrangler.toml     worker name, KV binding, cron trigger
```

To enrich additional channels, add entries to `src/channels.ts` with the matching
tvpassport station slug. The matcher uses normalized names (case-insensitive,
alphanumeric-only) so "TSN 1" matches `TSN 1`, `TSN-1`, `tsn1`, etc.

## Debug endpoints

- `GET /` -- landing page with install instructions
- `GET /__refresh` -- synchronously re-runs the tvpassport scrape and updates KV.
  Harmless; used to warm the cache right after deploy instead of waiting for cron.

## Attribution

- [Debridio TV](https://debridio.com) -- the upstream Stremio addon this wraps.
- [tvpassport.com](https://www.tvpassport.com) -- listing data source.
