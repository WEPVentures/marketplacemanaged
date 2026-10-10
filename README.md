# Marketplace. Managed.

$5 flat managed Facebook Marketplace sales. Customers upload photos + details here, continue in Messenger (quote, $5 Stripe link, listing, negotiation), and keep 100% of the sale. Local pickup only.

**Stack:** Eleventy 3 (static, per-item pages at build time) · Netlify · Supabase (Postgres + Storage) · Stripe (links sent in Messenger — this site never takes payment).
**Out of scope here:** Messenger bot/webhooks, the agent that polls `intakes` and sends quotes, on-site checkout.

## Pages

| Path | What |
|---|---|
| `/` | Landing: hero, benefits, 3-step how-it-works, FAQ |
| `/upload/` | Intake form → Supabase → "Upload received" + **Continue in Messenger** → `https://m.me/<PAGE_NAME>?ref=intake-0042` |
| `/items/` | Browse active items |
| `/items/{item-id}/` | Per-item page (photos, price, condition, "Message us on Facebook" CTA, schema.org `Product` JSON-LD + OG tags) — the page Meta's catalog links to |

## Local dev

```bash
npm install
npm start          # http://localhost:8080
npm run build      # -> _site/
```

With no env vars set, items come from `data/items/*.json` (3 sample files — delete them once Supabase is live) and the upload form simulates a submit. To test against Supabase:

```bash
node --env-file=.env node_modules/.bin/eleventy --serve
```

## Environment variables (Netlify > Site settings > Environment variables)

| Var | Notes |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | anon / publishable key. Public by design (shipped to the browser); RLS is the protection. **Never put the service_role key in Netlify env for this site.** |
| `PAGE_NAME` | Facebook Page username for `m.me/<PAGE_NAME>` (Page doesn't exist yet; defaults to `MarketplaceManaged`) |
| `SITE_URL` | Canonical origin, e.g. `https://marketplacemanaged.com` (falls back to Netlify's `URL`) |

## Supabase setup

1. Create a project. In the SQL editor run, in order: `supabase/migrations/0001_schema.sql`, then `0002_build_hook.sql`. (Or `supabase db push`.) *These were written but not executed against a live project in this repo's session — run them on a scratch project first.*
2. Copy the project URL + anon key into Netlify env vars.

What the SQL creates:

- **`intakes`** — `id, ref (intake-0042), customer_name, title, description, condition, model_number, works, damage, included, photo_urls[], status (new|quoted|paid|listed|sold), quote_band, floor, created_at`. `photo_urls` holds **object paths** in the private bucket.
- **`items`** — `id (item-0042), intake_ref, title, description, price, condition, photo_urls[], status (active|sold), published_at`.
- **Buckets** — `intake-photos` (private, 10MB, images only) and `item-photos` (public).
- **RLS**
  - `intakes`: RLS on, **zero policies** → the public/anon key can't read or write it directly. The browser inserts only via the `submit_intake()` RPC (security definer; validates photo paths, constraints validate fields) which returns the ref.
  - `items`: anon can `select` only `status = 'active'`. Sold rows are invisible publicly. No public writes.
  - `intake-photos`: anon may **insert only**, and only to paths shaped `<uuid>/<n>-<16 hex>.<ext>` (non-guessable; no select/list policy so nothing is readable). `item-photos`: public read by URL, writes only with the service role.
- The processing agent uses the **service_role** key (bypasses RLS): reads intakes, sets `quote_band`/`floor`/`status`, copies hero/other photos from `intake-photos` into `item-photos`, then inserts the `items` row with `status='active'`.

## Build pipeline: how items become pages

`src/_data/items.js` loads active items at build time → Eleventy pagination (`src/items/item.njk`) emits one page per item at `/items/{id}/`. Sold/missing items simply have no page on the next build.

**Which event calls the build hook:** a DB trigger on `items` (`0002_build_hook.sql`, via `pg_net`) POSTs to the Netlify build hook when
1. an item row is **inserted with `status='active'`** (accepted/published → page appears), or
2. an active item is **updated** — in particular `status` → `sold` (page disappears), or price/photos/etc. change, or
3. an active item is **deleted**.

Setup: Netlify > Site settings > Build & deploy > Build hooks > create one, then run the `insert into private.config …` line from the top of `0002_build_hook.sql`. Result: ~1 minute from event to live page. (If you'd rather call it from the agent, just `POST` the same URL after writing the row and skip the trigger.)

**Supabase-at-build vs. JSON files in the repo.** Chosen: query Supabase at build (anon key, active rows only), with `data/items/*.json` as the fallback when env vars are absent.
- Supabase at build: single source of truth, no commits needed, the agent only writes to the DB. Cost: build depends on Supabase being up — so a fetch error *fails the build* and Netlify keeps serving the last good deploy.
- JSON in repo: no runtime dependency and a git audit trail, but the agent would need to commit/push per item and photos must live somewhere public anyway.

## Netlify deploy

1. Push this repo to GitHub; Netlify > Add new site > Import from GitHub. `netlify.toml` sets build `npm run build`, publish `_site`, Node 22.
2. Add the env vars above. Deploy.
3. Add the build hook (above). Later, point `marketplacemanaged.com` at the site (Domain management) and set `SITE_URL`.

## Notes / next

- Photos are downscaled client-side to ≤1600px JPEG before upload (HEIC falls back to the original file where the browser can't decode it).
- Basic spam defense is a honeypot field; add Cloudflare Turnstile or rate limiting before real traffic.
- Meta catalog: item URLs are stable (`/items/item-0042/`). If you want a feed (CSV/XML) generated at build from the same data, it's a ~20-line addition.
