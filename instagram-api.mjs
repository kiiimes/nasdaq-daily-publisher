#!/usr/bin/env node
// Official API only. No refresh, scheduler, hosting, generation or live configuration.
// Public assets must be immutable: a preflight hash cannot eliminate the interval
// between this download and Meta's later download. Never overwrite a published URL.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export const ACCOUNT = 'daily.nasdaq.kr';
const MAX_JPEG = 8 * 1024 * 1024;
const STATES = new Set(['ready', 'in_progress', 'posted', 'blocked']);
export class PublishError extends Error {
  constructor(code, uncertain = false) { super(code); this.name = 'PublishError'; this.code = code; this.uncertain = uncertain; }
  toJSON() { return { status: 'blocked', code: this.code, uncertain: this.uncertain, ...(this.blocked ? { blocked: true } : {}), ...(this.block_persist_failed ? { block_persist_failed: true } : {}) }; }
}
const fail = code => { throw new PublishError(code); };
const plain = x => x && typeof x === 'object' && !Array.isArray(x);
export function validateConfig(input) {
  if (!plain(input)) fail('invalid_config');
  const { host, version, ig_user_id, username, access_token } = input;
  if (!['graph.facebook.com', 'graph.instagram.com'].includes(host)) fail('invalid_api_host');
  if (typeof version !== 'string' || !/^v[1-9]\d{1,2}\.0$/.test(version)) fail('explicit_api_version_required');
  if (typeof ig_user_id !== 'string' || !/^[1-9]\d{0,30}$/.test(ig_user_id)) fail('numeric_ig_user_id_required');
  if (username !== ACCOUNT) fail('unexpected_config_account');
  if (typeof access_token !== 'string' || access_token.length < 16 || /\s/.test(access_token) || /placeholder|replace[_ -]?me|your[_ -]?(access|token)|changeme|^secret$|^<|^example$/i.test(access_token)) fail('usable_token_required');
  return Object.freeze({ host, version, ig_user_id, username, access_token });
}
export function validatePublicUrl(value) {
  let u; try { u = new URL(value); } catch { fail('invalid_asset_url'); }
  const h = u.hostname.toLowerCase();
  // Reject all literal IPs, including alternative IPv4 spellings normalized by URL.
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || isIP(h.replace(/^\[|\]$/g, '')) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) || /(?:^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(h)) fail('non_public_asset_url');
  return u;
}
function validJob(job, id) {
  if (!plain(job) || job.id !== id || job.account !== ACCOUNT || !path.isAbsolute(job.edition || '') || !Array.isArray(job.images) || job.images.length < 2 || job.images.length > 20 || typeof job.caption !== 'string' || path.dirname(job.caption) !== job.edition || path.basename(job.caption) !== 'caption.txt') fail('invalid_watcher_job');
  if (!/^\d{4}-\d{2}-\d{2}-.+cards$/.test(path.basename(job.edition))) fail('invalid_edition');
  job.images.forEach((image, i) => { if (typeof image !== 'string' || path.dirname(image) !== job.edition || path.basename(image) !== `${String(i + 1).padStart(2, '0')}.png`) fail('invalid_png_order'); });
}
export function validateManifest(manifest, job, id) {
  validJob(job, id);
  if (!plain(manifest) || manifest.job_id !== id || !Array.isArray(manifest.files) || manifest.files.length !== job.images.length || manifest.files.length < 2 || manifest.files.length > 20) fail('invalid_manifest');
  const edition = path.basename(job.edition);
  if (manifest.edition !== undefined && manifest.edition !== edition) fail('manifest_edition_mismatch');
  let parent;
  const files = manifest.files.map((f, i) => {
    const name = `${String(i + 1).padStart(2, '0')}.jpg`, pngname = path.basename(job.images[i]);
    if (!plain(f) || f.name !== name || typeof f.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(f.sha256)) fail('invalid_jpeg_order_or_hash');
    // Explicit source mapping is optional: canonical 01.jpg always maps to 01.png.
    if ((f.pngname !== undefined && f.pngname !== pngname) || (f.source_name !== undefined && f.source_name !== pngname)) fail('png_jpeg_mapping_mismatch');
    const u = validatePublicUrl(f.url);
    let decoded; try { decoded = decodeURIComponent(u.pathname); } catch { fail('invalid_asset_path'); }
    if (decoded.includes('\\') || decoded.includes('\0') || path.posix.basename(decoded) !== name || path.posix.basename(path.posix.dirname(decoded)) !== edition) fail('asset_edition_or_name_mismatch');
    const group = `${u.origin}${path.posix.dirname(u.pathname)}`;
    if (parent !== undefined && parent !== group) fail('mixed_asset_editions');
    parent = group;
    return Object.freeze({ name, pngname, url: u.href, sha256: f.sha256.toLowerCase() });
  });
  return files;
}
function validCaption(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 2200) fail('invalid_job_caption');
  return value.trim();
}
function permalink(value) {
  let u; try { u = new URL(value); } catch { fail('invalid_permalink'); }
  if (u.protocol !== 'https:' || !['www.instagram.com', 'instagram.com'].includes(u.hostname) || u.port || u.username || u.password || u.search || u.hash || !/^\/p\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)) fail('invalid_permalink');
  return `https://www.instagram.com${u.pathname.replace(/\/$/, '')}/`;
}
function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Conservatively allow IPv6 global unicast only, excluding documentation range.
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:db8:/i.test(address) && !/^2001:(?:0:|10:|20:)/i.test(address);
}
async function limitedBytes(response, max) {
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > max) fail('response_too_large');
  if (!response.body?.getReader) fail('unreadable_response');
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > max) fail('response_too_large'); chunks.push(Buffer.from(value)); }
    return Buffer.concat(chunks, length);
  } finally { try { await reader.cancel(); } catch {} }
}
function boundedNumber(value, fallback, minimum, maximum) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < minimum || n > maximum) fail('invalid_publisher_limits');
  return n;
}
export function createPublisher(input, options = {}) {
  const config = validateConfig(input);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const resolveHost = options.resolveHost ?? (host => lookup(host, { all: true, verbatim: true }));
  const requestMs = boundedNumber(options.requestTimeoutMs, 15000, 1, 30000);
  const pollMs = boundedNumber(options.pollIntervalMs, 2000, 1, 10000);
  const containerMs = boundedNumber(options.containerTimeoutMs, 120000, 1, 180000);
  const receiptAttempts = boundedNumber(options.receiptAttempts, 3, 1, 5);
  const operationMs = boundedNumber(options.operationTimeoutMs, 600000, 1, 900000);
  const verifyAssets = options.verifyAssets !== false;
  async function bounded(action, code = 'request_failed') {
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([action(controller.signal), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PublishError('request_timeout')); }, requestMs); })]);
    } catch (e) { if (e instanceof PublishError) throw e; throw new PublishError(code); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async function graph(id, method = 'GET', params = {}) {
    if (typeof id !== 'string' || !/^[1-9]\d*(?:\/(?:media|media_publish))?$/.test(id)) fail('invalid_graph_id');
    const u = new URL(`https://${config.host}/${config.version}/${id}`);
    const headers = { Authorization: `Bearer ${config.access_token}` };
    let body;
    if (method === 'GET') for (const [k,v] of Object.entries(params)) u.searchParams.set(k, v);
    else { body = new URLSearchParams(params).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    return bounded(async signal => {
      const response = await fetchImpl(u.href, { method, headers, body, redirect: 'error', signal });
      if (!response.ok) throw new PublishError(`graph_http_${Number.isInteger(response.status) ? response.status : 0}`);
      let result; try { result = JSON.parse((await limitedBytes(response, 256 * 1024)).toString('utf8')); } catch (e) { if (e instanceof PublishError) throw e; fail('invalid_graph_json'); }
      if (!plain(result) || result.error) fail('graph_api_error');
      return result;
    });
  }
  function resultId(data) { if (typeof data.id !== 'string' || !/^[1-9]\d*$/.test(data.id)) fail('missing_graph_id'); return data.id; }
  async function check() {
    const result = await graph(config.ig_user_id, 'GET', { fields: 'id,username' });
    if (result.id !== config.ig_user_id || result.username !== config.username) fail('account_identity_mismatch');
    return { status: 'verified', username: result.username, ig_user_id: result.id, host: config.host, version: config.version };
  }
  function dryRun(jobId, manifest, job, caption) {
    if (job.status !== 'ready') fail('job_not_ready');
    const files = validateManifest(manifest, job, jobId);
    const text = validCaption(caption);
    return { status: 'dry_run', job_id: jobId, username: ACCOUNT, host: config.host, version: config.version, edition: path.basename(job.edition), images: files.map(({name,pngname,sha256}) => ({name,pngname,sha256})), caption_codepoints: [...text].length, asset_hash_verification: verifyAssets, network: false, claimed: false };
  }
  async function verifyAsset(file) {
    const u = validatePublicUrl(file.url);
    await bounded(async signal => {
      let addresses; try { addresses = await resolveHost(u.hostname); } catch { fail('asset_dns_failed'); }
      if (!Array.isArray(addresses) || !addresses.length || addresses.some(x => !publicAddress(typeof x === 'string' ? x : x.address))) fail('asset_dns_not_public');
      // Deliberately no graph authorization headers or cookies on asset requests.
      const response = await fetchImpl(u.href, { method: 'GET', redirect: 'error', credentials: 'omit', signal });
      if (!response.ok) fail('asset_download_failed');
      const bytes = await limitedBytes(response, MAX_JPEG);
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) fail('asset_not_jpeg');
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) fail('asset_hash_mismatch');
    }, 'asset_request_failed');
  }
  async function poll(id, deadline) {
    const start = Number(now()); const max = Math.min(120, Math.ceil(containerMs / pollMs) + 1);
    for (let attempt = 0; attempt < max; attempt++) {
      if (Number(now()) >= deadline || Number(now()) - start >= containerMs) fail('container_timeout');
      const result = await graph(id, 'GET', { fields: 'status_code,status' });
      if (result.status_code === 'FINISHED') return;
      if (['ERROR','EXPIRED'].includes(result.status_code)) fail('container_failed');
      if (!['IN_PROGRESS','PUBLISHED'].includes(result.status_code)) fail('unknown_container_status');
      if (attempt + 1 < max) await sleep(pollMs);
    }
    fail('container_timeout');
  }
  async function publish(jobId, manifest, { watcher, readCaption } = {}) {
    let claimed = false, publishRequested = false;
    try {
      if (!watcher || ['status','claim','markBlocked','markPosted'].some(k => typeof watcher[k] !== 'function') || typeof readCaption !== 'function') fail('watcher_adapter_required');
      // Wrong-account tokens cannot even claim a local job.
      await check();
      let state; try { state = await watcher.status(); } catch { fail('watcher_status_failed'); }
      if (!plain(state) || state.account !== ACCOUNT || !Array.isArray(state.jobs)) fail('invalid_watcher_state');
      const ready = state.jobs.find(j => j.id === jobId);
      if (!ready || ready.status !== 'ready') fail('job_not_ready');
      validateManifest(manifest, ready, jobId);
      if (state.jobs.some(j => j.id !== jobId && STATES.has(j.status) && (j.trade_date === ready.trade_date || j.fingerprint === ready.fingerprint))) fail('duplicate_watcher_job');
      let reservation; try { reservation = await watcher.claim(jobId); } catch { fail('watcher_claim_failed'); }
      claimed = true;
      if (reservation?.status !== 'claimed' || !reservation.job) fail('invalid_claim');
      const job = reservation.job;
      const files = validateManifest(manifest, job, jobId);
      if (job.fingerprint !== ready.fingerprint || job.trade_date !== ready.trade_date || job.edition !== ready.edition || JSON.stringify(job.images) !== JSON.stringify(ready.images) || job.caption !== ready.caption) fail('claimed_job_changed');
      let caption; try { caption = validCaption(await readCaption(job)); } catch (e) { if (e instanceof PublishError) throw e; fail('caption_read_failed'); }
      const deadline = Number(now()) + operationMs;
      const budget = () => { if (Number(now()) >= deadline) fail('operation_timeout'); };
      if (verifyAssets) for (const file of files) { budget(); await verifyAsset(file); }
      const children = [];
      for (const file of files) {
        budget();
        const child = resultId(await graph(`${config.ig_user_id}/media`, 'POST', { is_carousel_item: 'true', image_url: file.url }));
        await poll(child, deadline); children.push(child);
      }
      budget();
      const parent = resultId(await graph(`${config.ig_user_id}/media`, 'POST', { media_type: 'CAROUSEL', children: children.join(','), caption }));
      await poll(parent, deadline); budget();
      // The only publish attempt. Set uncertainty before invoking fetch, even if
      // the connection fails: a server may have accepted it without a response.
      publishRequested = true;
      const mediaId = resultId(await graph(`${config.ig_user_id}/media_publish`, 'POST', { creation_id: parent }));
      let url;
      for (let attempt = 0; attempt < receiptAttempts; attempt++) {
        budget();
        try {
          const receipt = await graph(mediaId, 'GET', { fields: 'permalink,caption' });
          if (typeof receipt.caption !== 'string' || receipt.caption.trim() !== caption) fail('published_caption_mismatch');
          url = permalink(receipt.permalink); break;
        } catch (e) {
          if (e instanceof PublishError && e.code === 'published_caption_mismatch') throw e;
          if (attempt + 1 === receiptAttempts) fail('publication_unconfirmed');
          await sleep(Math.min(pollMs, 1000));
        }
      }
      if (!url) fail('publication_unconfirmed');
      try { await watcher.markPosted(jobId, url); } catch { fail('posted_state_persist_failed'); }
      return { status: 'posted', job_id: jobId, username: ACCOUNT, media_id: mediaId, url, verified_at: new Date(Number(now())).toISOString() };
    } catch (e) {
      const safe = new PublishError(e instanceof PublishError ? e.code : 'publisher_failed', publishRequested);
      if (claimed) {
        try { await watcher.markBlocked(jobId, `${safe.code}; uncertain=${safe.uncertain}; manual investigation required; never automatically retry`); safe.blocked = true; }
        catch { safe.block_persist_failed = true; }
      }
      throw safe;
    }
  }
  return Object.freeze({ check, dryRun, publish });
}

export async function loadCredentials(root) {
  const dir = path.join(root, '.instagram-api'), target = path.join(dir, 'credentials.json');
  try {
    const r = await fs.lstat(root), d = await fs.lstat(dir), f = await fs.lstat(target);
    if (!r.isDirectory() || r.isSymbolicLink() || !d.isDirectory() || d.isSymbolicLink() || (d.mode & 0o777) !== 0o700 || !f.isFile() || f.isSymbolicLink() || (f.mode & 0o777) !== 0o600 || f.size > 16384) fail('insecure_credentials_permissions');
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return validateConfig(JSON.parse(await handle.readFile('utf8'))); } finally { await handle.close(); }
  } catch (e) {
    if (e instanceof PublishError) throw e;
    if (e?.code === 'ENOENT') fail('credentials_missing_not_ready');
    fail('credentials_unreadable');
  }
}
async function localJob(root, id) {
  // Read-only: unlike watcher.status(), dry-run does not acquire/create a lock.
  let state; try { state = JSON.parse(await fs.readFile(path.join(root, '.instagram-auto', 'state.json'), 'utf8')); } catch { fail('watcher_state_unreadable'); }
  if (state.version !== 1 || state.account !== ACCOUNT || state.root !== root || !plain(state.jobs)) fail('invalid_watcher_state');
  const job = state.jobs[id]; if (!job) fail('job_not_ready'); validJob(job, id);
  if (path.dirname(job.edition) !== path.join(root, 'editions')) fail('edition_outside_project');
  return job;
}
async function readLocalCaption(root, job) {
  validJob(job, job.id);
  if (path.dirname(job.edition) !== path.join(root, 'editions')) fail('edition_outside_project');
  for (const target of [path.join(root,'editions'),job.edition,job.caption]) { const s = await fs.lstat(target); if (s.isSymbolicLink()) fail('caption_symlink'); }
  const s = await fs.stat(job.caption); if (!s.isFile() || s.size > 20000) fail('invalid_caption_file');
  const bytes = await fs.readFile(job.caption); const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) fail('invalid_caption_utf8');
  return text;
}
export async function runCli(args, { root = path.dirname(fileURLToPath(import.meta.url)), fetchImpl, watcherFactory, publisherOptions = {} } = {}) {
  root = path.resolve(root);
  const [command, id, manifestPath] = args;
  if (!((command === 'check' && args.length === 1) || (['dry-run','publish'].includes(command) && args.length === 3))) fail('usage_check_or_dry_run_or_publish_job_manifest');
  const config = await loadCredentials(root);
  const publisher = createPublisher(config, { ...publisherOptions, ...(fetchImpl ? {fetchImpl} : {}) });
  if (command === 'check') return publisher.check();
  let manifest; try { const s = await fs.stat(manifestPath); if (!s.isFile() || s.size > 65536) fail('invalid_manifest_file'); manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch (e) { if (e instanceof PublishError) throw e; fail('manifest_unreadable'); }
  if (command === 'dry-run') { const job = await localJob(root, id); return publisher.dryRun(id, manifest, job, await readLocalCaption(root, job)); }
  let watcher; try { const factory = watcherFactory ?? (await import('./instagram-watch.mjs')).createWatcher; watcher = factory(root); } catch { fail('watcher_load_failed'); }
  return publisher.publish(id, manifest, { watcher, readCaption: job => readLocalCaption(root, job) });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runCli(process.argv.slice(2)))); }
  catch (e) { console.error(JSON.stringify(e instanceof PublishError ? e.toJSON() : new PublishError('cli_failed').toJSON())); process.exitCode = 1; }
}
