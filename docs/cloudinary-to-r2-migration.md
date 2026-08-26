# Cloudinary → Cloudflare R2 migration runbook

**Repo:** `zero-design-studio-cms` (Strapi **4.13.1**) — the CMS behind
**zerodesignstudios.com**, served at `admin-server.zerodesignstudios.com`.

**Goal:** stop paying Cloudinary; serve all media from Cloudflare R2 behind a custom domain.

> **Scope note.** The ZCL marketplace (`zero-store`) is **already fully on R2** and is not
> affected by this migration. Only this CMS still uses Cloudinary
> (`@strapi/provider-upload-cloudinary`, cloud name `dccjqha6a`).

---

## Risk assessment (revised after review)

Three reviewers checked this plan against the repos and a database dump. One premise in the
first draft was **wrong** and is corrected here.

### ✅ Images are safe — a plain R2 swap works
Of **1,383 distinct Cloudinary URLs** in the database dump, all but four are plain
`/upload/v<version>/<file>` with no transformation segments. For images, R2 is a drop-in.

### ❌ Video preview GIFs DO use Cloudinary transformations — and R2 cannot replace them
Four `files` rows (all videos) have a `preview_url` built by Cloudinary's video→animated-GIF
pipeline:
```
res.cloudinary.com/dccjqha6a/video/upload/c_scale,dl_200,vs_6,w_250/<name>.gif
```
`c_scale` + `w_250` resize, `vs_6` samples frames, `dl_200` sets frame delay. **Neither R2 nor
Cloudflare Images can generate an animated GIF from an MP4** — Cloudflare Images transforms
still images only. Escalating to Cloudflare Images does *not* solve this.

These are load-bearing, not dead data. `zds-client` renders them as a CSS background:
`src/routes/services/[slug]/+page.svelte:50` (`MainVideo.data.attributes.previewUrl`) and `:80`.

**Solved without ffmpeg.** The Cloudinary transform URL *renders and returns a real GIF*, so
while the account is still live the migration simply downloads that rendered result and stores it
as a static R2 object (`<hash>_preview.gif`). The script does this automatically. This only works
**before** cancellation — it is a hard ordering constraint.

Still true: any *new* video uploaded after the migration will have **no** `preview_url`, because
the R2 provider does not generate one. Decide whether that is acceptable or whether a Strapi
lifecycle hook should generate previews on upload.

### ✅ A proven R2 setup exists in the org
`zero-store/strapi` runs R2 in production — but see the provider warning in Phase 1: it is
**Strapi 5**, and its provider package does not support Strapi 4.

## Inventory

### Live, from production (read-only `preflight`, 2026-08-26)

| | |
|---|---|
| Rows in `files` | **379** |
| R2 objects to create | **1,736** (unique keys: 1,736, **0 collisions**) |
| Video preview GIFs | **4** |
| Already on the CDN | 0 |

> An earlier version of this section quoted **307 rows / 1,386 objects**. That came from
> `zds-backup`, a pg_dump taken **2025-01-19**, and was stale. Always measure with
> `preflight`, never from the dump.

### ⚠️ Unexplained gap: the DB references ~1,736 objects, Cloudinary reports ~4,500

Only 72 rows were added between the Jan-2025 dump and now, so **new uploads do not explain
the difference**. The remaining ~2,700 are most likely a mix of:

- **Orphans** — assets deleted from the Strapi Media Library but never removed from
  Cloudinary, uploads predating Strapi, or files uploaded directly to Cloudinary.
- **Derived resources** — Cloudinary counts each transformation variant it renders
  (e.g. the `c_scale,dl_200,vs_6,w_250` video previews) as a separate asset.
- Assets belonging to **other projects** sharing the same Cloudinary account.

**This must be resolved before cancelling Cloudinary**, because the migration uses the
database as its source of truth: anything Cloudinary holds that no row references will not
be copied to R2 and will 404 at cancellation.

```bash
CLOUDINARY_CLOUD_NAME=dccjqha6a CLOUDINARY_API_KEY=... CLOUDINARY_API_SECRET=... \
  node scripts/migrate-cloudinary-to-r2.mjs reconcile
```

| Bucket | Meaning | Action |
|---|---|---|
| **matched** | DB references it, Cloudinary has it | migrates normally |
| **orphans** — in Cloudinary, not in DB | see causes above | **will 404 after cancellation** — triage `reconcile-orphans.txt` |
| **missing** — in DB, not in Cloudinary | already broken on the live site today | fix or clear those rows |

### Structural facts (from the dump; re-confirmed by `preflight`)

- Production is **PostgreSQL** on Railway — `config/database.ts` merely *defaults* to sqlite.
- `files` columns: `url`, `preview_url`, `formats` (jsonb), `provider`, `provider_metadata`
  (jsonb), `hash`, `ext`, `mime`, `folder_path`.
- R2 keys are flat `<hash><ext>`; `preflight` reports **0 collisions** on live data.
- Cloudinary `public_id` equals the Strapi `hash` (variants are `<variant>_<hash>`).

**Cost stays negligible** — even at a few GB, R2 is $0.015/GB-month with free egress.

## Target architecture

| | Now | After |
|---|---|---|
| Storage | Cloudinary | Cloudflare R2 bucket |
| Public URL | `res.cloudinary.com/dccjqha6a/...` | `cdn.zerodesignstudios.com/...` |
| Cost | Monthly Cloudinary bill | R2: **$0.015/GB-month, $0 egress** |

**Use a custom domain, not the `*.r2.dev` public URL.** Cloudflare rate-limits `r2.dev` and
does not recommend it for production traffic. A custom domain also means the URLs stored in
the database stay valid if the bucket ever moves.

> The store's production bucket is served from `pub-a1e5741b07604a7694d0150710543b46.r2.dev`
> (verified against the live API). Note that `zero-store/strapi/.env` points at a *different*
> bucket (`zero-test`, `pub-9d14fac3aaa94d08baf1ecd26505af0a.r2.dev`) — local dev and prod
> differ, so don't assume the local `.env` reflects production. Moving the production bucket
> behind a custom domain is worth doing as a separate task.

---

## Running the script

The production database is private, so the script runs **inside the Strapi container**, where
`DATABASE_*` is already in the environment and `pg` is already installed. Nothing needs to be
passed for the DB connection — the script prints the host it connects to, so check that line.

### 1. Get the script onto the server
Merge this PR to the deployed branch and redeploy. The file then exists in the container at
`scripts/migrate-cloudinary-to-r2.mjs`. (Nothing in it runs at boot — it is only ever invoked
by hand.)

### 2. Open a shell in the container
Coolify → the Strapi application → **Terminal**.

### 3. Reconcile (read-only, safe on production)
```bash
CLOUDINARY_CLOUD_NAME=dccjqha6a \
CLOUDINARY_API_KEY=xxx \
CLOUDINARY_API_SECRET=xxx \
node scripts/migrate-cloudinary-to-r2.mjs reconcile
```
Key and secret: Cloudinary Console → Settings → Access Keys.

It writes `reconcile-orphans.txt` and `reconcile-missing.txt` into the working directory. A
container filesystem is ephemeral, so read them before the next deploy:
```bash
wc -l reconcile-orphans.txt reconcile-missing.txt
head -50 reconcile-orphans.txt
```

### 4. Later phases
`preflight` and `verify` are also read-only. `migrate` writes — take a `pg_dump` first and
run it against a restored copy before production. `migrate` additionally needs the
`CLOUDFLARE_R2_*` variables and `NEW_PROVIDER_NAME`; `@aws-sdk/client-s3` is declared as a
dependency so it is present in the container after a normal install.

> **Careful with the DB in this repo's `.env`.** It points at a Railway instance
> (`viaduct.proxy.rlwy.net`) that is publicly reachable but had **no writes for roughly a
> year**. It is either a leftover or a production copy that simply has not been edited.
> Either way, do not assume it is production — always confirm the `db:` line the script
> prints before running anything with `--execute`.

## Phase 0 — Inventory and prep (no changes)

0.1 **Size the library.** In the Cloudinary console, record total asset count and storage GB.
    This sets the migration runtime and the (small) R2 cost.

0.2 **Identify what is actually driving the bill** — storage, bandwidth, or transformations.
    If it is bandwidth, R2's zero-egress pricing removes it entirely.

0.3 **Re-verify no transformations are used**, across *every* content type, not just a sample:
```bash
# expect: no output
curl -s "$API/<collection>?populate=*&pagination[pageSize]=100" \
  | grep -oE "res\.cloudinary\.com/[^\"]*upload/[^\"/]*" | grep -E "/(w_|c_|q_|f_|dpr_)"
```
    If any are found, stop and reconsider Cloudflare Images for those assets.

0.4 **Create the R2 bucket** (e.g. `zds-media`) and an API token with Object Read & Write.

0.5 **Attach the custom domain** `cdn.zerodesignstudios.com` to the bucket
    (R2 → bucket → Settings → Custom Domains). Cloudflare creates the DNS record.

0.6 **Take a database backup.** Phase 2 rewrites rows in the `files` table.

---

## Phase 1 — Switch the provider (new uploads → R2)

Stops the bleeding immediately. Existing assets keep serving from Cloudinary, so this is
independently deployable and reversible.

### 1.1 Dependencies — provider choice is RESOLVED

**Do not use `strapi-provider-cloudflare-r2-aws`** (the package the store uses). Every published
version declares `peerDependencies: { "@strapi/strapi": ">=5.0.0" }`, so it will not install
against Strapi 4.13.1. Use its Strapi-4-compatible sibling:

```bash
npm install strapi-provider-cloudflare-r2@0.3.0
# keep @strapi/provider-upload-cloudinary installed until Phase 4 — see rollback
```

> **Fallback, if needed:** `@strapi/provider-upload-aws-s3@^4` also works against R2, but **not
> out of the box** — it sends `ACL: 'public-read'` on every PutObject and **R2 does not implement
> S3 ACLs**, so uploads fail with `NotImplemented`. You must pass `ACL: null` explicitly
> (`undefined` or omitting it does *not* work — the provider defaults it back to `public-read`;
> and `ACL: 'private'` makes Strapi sign URLs, defeating the public CDN). Full shape:
> ```ts
> providerOptions: {
>   baseUrl: 'https://cdn.zerodesignstudios.com',  // no trailing slash
>   s3Options: {
>     credentials: { accessKeyId, secretAccessKey },
>     region: 'auto',
>     endpoint: 'https://<account-id>.r2.cloudflarestorage.com',
>     forcePathStyle: true,
>     params: { Bucket, ACL: null },
>   },
> }
> ```
> Note `rootPath` is a key prefix, not a URL — it is not a substitute for `baseUrl`.

**`pool: false` is mandatory** with `strapi-provider-cloudflare-r2`: its `delete()` always uses
the folderPath-prefixed key, so `pool: true` would make deletions silently no-op and orphan
objects. (In the store's `-aws` package `pool` is ignored entirely — another reason that config
does not transfer verbatim.)

### 1.2 `config/plugins.ts`
Replace the `upload` block (leave `email`, `ezforms`, `seo` untouched):
```ts
upload: {
  config: {
    provider: 'strapi-provider-cloudflare-r2-aws',
    providerOptions: {
      credentials: {
        accessKeyId: env('CLOUDFLARE_R2_ACCESS_KEY_ID'),
        secretAccessKey: env('CLOUDFLARE_R2_SECRET_ACCESS_KEY'),
      },
      endpoint: env('CLOUDFLARE_R2_ENDPOINT'),
      params: { Bucket: env('CLOUDFLARE_R2_BUCKET') },
      // Stores the CDN URL instead of the R2 endpoint URL. Required for >5MB uploads.
      cloudflarePublicAccessUrl: env('CLOUDFLARE_R2_PUBLIC_URL'),
      pool: false,
    },
    actionOptions: { upload: {}, uploadStream: {}, delete: {} },
  },
},
```

### 1.3 Environment variables
```
CLOUDFLARE_R2_ACCESS_KEY_ID=...
CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
CLOUDFLARE_R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
CLOUDFLARE_R2_BUCKET=zds-media
CLOUDFLARE_R2_PUBLIC_URL=https://cdn.zerodesignstudios.com
```

### 1.4 `config/middlewares.ts` — CSP
Add the new host to **both** `img-src` and `media-src`, and **keep `res.cloudinary.com`
until Phase 2 is complete and verified**:
```ts
"img-src":   ["'self'", "data:", "blob:", "market-assets.strapi.io",
              "res.cloudinary.com", "cdn.zerodesignstudios.com"],
"media-src": ["'self'", "data:", "blob:", "market-assets.strapi.io",
              "res.cloudinary.com", "cdn.zerodesignstudios.com"],
```

### 1.5 Verify
Deploy, upload a test image in Strapi admin, confirm its URL is on
`cdn.zerodesignstudios.com` and renders on the site.

---

## Phase 2 — Migrate existing assets

Run against a **restored copy** of the database first. Never point the first run at prod.

For each row in the `files` table:
1. Download the current Cloudinary URL.
2. Upload to R2 under the same path/filename.
3. Rewrite, per row:
   - `url`
   - **every entry in `formats`** (`thumbnail`, `small`, `medium`, `large`) — each has its own
     `url` *and* its own `provider_metadata`
   - **`preview_url`** — ⚠️ omitted from the first draft. Only the 4 video rows use it, and they
     need the pre-generated GIFs (see Risk assessment). `SELECT count(*) FROM files WHERE
     preview_url IS NOT NULL` to confirm the set before and after.
   - `provider_metadata` → set to **NULL** (Cloudinary stores `{public_id, resource_type}`;
     neither R2 provider writes this field)
   - `provider` → the exact string the new provider writes for new uploads. Verify it against a
     Phase 1 test upload so you don't end up with two different values in one table.

   **Do NOT touch `hash`, `ext`, or `mime`.** The provider recomputes the R2 object key from
   `hash`+`ext` on every read *and delete* — "normalising" them orphans objects permanently.

**Object keys must match what the provider generates for new uploads**, or the Media Library's
delete button will silently no-op. With `strapi-provider-cloudflare-r2` + `pool: false` the
parent file key is `<folderPath sans leading slash>/<hash><ext>` while format variants live at
`<hash><ext>` in the bucket root — the asymmetry is real and must be reproduced. Write the
key-derivation rule down explicitly, and run a **pre-flight collision report** across all rows
and all format variants; **abort on any collision** rather than resolving it at runtime.

**Set `ContentType` from the row's `mime` on every upload** (parent and every variant). R2
defaults to `application/octet-stream`, which makes browsers download files instead of rendering
them and causes social scrapers to reject OG images. Also set
`CacheControl: public, max-age=31536000, immutable`.

**Order per row: download → verify bytes → upload → HEAD-verify in R2 → only then rewrite the
row**, committed per row. A failed download must never result in a rewritten URL. Log every row
to a state ledger (`pending/uploaded/verified/rewritten/failed` + checksum) — this doubles as the
row-level rollback record.

**Throttle:** bounded concurrency (5–8) with exponential backoff, downloading from the delivery
host (`res.cloudinary.com`), not the Admin API, which is hard rate-limited.

**The `formats` column is the classic thing to miss.** Strapi stores responsive variants as
JSON; rewriting only the top-level `url` leaves thumbnails silently pointing at Cloudinary,
which then break the day the account is cancelled.

**The script is written:** `scripts/migrate-cloudinary-to-r2.mjs`
(`preflight` | `migrate` | `verify` | `rollback`; writes nothing without `--execute`).
It is idempotent, resumable, bounded-concurrency, and ledgers every row before rewriting it.
Its key-derivation logic was exercised offline against the 307 rows in the (stale) dump and
produced 1,386 unique keys with no collisions — that is a **logic check only, not an
inventory**. `preflight` re-runs the same collision check against production, which is the
result that counts.

**Do not delete anything from Cloudinary in this phase.** It is the rollback.

---

## Phase 3 — Rewrite embedded references

Cloudinary URLs also live outside the `files` table:

- **Rich text / markdown body fields** — editors paste image URLs inline. Confirmed in the dump:
  **`works` (117 occurrences)** and **`blogs` (6)**, all plain URLs. Enumerate columns
  programmatically from `information_schema` rather than by hand, and remember Strapi 4 keeps
  **draft *and* published copies**, **`components_*` tables** (e.g. `components_elements_faq_items`)
  and **i18n locale copies** — all of which need the same sweep, using the *same* key map as
  Phase 2.
- **Hardcoded in the frontend** — confirmed: `zds-client`
  `src/lib/components/BubbleTeamLayout.svelte:94` pins the ZDS logo to
  `https://res.cloudinary.com/dccjqha6a/image/upload/v1701106728/zds_logo_ef2db07d5b.png`.
  This is a separate repo and needs its own PR.
- **Seed data / fixtures**, if any.

---

## Phase 4 — Verify and cut over

> ⚠️ **A "zero Cloudinary hits" check is not sufficient.** A script that rewrites every DB row
> but fails every upload also produces zero hits — and a 100% broken site. You need *positive*
> checks too.

1. **Purge the CDN cache first.** `zds-client` has a zone-purge endpoint at
   `src/routes/api/purge/+server.ts`; edge-cached HTML still contains the old URLs, so verifying
   before purging both false-positives and leaves real users on dead links.
2. **Negative check, against the DB** (authoritative — the REST API with `populate=*` only
   populates one level and misses media inside components such as `shared/seo` `metaImage`):
```sql
SELECT count(*) FROM files
WHERE url LIKE '%cloudinary%'
   OR CAST(formats AS TEXT) LIKE '%cloudinary%'
   OR preview_url LIKE '%cloudinary%';   -- expect 0
```
3. **Positive check:** for every `url`, every `formats[*].url` and every `preview_url`, `HEAD`
   returns **200** with a `Content-Type` matching the row's `mime`.
4. **Three-way reconciliation:** Cloudinary asset count (Phase 0.1) vs R2 object count vs
   distinct DB URLs. Explain any delta before proceeding.
5. Click through image-heavy pages (works, blogs, team, services) and confirm thumbnails,
   full-size images **and the four video preview GIFs** all render.
3. Remove `res.cloudinary.com` from the CSP in `middlewares.ts`.
4. Leave the Cloudinary account active for a **grace period (2–4 weeks)** in case something
   was missed, then cancel.

**Decision on old links: internal only.** Every URL stored in the database and in content is
rewritten to R2, and Cloudinary is then **cancelled**. Cloudinary URLs previously shared
externally (og:image on old social posts, Google Images results) will 404 — this was accepted
deliberately. Nobody but Cloudinary can redirect `res.cloudinary.com`, so the only alternative
would have been keeping the account alive on the free tier.

---

## Rollback

| Phase | Rollback |
|---|---|
| 1 | Revert the `plugins.ts` commit and redeploy. Assets uploaded to R2 in the meantime need re-pointing. |
| 2 | Replay the **row-level ledger** (original `url`/`formats`/`preview_url`/`provider_metadata` dumped before each rewrite). ⚠️ Restoring the whole DB backup instead would discard every content edit made since — on a live CMS that is a second incident, not a rollback. Cloudinary still holds every original. |
| 4 | Do not cancel Cloudinary until the grace period passes. |

## Open items

- [ ] **Get the real asset count** — run `reconcile`. The dump-derived figure (307 rows /
      1,386 objects) was stale by many months; Cloudinary reports ~4,500 assets.
- [ ] **Triage orphans** from `reconcile-orphans.txt` — these will 404 after cancellation
- [ ] **Triage missing** from `reconcile-missing.txt` — already broken today
- [ ] Re-confirm `folder_path` is still `/` for all rows (affects R2 key derivation)
- [x] ~~Confirm provider supports Strapi 4.13~~ → resolved: use `strapi-provider-cloudflare-r2@0.3.0`
- [x] ~~Confirm zero transformation URLs~~ → resolved: **4 video preview GIFs DO use transforms**
- [x] ~~Pre-generate the 4 video GIFs with ffmpeg~~ → not needed; the script downloads the
      rendered GIF from Cloudinary. **Must run before cancellation.** Still open: policy for
      preview GIFs on *future* video uploads.
- [x] ~~Confirm the production database engine~~ → **PostgreSQL**. Use `pg_dump`; test the
      restore into a scratch DB before Phase 2.
- [ ] Set bucket **CORS** (admin media preview, any `fetch`/canvas use)
- [ ] Prove `cdn.zerodesignstudios.com` serves a test object **before** the Phase 1 deploy —
      otherwise every post-deploy upload stores a URL that 404s, and those rows are not covered
      by Phase 2
- [ ] Announce an **editorial freeze** on media deletes/replaces between the Phase 1 deploy and
      Phase 4 sign-off (Strapi calls the *configured* provider on delete, so deleting a
      not-yet-migrated Cloudinary asset orphans it), plus a delta pass for rows with
      `updated_at > migration_start`
- [ ] Check Cloudinary **account-level auto-optimisation** (`f_auto`/`q_auto` defaults never
      appear in the URL). If enabled, you are served WebP/AVIF today and R2 will serve original
      JPEG/PNG — a real LCP regression. Mitigate with Cloudflare Polish on the `cdn.` hostname.
- [x] Accepted the **SEO cost**: image URLs change, Google Images signals reset, and already-shared
      `og:image` links break once Cloudinary is cancelled. Cloudinary offers no redirects, so
      consider a grace period longer than 2–4 weeks.
- [ ] **`zds-backup` (1.8 MB DB dump) is committed to this repo.** It contains 1,386 Cloudinary
      URLs and full table data — review it for PII/secrets and consider removing it from version
      control independently of this migration.
- [ ] Regenerate `package-lock.json` on the Phase 1 dependency swap
- [ ] Decide whether to move the store's bucket to a custom domain too
