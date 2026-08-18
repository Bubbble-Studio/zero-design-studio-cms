# Cloudinary → Cloudflare R2 migration runbook

**Repo:** `zero-design-studio-cms` (Strapi **4.13.1**) — the CMS behind
**zerodesignstudios.com**, served at `admin-server.zerodesignstudios.com`.

**Goal:** stop paying Cloudinary; serve all media from Cloudflare R2 behind a custom domain.

> **Scope note.** The ZCL marketplace (`zero-store`) is **already fully on R2** and is not
> affected by this migration. Only this CMS still uses Cloudinary
> (`@strapi/provider-upload-cloudinary`, cloud name `dccjqha6a`).

---

## Why this is low-risk

Two things were verified before writing this plan:

1. **No Cloudinary transformations are in use.** Sampled asset URLs contain no `w_`, `c_`,
   `q_`, `f_` or `dpr_` transform segments — they are plain `/image/upload/v<version>/<file>`
   URLs. This matters enormously: if the site relied on Cloudinary's on-the-fly resizing,
   plain R2 could not replace it (R2 is object storage with no image pipeline) and we would
   need Cloudflare Images instead. Because it does not, **R2 is a drop-in replacement**.
   *Re-confirm this across all content types before Phase 2 — see Step 0.3.*
2. **A working R2 setup already exists in the org.** `zero-store/strapi` runs the same
   pattern in production, so the provider config and env var names below are copied from a
   known-good deployment rather than invented.

---

## Target architecture

| | Now | After |
|---|---|---|
| Storage | Cloudinary | Cloudflare R2 bucket |
| Public URL | `res.cloudinary.com/dccjqha6a/...` | `cdn.zerodesignstudios.com/...` |
| Cost | Monthly Cloudinary bill | R2: **$0.015/GB-month, $0 egress** |

**Use a custom domain, not the `*.r2.dev` public URL.** Cloudflare rate-limits `r2.dev` and
does not recommend it for production traffic. A custom domain also means the URLs stored in
the database stay valid if the bucket ever moves.

> The store's existing bucket is currently served from
> `pub-a1e5741b07604a7694d0150710543b46.r2.dev`. Worth moving it behind a custom domain too,
> as a separate task.

---

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

### 1.1 Dependencies
```bash
npm uninstall @strapi/provider-upload-cloudinary
npm install strapi-provider-cloudflare-r2-aws   # ⚠ see compatibility note
```

> **⚠ Compatibility must be checked.** This repo is Strapi **4.13.1**, while the store runs
> Strapi 5. Confirm the installed provider version supports Strapi 4 (check its peer
> dependencies). If it does not, use the official **`@strapi/provider-upload-aws-s3@^4`**
> against R2's S3-compatible endpoint instead — R2 speaks the S3 API, so it works, but the
> config keys differ (`region: 'auto'`, plus a `baseUrl`/public-URL setting so stored URLs
> point at the custom domain rather than the S3 endpoint). Verify on a staging instance.

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
3. Rewrite `url`, **every entry in `formats`** (`thumbnail`, `small`, `medium`, `large` —
   each has its own `url`), `provider`, and `provider_metadata`.

**The `formats` column is the classic thing to miss.** Strapi stores responsive variants as
JSON; rewriting only the top-level `url` leaves thumbnails silently pointing at Cloudinary,
which then break the day the account is cancelled.

The script must be **idempotent** (safe to re-run — skip rows already on the CDN domain) and
have a **dry-run mode** that reports what it would change without writing.

**Do not delete anything from Cloudinary in this phase.** It is the rollback.

---

## Phase 3 — Rewrite embedded references

Cloudinary URLs also live outside the `files` table:

- **Rich text / markdown body fields** — editors paste image URLs inline. Search every
  long-text column for `res.cloudinary.com` and rewrite.
- **Hardcoded in the frontend** — confirmed: `zds-client`
  `src/lib/components/BubbleTeamLayout.svelte:94` pins the ZDS logo to
  `https://res.cloudinary.com/dccjqha6a/image/upload/v1701106728/zds_logo_ef2db07d5b.png`.
  This is a separate repo and needs its own PR.
- **Seed data / fixtures**, if any.

---

## Phase 4 — Verify and cut over

1. Crawl the live site for `res.cloudinary.com` — **expect zero hits**:
```bash
# spot-check the API surface
curl -s "$API/<collection>?populate=*&pagination[pageSize]=100" | grep -c "res.cloudinary.com"
```
2. Click through image-heavy pages (works, blogs, team) and confirm thumbnails *and*
   full-size images load.
3. Remove `res.cloudinary.com` from the CSP in `middlewares.ts`.
4. Leave the Cloudinary account active for a **grace period (2–4 weeks)** in case something
   was missed, then downgrade/cancel.

---

## Rollback

| Phase | Rollback |
|---|---|
| 1 | Revert the `plugins.ts` commit and redeploy. Assets uploaded to R2 in the meantime need re-pointing. |
| 2 | Restore the DB backup. Cloudinary still holds every original, so nothing is lost. |
| 4 | Do not cancel Cloudinary until the grace period passes. |

## Open items

- [ ] Asset count + total GB (Phase 0.1)
- [ ] Confirm provider package supports Strapi 4.13 (Phase 1.1)
- [ ] Confirm zero transformation URLs across all collections (Phase 0.3)
- [ ] Decide whether to move the store's bucket to a custom domain too
