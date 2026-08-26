#!/usr/bin/env node
/**
 * Cloudinary → Cloudflare R2 migration for the Strapi `files` table.
 *
 *   node scripts/migrate-cloudinary-to-r2.mjs reconcile          # Cloudinary vs DB
 *   node scripts/migrate-cloudinary-to-r2.mjs preflight
 *   node scripts/migrate-cloudinary-to-r2.mjs migrate            # dry run (default)
 *   node scripts/migrate-cloudinary-to-r2.mjs migrate --execute
 *   node scripts/migrate-cloudinary-to-r2.mjs verify
 *   node scripts/migrate-cloudinary-to-r2.mjs rollback --execute
 *
 * Design notes (see docs/cloudinary-to-r2-migration.md):
 *  - R2 object keys are derived from `hash` + `ext`, NOT from the Cloudinary URL,
 *    because the Strapi provider recomputes the key on every read and delete.
 *    Get this wrong and the Media Library's delete button silently no-ops.
 *  - `hash`, `ext` and `mime` are never modified — they are the key source of truth.
 *  - Every upload sets ContentType (R2 would otherwise serve
 *    application/octet-stream, making browsers download images instead of
 *    rendering them, and OG scrapers reject them).
 *  - Each row is only rewritten AFTER its bytes are confirmed present in R2,
 *    and the original values are appended to a ledger first, so a failed
 *    download can never leave a rewritten-but-broken row.
 *
 * Requires: npm i pg @aws-sdk/client-s3
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';

/**
 * Strapi loads .env itself at boot; a standalone script does not. Without this the
 * DATABASE_* fallbacks below silently point at localhost/strapi and you get a
 * confusing `database "strapi" does not exist`. Real environment variables still
 * win over .env, so CI/one-off overrides keep working.
 */
function loadDotEnv() {
  const file = new URL('../.env', import.meta.url);
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'preflight';
const EXECUTE = argv.includes('--execute');
const LEDGER = process.env.MIGRATION_LEDGER ?? 'migration-ledger.jsonl';
const CONCURRENCY = Number(process.env.MIGRATION_CONCURRENCY ?? 6);

const env = (k, fallback) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${k}`);
  return v;
};

/**
 * R2 config is resolved lazily so that read-only commands (`reconcile`,
 * `rollback`) run with nothing but database credentials — they never touch R2.
 */
let _cdn, _bucket, _provider, _s3;
const cdn = () => (_cdn ??= env('CLOUDFLARE_R2_PUBLIC_URL').replace(/\/$/, ''));
const bucket = () => (_bucket ??= env('CLOUDFLARE_R2_BUCKET'));
/**
 * Must match the string the configured provider writes for NEW uploads.
 * Do a Phase 1 test upload and read files.provider from that row before running
 * with --execute, otherwise the table ends up with two different values.
 */
const providerName = () => (_provider ??= env('NEW_PROVIDER_NAME', 'strapi-provider-cloudflare-r2'));

/**
 * S3 client adapter. Uses @aws-sdk/client-s3 (v3) when present, otherwise falls back
 * to aws-sdk (v2), which `strapi-provider-cloudflare-r2` installs in Phase 1. Neither
 * is a declared dependency of this repo on purpose: adding one desyncs
 * package-lock.json and breaks `npm ci` in the nixpacks build.
 *
 * If neither is available (i.e. you are running `migrate` before Phase 1), install one
 * ad-hoc in the container first:  npm i --no-save @aws-sdk/client-s3
 */
async function s3() {
  if (_s3) return _s3;
  const cfg = {
    endpoint: env('CLOUDFLARE_R2_ENDPOINT'),
    accessKeyId: env('CLOUDFLARE_R2_ACCESS_KEY_ID'),
    secretAccessKey: env('CLOUDFLARE_R2_SECRET_ACCESS_KEY'),
  };
  try {
    const { S3Client, PutObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const c = new S3Client({
      region: 'auto',
      endpoint: cfg.endpoint,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
    _s3 = {
      sdk: 'v3',
      // R2 implements no S3 ACLs, so none is sent.
      put: (Key, Body, ContentType) =>
        c.send(new PutObjectCommand({
          Bucket: bucket(), Key, Body, ContentType: ContentType || 'application/octet-stream',
          CacheControl: 'public, max-age=31536000, immutable',
        })),
      head: (Key) => c.send(new HeadObjectCommand({ Bucket: bucket(), Key })),
    };
  } catch {
    const AWS = (await import('aws-sdk')).default ?? (await import('aws-sdk'));
    const c = new AWS.S3({
      endpoint: cfg.endpoint,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: 'auto',
      signatureVersion: 'v4',
      s3ForcePathStyle: true,
    });
    _s3 = {
      sdk: 'v2',
      put: (Key, Body, ContentType) =>
        c.putObject({
          Bucket: bucket(), Key, Body, ContentType: ContentType || 'application/octet-stream',
          CacheControl: 'public, max-age=31536000, immutable',
        }).promise(),
      head: (Key) => c.headObject({ Bucket: bucket(), Key }).promise(),
    };
  }
  return _s3;
}

const db = new pg.Client(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false }
    : {
        host: env('DATABASE_HOST', 'localhost'),
        port: Number(env('DATABASE_PORT', '5432')),
        database: env('DATABASE_NAME', 'strapi'),
        user: env('DATABASE_USERNAME', 'strapi'),
        password: env('DATABASE_PASSWORD', 'strapi'),
      }
);

const isCloudinary = (u) => typeof u === 'string' && u.includes('res.cloudinary.com');
const onCdn = (u) => typeof u === 'string' && u.startsWith(cdn());
/** Flat key: folder_path is "/" for every row in this dataset. */
const keyFor = (hash, ext) => `${hash}${ext ?? ''}`;
const previewKeyFor = (hash) => `${hash}_preview.gif`;
const cdnUrl = (key) => `${cdn()}/${key}`;

async function fetchWithRetry(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      // Cloudinary stores some preview_urls as http:// — force https.
      const res = await fetch(url.replace(/^http:\/\//, 'https://'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('empty body');
      return buf;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw new Error(`download failed after ${tries} tries: ${url} (${lastErr?.message})`);
}

async function putObject(key, body, contentType) {
  await (await s3()).put(key, body, contentType);
}

async function existsInR2(key) {
  try { await (await s3()).head(key); return true; }
  catch { return false; }
}

const parseJson = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

async function loadRows() {
  const { rows } = await db.query(
    `SELECT id, name, hash, ext, mime, url, preview_url, formats, provider, provider_metadata, folder_path
     FROM files ORDER BY id`
  );
  return rows;
}

/** Every object this row needs in R2: parent + each format variant + preview. */
function planFor(row) {
  const items = [{ kind: 'parent', key: keyFor(row.hash, row.ext), url: row.url, mime: row.mime }];
  const formats = parseJson(row.formats) || {};
  for (const [name, f] of Object.entries(formats)) {
    if (!f?.hash) continue;
    items.push({ kind: `format:${name}`, key: keyFor(f.hash, f.ext), url: f.url, mime: f.mime });
  }
  if (row.preview_url) {
    // The transform URL renders a real GIF; we store that rendered result as a
    // static object. No ffmpeg needed — but only while Cloudinary is still up.
    items.push({ kind: 'preview', key: previewKeyFor(row.hash), url: row.preview_url, mime: 'image/gif' });
  }
  return items;
}

async function preflight() {
  const rows = await loadRows();
  const keys = new Map();
  let objects = 0, alreadyDone = 0, needsWork = 0, previews = 0;
  const collisions = [];
  for (const row of rows) {
    if (onCdn(row.url)) alreadyDone++; else if (isCloudinary(row.url)) needsWork++;
    for (const it of planFor(row)) {
      objects++;
      if (it.kind === 'preview') previews++;
      const prev = keys.get(it.key);
      if (prev && prev !== row.id) collisions.push({ key: it.key, rows: [prev, row.id] });
      keys.set(it.key, row.id);
    }
  }
  console.log(`rows                 : ${rows.length}`);
  console.log(`  already on CDN     : ${alreadyDone}`);
  console.log(`  still on Cloudinary: ${needsWork}`);
  console.log(`objects to create    : ${objects} (unique keys: ${keys.size}, previews: ${previews})`);
  console.log(`key collisions       : ${collisions.length}`);
  if (collisions.length) {
    for (const c of collisions.slice(0, 20)) console.log(`  !! ${c.key} <- rows ${c.rows.join(', ')}`);
    console.log('\nABORT: resolve collisions before migrating — two rows would overwrite one object.');
    process.exitCode = 1;
  }
  console.log(`\nprovider string that will be written: ${providerName()}`);
  console.log('Verify that against a Phase 1 test upload before running --execute.');
}

async function migrateRow(row) {
  if (onCdn(row.url)) return { id: row.id, status: 'skipped' };
  if (!isCloudinary(row.url)) return { id: row.id, status: 'skipped-unknown-host' };

  const items = planFor(row);
  const uploaded = [];

  for (const it of items) {
    if (!it.url) continue;
    if (await existsInR2(it.key)) { uploaded.push({ ...it, reused: true }); continue; }
    if (!EXECUTE) { uploaded.push({ ...it, planned: true }); continue; }
    const buf = await fetchWithRetry(it.url);
    await putObject(it.key, buf, it.mime);
    if (!(await existsInR2(it.key))) throw new Error(`post-upload HEAD failed for ${it.key}`);
    uploaded.push({ ...it, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16) });
  }

  // Build the rewritten row. hash/ext/mime are deliberately untouched.
  const formats = parseJson(row.formats);
  if (formats) {
    for (const f of Object.values(formats)) {
      if (!f?.hash) continue;
      f.url = cdnUrl(keyFor(f.hash, f.ext));
      f.provider_metadata = null; // Cloudinary-specific; R2 provider writes none
    }
  }
  const next = {
    url: cdnUrl(keyFor(row.hash, row.ext)),
    preview_url: row.preview_url ? cdnUrl(previewKeyFor(row.hash)) : null,
    formats: formats ? JSON.stringify(formats) : null,
    provider: providerName(),
    provider_metadata: null,
  };

  if (!EXECUTE) return { id: row.id, status: 'dry-run', objects: uploaded.length, next };

  // Ledger BEFORE the write, so rollback is always possible.
  appendFileSync(LEDGER, JSON.stringify({
    id: row.id, at: new Date().toISOString(),
    before: { url: row.url, preview_url: row.preview_url, formats: row.formats, provider: row.provider, provider_metadata: row.provider_metadata },
    after: next, objects: uploaded,
  }) + '\n');

  await db.query(
    `UPDATE files SET url=$1, preview_url=$2, formats=$3::jsonb, provider=$4, provider_metadata=$5 WHERE id=$6`,
    [next.url, next.preview_url, next.formats, next.provider, next.provider_metadata, row.id]
  );
  return { id: row.id, status: 'migrated', objects: uploaded.length };
}

async function pool(items, worker, limit) {
  const results = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results.push(await worker(items[idx])); }
      catch (e) { results.push({ id: items[idx].id, status: 'failed', error: e.message }); }
    }
  }));
  return results;
}

async function migrate() {
  if (!EXECUTE) console.log('DRY RUN — no downloads, uploads or DB writes. Re-run with --execute to apply.\n');
  const rows = await loadRows();
  const results = await pool(rows, migrateRow, CONCURRENCY);
  const by = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  console.log('\nresult:', by);
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) {
    console.log('\nFAILED rows (safe to re-run — the script is idempotent):');
    for (const f of failed.slice(0, 25)) console.log(`  #${f.id}: ${f.error}`);
    process.exitCode = 1;
  }
  if (EXECUTE) console.log(`\nledger: ${LEDGER}`);
}

async function verify() {
  const rows = await loadRows();
  let bad = 0, checked = 0;
  for (const row of rows) {
    const urls = [row.url, row.preview_url, ...Object.values(parseJson(row.formats) || {}).map((f) => f?.url)].filter(Boolean);
    for (const u of urls) {
      checked++;
      if (isCloudinary(u)) { console.log(`  #${row.id} STILL CLOUDINARY: ${u}`); bad++; continue; }
      const res = await fetch(u, { method: 'HEAD' });
      if (!res.ok) { console.log(`  #${row.id} ${res.status} ${u}`); bad++; }
    }
  }
  // A "no Cloudinary left" check alone would also pass on a 100% broken site,
  // which is why every URL is HEAD-checked for a real 200 above.
  console.log(`\nchecked ${checked} URLs, ${bad} bad`);
  if (bad) process.exitCode = 1;
}

async function rollback() {
  if (!existsSync(LEDGER)) throw new Error(`no ledger at ${LEDGER}`);
  const entries = readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log(`${entries.length} ledger entries${EXECUTE ? '' : ' (dry run)'}`);
  if (!EXECUTE) return;
  for (const e of entries.reverse()) {
    await db.query(
      `UPDATE files SET url=$1, preview_url=$2, formats=$3::jsonb, provider=$4, provider_metadata=$5::jsonb WHERE id=$6`,
      [e.before.url, e.before.preview_url, e.before.formats, e.before.provider, e.before.provider_metadata, e.id]
    );
  }
  console.log('rolled back (R2 objects left in place — harmless, and reused on re-run)');
}


/**
 * Reconcile what Cloudinary actually holds against what the database references.
 *
 * The DB is the migration's source of truth, so anything in Cloudinary that no
 * row points at will NOT be migrated and dies at cancellation. Run this before
 * Phase 2 and treat a large orphan count as a stop-and-investigate signal.
 */
async function cloudinaryInventory() {
  const cloud = env('CLOUDINARY_CLOUD_NAME');
  const auth = Buffer.from(`${env('CLOUDINARY_API_KEY')}:${env('CLOUDINARY_API_SECRET')}`).toString('base64');
  const all = new Map(); // public_id -> {type, bytes}
  for (const type of ['image', 'video', 'raw']) {
    let cursor;
    do {
      const u = new URL(`https://api.cloudinary.com/v1_1/${cloud}/resources/${type}`);
      u.searchParams.set('max_results', '500');
      if (cursor) u.searchParams.set('next_cursor', cursor);
      const res = await fetch(u, { headers: { Authorization: `Basic ${auth}` } });
      if (!res.ok) throw new Error(`Cloudinary ${type}: HTTP ${res.status} ${await res.text()}`);
      const body = await res.json();
      for (const r of body.resources ?? []) all.set(r.public_id, { type, bytes: r.bytes ?? 0 });
      cursor = body.next_cursor;
    } while (cursor);
    console.log(`  fetched ${type}: running total ${all.size}`);
  }
  return all;
}

/** Every Cloudinary public_id the database expects to exist. */
function dbPublicIds(rows) {
  const ids = new Map(); // public_id -> row id
  for (const row of rows) {
    const pm = parseJson(row.provider_metadata);
    ids.set(pm?.public_id ?? row.hash, row.id);
    for (const f of Object.values(parseJson(row.formats) || {})) {
      if (!f) continue;
      const fpm = parseJson(f.provider_metadata);
      ids.set(fpm?.public_id ?? f.hash, row.id);
    }
  }
  return ids;
}

async function reconcile() {
  const rows = await loadRows();
  const expected = dbPublicIds(rows);
  const actual = await cloudinaryInventory();

  const orphans = [...actual.keys()].filter((id) => !expected.has(id));
  const missing = [...expected.keys()].filter((id) => !actual.has(id));
  const orphanBytes = orphans.reduce((n, id) => n + (actual.get(id)?.bytes ?? 0), 0);

  console.log(`\nDB rows                        : ${rows.length}`);
  console.log(`Referenced by DB (public_ids)  : ${expected.size}`);
  console.log(`Present in Cloudinary          : ${actual.size}`);
  console.log(`  ✔ matched                    : ${expected.size - missing.length}`);
  console.log(`  ⚠ in Cloudinary, NOT in DB   : ${orphans.length}  (${(orphanBytes / 1048576).toFixed(1)} MB)`);
  console.log(`  ✖ in DB, MISSING in Cloudinary: ${missing.length}`);

  writeFileSync('reconcile-orphans.txt', orphans.join('\n'));
  writeFileSync('reconcile-missing.txt', missing.join('\n'));
  console.log('\nwrote reconcile-orphans.txt / reconcile-missing.txt');

  if (missing.length) {
    console.log('\n✖ MISSING assets are already broken on the live site today —');
    console.log('  the DB points at them but Cloudinary does not have them. Sample:');
    for (const id of missing.slice(0, 10)) console.log(`    ${id}  (row ${expected.get(id)})`);
  }
  if (orphans.length) {
    console.log('\n⚠ ORPHANS will NOT be migrated and will 404 after cancellation.');
    console.log('  Usually: assets deleted in Strapi but left in Cloudinary, uploads that');
    console.log('  predate Strapi, or files pasted straight into rich text. Grep the DB for');
    console.log('  any of these public_ids before cancelling. Sample:');
    for (const id of orphans.slice(0, 10)) console.log(`    ${id}`);
  }
}

const COMMANDS = { reconcile, preflight, migrate, verify, rollback };
if (!COMMANDS[cmd]) {
  // Validate before connecting, so `--help` / a typo doesn't surface as a DB error.
  console.log('usage: node scripts/migrate-cloudinary-to-r2.mjs <command> [--execute]\n');
  console.log('  reconcile  Cloudinary inventory vs DB (read-only; needs DB + CLOUDINARY_* only)');
  console.log('  preflight  collision + readiness check (read-only)');
  console.log('  migrate    copy to R2 and rewrite rows   (dry run unless --execute)');
  console.log('  verify     HEAD-check every URL is a real 200');
  console.log('  rollback   restore rows from the ledger  (dry run unless --execute)');
  process.exit(1);
}

const target = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL).host
  : `${process.env.DATABASE_HOST ?? 'localhost'}:${process.env.DATABASE_PORT ?? 5432}/${process.env.DATABASE_NAME ?? 'strapi'}`;
console.log(`db: ${target}\n`);

await db.connect();
try {
  if (cmd === 'reconcile') await reconcile();
  else if (cmd === 'preflight') await preflight();
  else if (cmd === 'migrate') await migrate();
  else if (cmd === 'verify') await verify();
  else if (cmd === 'rollback') await rollback();
  else { console.log('commands: reconcile | preflight | migrate | verify | rollback   (add --execute to write)'); process.exitCode = 1; }
} finally {
  await db.end();
}
