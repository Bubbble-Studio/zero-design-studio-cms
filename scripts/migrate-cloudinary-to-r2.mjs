#!/usr/bin/env node
/**
 * Cloudinary → Cloudflare R2 migration for the Strapi `files` table.
 *
 *   node scripts/migrate-cloudinary-to-r2.mjs reconcile          # Cloudinary vs DB
 *   node scripts/migrate-cloudinary-to-r2.mjs content-scan       # Cloudinary URLs in content
 *   node scripts/migrate-cloudinary-to-r2.mjs content-migrate    # Phase 3: rewrite content URLs
 *   node scripts/migrate-cloudinary-to-r2.mjs preflight
 *   node scripts/migrate-cloudinary-to-r2.mjs migrate            # dry run (default)
 *   node scripts/migrate-cloudinary-to-r2.mjs migrate --execute
 *   node scripts/migrate-cloudinary-to-r2.mjs verify
 *   node scripts/migrate-cloudinary-to-r2.mjs rollback --execute
 *
 * Test-round scoping (any command that touches rows):
 *   --ids=12,57,301     only these files rows (or, with --table, these content rows)
 *   --limit=10          only the first N rows still on Cloudinary
 *   --table=works       content-migrate only: restrict to one content table
 *
 * Design notes (see docs/cloudinary-to-r2-migration.md):
 *  - R2 object keys mirror strapi-provider-cloudflare-r2@0.3.0 exactly (`pool: false`):
 *    the parent object is `<folder_path>/<hash><ext>` (no prefix at the root folder) and
 *    format variants are flat `<hash><ext>`, because Strapi passes no folderPath for
 *    them. The provider recomputes this key on delete, so any mismatch makes the Media
 *    Library's delete button silently miss the object.
 *  - `hash`, `ext` and `mime` are never modified — they are the key source of truth.
 *  - Every upload sets ContentType (R2 would otherwise serve
 *    application/octet-stream, making browsers download images instead of
 *    rendering them, and OG scrapers reject them).
 *  - Each row is only rewritten AFTER its bytes are confirmed present in R2,
 *    and the original values are appended to a ledger first, so a failed
 *    download can never leave a rewritten-but-broken row.
 *
 * Requires pg (a dependency) and an S3 SDK: aws-sdk v2 arrives with the Phase 1
 * provider; @aws-sdk/client-s3 (v3) is used instead when installed.
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
/** Reads `--name=value` or `--name value`. */
const flag = (name) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1];
};
const ONLY_IDS = flag('ids') ? new Set(flag('ids').split(',').map((x) => Number(x.trim())).filter(Boolean)) : null;
const LIMIT = flag('limit') ? Number(flag('limit')) : null;
const ONLY_TABLE = flag('table') ?? null;
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
      region: process.env.CLOUDFLARE_R2_REGION ?? 'auto',
      endpoint: cfg.endpoint,
      forcePathStyle: true,
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
      region: process.env.CLOUDFLARE_R2_REGION ?? 'auto',
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
// Tolerates a missing CLOUDFLARE_R2_PUBLIC_URL so read-only commands (preflight, the
// report) work before any R2 config exists — nothing can be on the CDN yet anyway.
const onCdn = (u) => {
  const base = process.env.CLOUDFLARE_R2_PUBLIC_URL?.replace(/\/$/, '');
  return Boolean(base) && typeof u === 'string' && u.startsWith(base);
};
/** Flat key — used for format variants, previews and content-only assets. */
const keyFor = (hash, ext) => `${hash}${ext ?? ''}`;
/**
 * Parent object key, identical to the provider's getPathKey(file, pool=false):
 * the Media Library folder path (e.g. "/3/7") becomes a key prefix, root has none.
 */
const parentKeyFor = (row) => {
  const fp = row.folder_path;
  const prefix = fp && fp !== '/' ? `${fp.replace(/^\//, '')}/` : '';
  return `${prefix}${row.hash}${row.ext ?? ''}`;
};
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
      return { buf, type: res.headers.get('content-type')?.split(';')[0] || undefined };
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
    `SELECT id, name, hash, ext, mime, size, url, preview_url, formats, provider, provider_metadata, folder_path
     FROM files ORDER BY id`
  );
  return rows;
}

/** Apply --ids / --limit to files rows. Without either flag, every row. */
function selectRows(rows) {
  let out = ONLY_IDS ? rows.filter((r) => ONLY_IDS.has(r.id)) : rows;
  if (ONLY_IDS && out.length !== ONLY_IDS.size) {
    const found = new Set(out.map((r) => r.id));
    console.log(`⚠ --ids not found in files: ${[...ONLY_IDS].filter((i) => !found.has(i)).join(', ')}`);
  }
  if (LIMIT) out = out.filter((r) => isCloudinary(r.url)).slice(0, LIMIT);
  if (ONLY_IDS || LIMIT) console.log(`scope: ${out.length} row(s) — ${out.map((r) => r.id).join(', ')}\n`);
  return out;
}

/** Every object this row needs in R2: parent + each format variant + preview. */
function planFor(row) {
  const items = [{ kind: 'parent', key: parentKeyFor(row), url: row.url, mime: row.mime }];
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
  const pending = rows.filter((r) => isCloudinary(r.url));
  const inFolders = pending.filter((r) => r.folder_path && r.folder_path !== '/');
  console.log(`rows inside Media Library folders: ${inFolders.length} (their parent keys carry the folder prefix)`);

  // A small test set that exercises every code path, for the first --execute.
  const pick = [];
  const add = (label, r) => { if (r && !pick.some((p) => p.r.id === r.id)) pick.push({ label, r }); };
  const fmtCount = (r) => Object.keys(parseJson(r.formats) || {}).length;
  add('image with every size variant', [...pending].filter((r) => r.mime?.startsWith('image/')).sort((a, b) => fmtCount(b) - fmtCount(a))[0]);
  add('video with a GIF preview', pending.find((r) => r.preview_url));
  add('video without preview', pending.find((r) => r.mime?.startsWith('video/') && !r.preview_url));
  add('non-media file (PDF etc.)', pending.find((r) => r.mime && !/^(image|video)\//.test(r.mime)));
  add('file inside a folder', inFolders[0]);
  add('large file (> 5 MB, multipart)', [...pending].sort((a, b) => Number(b.size) - Number(a.size)).find((r) => Number(r.size) > 5 * 1024));
  add('small image, no variants', pending.find((r) => r.mime?.startsWith('image/') && fmtCount(r) === 0));
  if (pick.length) {
    console.log('\nsuggested test round (covers every code path):');
    for (const { label, r } of pick) console.log(`  #${String(r.id).padEnd(6)} ${label.padEnd(32)} ${r.name}`);
    console.log(`\n  npm run migrate:dry-run -- --ids=${pick.map((p) => p.r.id).join(',')}`);
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
    let stage = 'download';
    try {
      const { buf, type } = await fetchWithRetry(it.url);
      stage = 'upload';
      await putObject(it.key, buf, it.mime || type);
      stage = 'verify';
      if (!(await existsInR2(it.key))) throw new Error(`post-upload HEAD failed for ${it.key}`);
      uploaded.push({ ...it, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16) });
    } catch (e) {
      e.stage = `${it.kind} ${stage} (${it.key})`;
      throw e;
    }
    continue;
  }

  // Build the rewritten row. hash/ext/mime are deliberately untouched.
  // Deep copy: pg hands jsonb back as a live object, and row.formats is what the ledger
  // records as "before". Mutating it in place made rollback restore the NEW variant URLs.
  const formats = structuredClone(parseJson(row.formats));
  if (formats) {
    for (const f of Object.values(formats)) {
      if (!f?.hash) continue;
      f.url = cdnUrl(keyFor(f.hash, f.ext));
      f.provider_metadata = null; // Cloudinary-specific; R2 provider writes none
    }
  }
  const next = {
    url: cdnUrl(parentKeyFor(row)),
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

/** aws-sdk v2 errors often have message === null; the useful part is in code/statusCode. */
function describeError(e) {
  return [e?.message, e?.code && `code=${e.code}`, e?.statusCode && `http=${e.statusCode}`, e?.stage && `at=${e.stage}`]
    .filter(Boolean).join(' ') || String(e);
}

async function pool(items, worker, limit) {
  const results = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results.push(await worker(items[idx])); }
      catch (e) { results.push({ id: items[idx].id, status: 'failed', error: describeError(e) }); }
    }
  }));
  return results;
}

async function migrate() {
  if (!EXECUTE) console.log('DRY RUN — no downloads, uploads or DB writes. Re-run with --execute to apply.\n');
  const rows = selectRows(await loadRows());
  const results = await pool(rows, migrateRow, CONCURRENCY);
  const by = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  if (ONLY_IDS || LIMIT) {
    for (const r of results) {
      console.log(`  #${r.id} ${r.status}${r.objects ? ` (${r.objects} objects)` : ''}${r.next ? ` → ${r.next.url}` : ''}`);
    }
  }
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
  const rows = selectRows(await loadRows());
  let bad = 0, checked = 0;
  for (const row of rows) {
    const urls = [row.url, row.preview_url, ...Object.values(parseJson(row.formats) || {}).map((f) => f?.url)].filter(Boolean);
    for (const u of urls) {
      checked++;
      if (isCloudinary(u)) { console.log(`  #${row.id} STILL CLOUDINARY: ${u}`); bad++; continue; }
      const res = await fetch(u, { method: 'HEAD' });
      if (!res.ok) { console.log(`  #${row.id} ${res.status} ${u}`); bad++; continue; }
      // A 200 served as octet-stream makes browsers download instead of render.
      const type = res.headers.get('content-type') || '';
      if (/octet-stream/.test(type) && /^(image|video)\//.test(row.mime || '')) {
        console.log(`  #${row.id} WRONG TYPE (${type}) ${u}`); bad++;
      }
    }
  }
  // A "no Cloudinary left" check alone would also pass on a 100% broken site,
  // which is why every URL is HEAD-checked for a real 200 above.
  console.log(`\nchecked ${checked} URLs, ${bad} bad`);
  if (bad) process.exitCode = 1;
}

async function rollback() {
  if (!existsSync(LEDGER)) throw new Error(`no ledger at ${LEDGER}`);
  let entries = readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // --ids scopes to files rows; --table (+ --ids) scopes to content rows.
  if (ONLY_TABLE) entries = entries.filter((e) => e.kind === 'content' && e.table === ONLY_TABLE && (!ONLY_IDS || ONLY_IDS.has(e.id)));
  else if (ONLY_IDS) entries = entries.filter((e) => e.kind !== 'content' && ONLY_IDS.has(e.id));
  const files = entries.filter((e) => e.kind !== 'content').length;
  console.log(`${entries.length} ledger entries — ${files} files row(s), ${entries.length - files} content row(s)${EXECUTE ? '' : ' (dry run)'}`);
  if (!EXECUTE) return;
  // Newest first, so a row migrated more than once ends at its very first "before".
  for (const e of entries.reverse()) {
    if (e.kind === 'content') {
      // Content entries share the ledger but describe another table entirely —
      // replaying them against `files` would null out unrelated rows.
      const cast = e.dataType === 'jsonb' || e.dataType === 'json' ? `::${e.dataType}` : '';
      await db.query(`UPDATE "${e.table}" SET "${e.column}" = $1${cast} WHERE id = $2`, [e.before, e.id]);
      continue;
    }
    await db.query(
      `UPDATE files SET url=$1, preview_url=$2, formats=$3::jsonb, provider=$4, provider_metadata=$5::jsonb WHERE id=$6`,
      [e.before.url, e.before.preview_url, e.before.formats == null ? null : JSON.stringify(parseJson(e.before.formats)),
       e.before.provider, e.before.provider_metadata == null ? null : JSON.stringify(parseJson(e.before.provider_metadata)), e.id]
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
  // Falls back to the names Strapi's own Cloudinary provider uses, which the Coolify
  // container already has — so nothing needs typing inline.
  const cloud = env('CLOUDINARY_CLOUD_NAME', process.env.CLOUDINARY_NAME);
  const auth = Buffer.from(
    `${env('CLOUDINARY_API_KEY', process.env.CLOUDINARY_KEY)}:${env('CLOUDINARY_API_SECRET', process.env.CLOUDINARY_SECRET)}`
  ).toString('base64');
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

const COMMANDS = { reconcile, 'content-scan': contentScan, 'content-migrate': contentMigrate, preflight, migrate, verify, rollback };
if (!COMMANDS[cmd]) {
  // Validate before connecting, so `--help` / a typo doesn't surface as a DB error.
  console.log('usage: node scripts/migrate-cloudinary-to-r2.mjs <command> [--execute] [--ids=1,2] [--limit=N] [--table=name]\n');
  console.log('  reconcile     Cloudinary inventory vs DB (read-only; needs DB + CLOUDINARY_* only)');
  console.log('  content-scan  find Cloudinary URLs pasted into content (read-only; DB only)');
  console.log('  content-migrate  Phase 3: rewrite content URLs (dry run unless --execute)');
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

/**
 * Scan every text-ish column in the database for Cloudinary URLs.
 *
 * `reconcile` only looks at the `files` table, so it cannot see a URL that was pasted
 * directly into a rich-text field. That matters for two reasons:
 *   1. Phase 3 has to rewrite those strings — the provider swap does not touch them.
 *   2. If the referenced asset has no `files` row (an orphan), it is never migrated and
 *      the page breaks the moment Cloudinary is cancelled.
 */
async function contentScan() {
  const { rows: cols } = await db.query(`
    SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name <> 'files'
      AND c.data_type IN ('text','character varying','jsonb','json')
    ORDER BY c.table_name, c.column_name`);

  // Everything the files table accounts for — anything outside this set is unbacked.
  const known = new Set(dbPublicIds(await loadRows()).keys());

  const hits = [];      // { table, column, id, publicId, backed }
  const scanned = new Set();
  const unscannable = []; // has Cloudinary URLs but no id column — content-migrate can't rewrite it
  for (const { table_name: t, column_name: c } of cols) {
    let res;
    try {
      res = await db.query(
        `SELECT id, "${c}"::text AS v FROM "${t}" WHERE "${c}"::text LIKE '%res.cloudinary.com%'`
      );
    } catch {
      // No id column (join/link tables). Never skip silently: count what we can't reach.
      const n = await db.query(`SELECT count(*)::int AS n FROM "${t}" WHERE "${c}"::text LIKE '%res.cloudinary.com%'`)
        .then((r) => r.rows[0].n).catch(() => 0);
      if (n) unscannable.push(`${t}.${c} (${n} row${n > 1 ? 's' : ''})`);
      continue;
    }
    if (res.rows.length) scanned.add(`${t}.${c}`);
    for (const row of res.rows) {
      for (const m of row.v.matchAll(CONTENT_URL_RE)) {
        hits.push({ table: t, column: c, id: row.id, publicId: m[2], backed: known.has(m[2]) });
      }
    }
  }

  const unbacked = hits.filter((h) => !h.backed);
  const places = [...new Set(hits.map((h) => `${h.table}.${h.column}`))];

  console.log(`\ntext columns scanned            : ${cols.length}`);
  console.log(`columns containing Cloudinary   : ${scanned.size}`);
  console.log(`Cloudinary URLs found in content: ${hits.length}`);
  console.log(`  ✔ backed by a files row       : ${hits.length - unbacked.length}  (Phase 3 rewrites these)`);
  console.log(`  ✖ NOT backed by any files row : ${unbacked.length}`);

  if (places.length) {
    console.log('\nwhere:');
    for (const p of places) console.log(`  ${p}  (${hits.filter((h) => `${h.table}.${h.column}` === p).length})`);
  }
  if (unbacked.length) {
    writeFileSync('content-unbacked.txt',
      unbacked.map((h) => `${h.table}.${h.column} row=${h.id} ${h.publicId}`).join('\n'));
    console.log('\n✖ No files row, so `migrate` never copies these. `content-migrate` copies them');
    console.log('  itself — but only while Cloudinary is still up, so run it before cancelling.');
    console.log('  Full list: content-unbacked.txt. Sample:');
    for (const h of unbacked.slice(0, 10)) console.log(`    ${h.table}.${h.column} row=${h.id}  ${h.publicId}`);
  } else {
    console.log('\n✔ Every Cloudinary URL in content is backed by a files row.');
    console.log('  Orphans in Cloudinary are unreferenced and safe to abandon at cancellation.');
  }
  if (unscannable.length) {
    console.log('\n⚠ Cloudinary URLs in tables WITHOUT an id column (not rewritten by content-migrate):');
    for (const u of unscannable) console.log(`    ${u}`);
    console.log('  Check these by hand before cancelling.');
    process.exitCode = 1;
  }
  console.log('\nNote: only the database is scanned. URLs hard-coded in frontend source code');
  console.log('(e.g. the logo in zds-client BubbleTeamLayout.svelte) must be updated separately.');
}

/**
 * A Cloudinary delivery URL embedded in content:
 *   https://res.cloudinary.com/<cloud>/<image|video|raw>/upload/[<transforms>/][v123/]<public_id>.<ext>
 * Group 1 = the segments between /upload/ and the public_id, 2 = public_id, 3 = ext.
 */
const CONTENT_URL_RE =
  /https?:\/\/res\.cloudinary\.com\/[^/]+\/(?:image|video|raw)\/upload\/((?:[^/"'\s]+\/)*?)([A-Za-z0-9_\-]+)(\.[A-Za-z0-9]+)/g;

async function contentColumns() {
  const { rows } = await db.query(`
    SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.table_name <> 'files'
      AND c.data_type IN ('text','character varying','jsonb','json')
    ORDER BY c.table_name, c.column_name`);
  return rows.filter((r) => !ONLY_TABLE || r.table_name === ONLY_TABLE);
}

/** public_id → the R2 key `migrate` writes for it. */
function keyIndex(rows) {
  const idx = new Map();
  for (const row of rows) {
    const pm = parseJson(row.provider_metadata);
    idx.set(pm?.public_id ?? row.hash, parentKeyFor(row));
    for (const f of Object.values(parseJson(row.formats) || {})) {
      if (!f?.hash) continue;
      const fpm = parseJson(f.provider_metadata);
      idx.set(fpm?.public_id ?? f.hash, keyFor(f.hash, f.ext));
    }
  }
  return idx;
}

/**
 * Where one embedded URL should point after migration.
 *  - plain URL of an asset that has a files row → the object `migrate` created for it
 *  - anything else → the exact bytes Cloudinary serves at that URL, copied to their own
 *    key. That covers assets with no files row, and transformed URLs (w_500/, c_scale,…),
 *    which must never share a key with the original or they would overwrite it.
 */
function contentTarget(full, segments, publicId, ext, idx) {
  const transformed = segments.split('/').filter(Boolean).some((seg) => !/^v\d+$/.test(seg));
  const mapped = idx.get(publicId);
  if (mapped && !transformed && mapped.endsWith(ext)) return { key: mapped, copy: false };
  if (!mapped && !transformed) return { key: `${publicId}${ext}`, copy: true, why: 'no files row' };
  const tag = createHash('sha1').update(full).digest('hex').slice(0, 12);
  return { key: `derived/${tag}/${publicId}${ext}`, copy: true, why: transformed ? 'transformed URL' : 'extension differs from stored file' };
}

/**
 * Phase 3 — rewrite Cloudinary URLs embedded in content.
 *
 * A row is rewritten only when EVERY object its URLs will point at exists in R2, so a
 * partial run (a test round, or content before files) can never leave a page linking to
 * a missing object — those rows are reported as blocked and left on Cloudinary.
 */
async function contentMigrate() {
  if (!EXECUTE) console.log('DRY RUN — no uploads or DB writes. Re-run with --execute to apply.\n');
  const idx = keyIndex(await loadRows());
  const cols = await contentColumns();
  if (ONLY_TABLE && !cols.length) throw new Error(`no text columns found for --table=${ONLY_TABLE}`);

  let rewritten = 0, urls = 0, copied = 0, blocked = 0;
  const copiedKeys = new Set();
  const present = new Map(); // key -> bool, cached HEADs

  const inR2 = async (key) => {
    if (copiedKeys.has(key)) return true;
    if (!present.has(key)) present.set(key, await existsInR2(key));
    return present.get(key);
  };

  for (const { table_name: t, column_name: c, data_type: dt } of cols) {
    let res;
    try {
      res = await db.query(`SELECT id, "${c}"::text AS v FROM "${t}" WHERE "${c}"::text LIKE '%res.cloudinary.com%'`);
    } catch { continue; }

    for (const row of res.rows) {
      if (ONLY_TABLE && ONLY_IDS && !ONLY_IDS.has(row.id)) continue;
      const matches = [...row.v.matchAll(CONTENT_URL_RE)];
      if (!matches.length) continue;
      urls += matches.length;

      const targets = matches.map(([full, seg, publicId, ext]) => ({ full, ...contentTarget(full, seg, publicId, ext, idx) }));

      // Objects `migrate` is responsible for must already be there.
      const missing = [];
      for (const tg of targets) if (!tg.copy && !(await inR2(tg.key))) missing.push(tg.key);
      if (missing.length) {
        blocked++;
        console.log(`  blocked ${t}.${c} row=${row.id}: ${missing.length} file(s) not migrated yet (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''})`);
        continue;
      }

      // Everything else is copied now, while Cloudinary is still up.
      for (const tg of targets) {
        if (!tg.copy || copiedKeys.has(tg.key)) continue;
        if (!EXECUTE) { console.log(`  would copy (${tg.why}): ${tg.key}  ← ${t}.${c} row=${row.id}`); copiedKeys.add(tg.key); copied++; continue; }
        if (!(await inR2(tg.key))) {
          const { buf, type } = await fetchWithRetry(tg.full);
          await putObject(tg.key, buf, type);
          if (!(await existsInR2(tg.key))) throw new Error(`post-upload HEAD failed for ${tg.key}`);
        }
        copiedKeys.add(tg.key); copied++;
        console.log(`  copied (${tg.why}): ${tg.key}`);
      }

      let i = 0;
      const next = row.v.replace(CONTENT_URL_RE, () => cdnUrl(targets[i++].key));
      if (next === row.v) continue;

      if (!EXECUTE) { rewritten++; console.log(`  would rewrite ${t}.${c} row=${row.id} (${matches.length} URL(s))`); continue; }
      appendFileSync(LEDGER, JSON.stringify({
        kind: 'content', table: t, column: c, dataType: dt, id: row.id, at: new Date().toISOString(), before: row.v,
      }) + '\n');
      const cast = dt === 'jsonb' || dt === 'json' ? `::${dt}` : '';
      await db.query(`UPDATE "${t}" SET "${c}" = $1${cast} WHERE id = $2`, [next, row.id]);
      rewritten++;
    }
  }

  console.log(`\nCloudinary URLs in scope  : ${urls}`);
  console.log(`objects ${EXECUTE ? 'copied' : 'to copy'}            : ${copied}`);
  console.log(`rows ${EXECUTE ? 'rewritten' : 'to rewrite'}           : ${rewritten}`);
  console.log(`rows blocked (files first): ${blocked}`);
  if (blocked) process.exitCode = EXECUTE ? 1 : 0;
  if (EXECUTE) console.log(`ledger: ${LEDGER}`);
}

await db.connect();
try {
  if (cmd === 'reconcile') await reconcile();
  else if (cmd === 'content-scan') await contentScan();
  else if (cmd === 'content-migrate') await contentMigrate();
  else if (cmd === 'preflight') await preflight();
  else if (cmd === 'migrate') await migrate();
  else if (cmd === 'verify') await verify();
  else if (cmd === 'rollback') await rollback();
  else { console.log('commands: reconcile | preflight | migrate | verify | rollback   (add --execute to write)'); process.exitCode = 1; }
} finally {
  await db.end();
}
