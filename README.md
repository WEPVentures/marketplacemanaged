# Marketplace. Managed.

$5 flat managed Facebook Marketplace sales. The whole intake happens in **Facebook Messenger**: the customer taps **Start** on the site, lands in a thread with us, sends photos, answers a few questions, and gets a price range. Our assistant then sends a $5 Stripe payment link in the chat, creates the listing, handles buyers and negotiation. The seller keeps 100% of the sale and hands the item over at local pickup.

**The site is the read surface** (marketing + inventory). **Messenger is the write surface** (intake + transaction). There is deliberately **no form, no file input and no upload** on the site, so we never hold unreviewed customer photos: they stay on Meta's infrastructure until the customer approves a listing, and only then are reviewed photos copied to our public `item-photos` bucket.

**Stack:** Eleventy 3 (static, per-item pages at build time) · Netlify · Supabase (Postgres + public item photos) · Stripe (links sent in Messenger; the site never takes payment).
**Out of scope here:** the Messenger bot/webhooks and the intake-processing agent (separate workstream), and any on-site checkout.

## Pages

| Path | What |
|---|---|
| `/` | Landing: hero, benefits, 3-step how it works, FAQ. **Start** button (above the fold, repeated after the how-it-works strip) → `https://m.me/<PAGE_NAME>?ref=site-start` |
| `/items/` | Browse active items |
| `/items/{item-id}/` | Per-item page generated at build time (photos, title, description, price, condition, "Message us on Facebook to arrange local pickup" → `m.me/<PAGE_NAME>?ref=<item-id>`, schema.org `Product` JSON-LD, OG tags). These are the URLs Meta's catalog links to. |
| `/privacy/`, `/terms/` | Supplied copy lives in `src/privacy.njk` / `src/terms.njk` |

## Local dev

```bash
npm install
npm start          # http://localhost:8080
npm run build      # -> _site/
```

With no env vars, items come from `data/items/*.json` (3 sample files; delete them once Supabase is live). To build against Supabase: `node --env-file=.env node_modules/.bin/eleventy --serve`.

## Environment variables

Set in Netlify > Project configuration > Environment variables. Leave "Contains secret values" **unchecked** for these (they are public values, and the build needs to read them).

| Var | Notes |
|---|---|
| `SUPABASE_URL` | Project URL. Build-time only. |
| `SUPABASE_ANON_KEY` | anon / publishable key. Build-time only; RLS limits it to `items` with `status='active'`. **Never put the service_role key in Netlify.** |
| `PAGE_NAME` | Facebook Page handle for `m.me/<PAGE_NAME>`. One variable drives every Start / Message link — if the handle changes, edit it here and redeploy. |
| `SITE_URL` | Canonical origin, e.g. `https://marketplacemanaged.com`. |
| `SECRETS_SCAN_OMIT_KEYS` | `SUPABASE_URL,SUPABASE_ANON_KEY,SITE_URL,PAGE_NAME` so Netlify's secret scanner doesn't fail the build on public values. |
| Netlify build hook URL | Not an env var of the site. Create it in Netlify (Build & deploy > Build hooks) and store it in the database: `insert into private.config (key, value) values ('netlify_build_hook', 'https://api.netlify.com/build_hooks/XXXX') on conflict (key) do update set value = excluded.value;` |

## Supabase setup

Run in the SQL editor (or `supabase db push`), in order:

1. `supabase/migrations/0001_schema.sql` — tables, RLS, buckets. *(Historical: also created the browser-upload path that 0003 removes.)*
2. `supabase/migrations/0002_build_hook.sql` — trigger that calls the Netlify build hook.
3. `supabase/migrations/0003_messenger_only.sql` — removes `submit_intake()` and the anon upload policy, reshapes `intakes` for Messenger.
4. `supabase/migrations/0004_retention.sql` — daily `pg_cron` job (03:17 UTC) that enforces the privacy policy's 90-day rule (unlisted `new`/`quoted` intakes deleted; unlisted `paid` intakes scrubbed to a minimal record; `listed`/`sold` kept) and `delete_customer_data(psid)` for on-request deletion (service_role only; returns item photo paths so the caller can delete the files from `item-photos` via the Storage API).
5. **Dashboard > Storage:** delete the unused private `intake-photos` bucket (empty it first; Supabase doesn't allow deleting buckets via SQL). After step 3 a fresh project should end with only `item-photos`.

Resulting schema:

- **`items`** (published; the only table the site reads): `id (item-0042), intake_ref, title, description, price, condition, photo_urls[], status (active|sold), published_at`.
- **`intakes`** (created and managed by the Messenger agent; the site never touches it): `id, ref (intake-0042), messenger_psid, customer_name, title, description, condition, model_number, works, damage, included, photo_refs[], status (new|quoted|paid|listed|sold), quote_band, floor, created_at`. Detail fields are nullable because they arrive over several messages. `photo_refs` are references to photos held by Meta, not files on our infrastructure.
- **Storage:** `item-photos` (public) holds only reviewed, customer-approved listing photos. Public bucket: readable by URL, not listable; no public write policy, so only the service role can write. There is no intake-photos bucket.
- **RLS:**
  - `items`: anon/authenticated may `select` only rows with `status = 'active'`. No public writes.
  - `intakes`: RLS on with **zero policies**. The public key can't read or write it.
  - The Messenger agent uses the **service_role** key (bypasses RLS): creates intakes, publishes items (copying approved photos into `item-photos` and inserting an `items` row with `status='active'`), and marks them `sold`.

## Build pipeline: how items become pages

`src/_data/items.js` loads active items at build time → Eleventy pagination (`src/items/item.njk`) emits `/items/{id}/` per item. Sold or missing items have no page after the next build.

**Which event calls the build hook:** a trigger on `items` (`0002_build_hook.sql`, via `pg_net`) POSTs to the Netlify build hook when
1. an item row is **inserted with `status='active'`** (accepted/published → page appears),
2. an active item is **updated** — notably `status` → `sold` (page disappears), or price/photos/etc. change,
3. an active item is **deleted**.

Result: ~1 minute from event to live page. (Alternatively the agent can `POST` the same hook URL after writing; skip the trigger in that case.)

**Supabase at build vs. JSON files in the repo.** Chosen: query Supabase at build time (anon key, active rows only), with `data/items/*.json` as the fallback when the env vars are absent.
- Supabase at build: single source of truth; the agent only writes to the DB; no commits needed. Cost: builds depend on Supabase being up — a fetch error *fails the build*, so Netlify keeps serving the last good deploy.
- JSON in repo: no runtime dependency and a git audit trail, but the agent would have to commit and push per item, and photos need a public home anyway.

## Netlify deploy

1. Push to GitHub; Netlify > Add new site > Import from GitHub. `netlify.toml` sets `npm run build`, publish `_site`, Node 22.
2. Add the env vars above and deploy. Point the domain at it (Domain management) and set `SITE_URL`.
3. Create the build hook and store its URL in `private.config` (see env var table).

Asset URLs (`style.css?v=<hash>`) change whenever the file changes, so a deploy reaches phones on the first reload.

## Notes

- Meta catalog: item URLs are stable (`/items/item-0042/`). A product feed (CSV/XML) generated at build from the same data is a small addition if needed.
- `/privacy/` and `/terms/` hold the supplied copy (`src/privacy.njk`, `src/terms.njk`).
