#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const ACCOUNT = 'daily.nasdaq.kr';
const STABLE_MS = 120_000, MAX_AGE_MS = 120 * 3600_000;
const DIR = /^(\d{4}-\d{2}-\d{2})-.+cards$/;
const NUMERIC_PNG = /^\d+\.png$/i;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const errorText = e => e instanceof Error ? e.message : String(e);
function dateInfo(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('Invalid trade date');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value) throw Error('Invalid trade date');
  if ([0, 6].includes(date.getUTCDay())) throw Error('Weekend trade date');
  return date;
}
function nyParts(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
function checkDate(tradeDate, now) {
  dateInfo(tradeDate);
  const n = nyParts(now);
  const today = `${n.year}-${n.month}-${n.day}`;
  if (tradeDate > today || (tradeDate === today && Number(n.hour) < 16)) throw Error('Trade date has not closed in America/New_York');
  // Compute that date's 16:00 New York close using its own DST offset.
  const anchor = Date.parse(`${tradeDate}T16:00:00Z`), closeParts = nyParts(new Date(anchor));
  const represented = Date.parse(`${closeParts.year}-${closeParts.month}-${closeParts.day}T${closeParts.hour}:${closeParts.minute}:00Z`);
  const close = anchor - (represented - anchor);
  if (+now - close > MAX_AGE_MS) throw Error('Trade date is stale (>120h since regular close)');
}
function pngSize(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw Error('Invalid PNG signature/IHDR');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}
function publicJob(j) {
  const { observation, firstSeen, observations, lastSeen, ...publicFields } = j;
  return publicFields;
}
export function createWatcher(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const clock = options.clock || (() => new Date());
  const stateDir = path.join(root, '.instagram-auto');
  const stateFile = path.join(stateDir, 'state.json');
  const lockDir = path.join(stateDir, 'lock');
  async function regular(target, type = 'file') {
    const relative = path.relative(root, target);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw Error('Path escapes project');
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('Project root must be a real directory');
    let current = root;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw Error('Symlinks are not allowed');
      if (current !== target && !stat.isDirectory()) throw Error('Invalid path ancestor');
    }
    const stat = await fs.lstat(target);
    if (type === 'dir' ? !stat.isDirectory() : !stat.isFile()) throw Error(`Expected ${type}: ${path.basename(target)}`);
    return stat;
  }
  async function prepare() {
    await regular(root, 'dir');
    try { await fs.mkdir(stateDir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await regular(stateDir, 'dir');
    await fs.chmod(stateDir, 0o700);
  }
  async function save(state) {
    const temp = path.join(stateDir, `state-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temp, stateFile);
      const dir = await fs.open(stateDir, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { if (handle) await handle.close(); await fs.rm(temp, { force: true }); }
  }
  async function transaction(action) {
    await prepare();
    try { await fs.mkdir(lockDir, { mode: 0o700 }); }
    catch (e) { if (e.code === 'EEXIST') throw Error('Watcher lock exists; another process or crashed run requires manual investigation. Never automatically clear it.'); throw e; }
    try { return await action(); } finally { await fs.rmdir(lockDir); }
  }
  async function load() {
    await regular(stateFile);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (state.version !== 1 || state.account !== ACCOUNT || state.root !== root || !Array.isArray(state.baseline) || !state.jobs || typeof state.jobs !== 'object') throw Error('Invalid watcher state');
    return state;
  }
  async function directories() {
    const editions = path.join(root, 'editions');
    await regular(editions, 'dir');
    return (await fs.readdir(editions, { withFileTypes: true })).filter(e => e.isDirectory() && DIR.test(e.name)).map(e => e.name).sort();
  }
  async function inspect(name) {
    const match = DIR.exec(name);
    if (!match || path.basename(name) !== name) throw Error('Invalid edition directory name');
    const edition = path.join(root, 'editions', name);
    await regular(edition, 'dir');
    const now = new Date(clock());
    const tradeDate = match[1]; checkDate(tradeDate, now);
    const entries = await fs.readdir(edition, { withFileTypes: true });
    if (entries.some(e => e.isSymbolicLink())) throw Error('Edition contains symlink');
    const numbers = entries.filter(e => NUMERIC_PNG.test(e.name)).map(e => e.name).sort();
    if (numbers.length < 2 || numbers.length > 20) throw Error('Need 2..20 numbered PNGs');
    const expected = Array.from({length: numbers.length}, (_, i) => `${String(i + 1).padStart(2, '0')}.png`);
    if (JSON.stringify(numbers) !== JSON.stringify(expected)) throw Error('PNG sequence must be contiguous 01..N');
    const names = [...expected, 'caption.txt', 'validation.json', 'cards.zip', 'preview.jpg'];
    const buffers = {}, stats = [];
    for (const filename of names) {
      const filenamePath = path.join(edition, filename);
      const before = await regular(filenamePath);
      if (!before.size) throw Error(`Empty input: ${filename}`);
      if (before.mtimeMs > +now + 1000) throw Error(`Future input timestamp: ${filename}`);
      if (+now - before.mtimeMs > MAX_AGE_MS) throw Error(`Stale input (>120h): ${filename}`);
      buffers[filename] = await fs.readFile(filenamePath);
      const after = await regular(filenamePath);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw Error('Input changed while reading');
      stats.push([filename, after.size, after.mtimeMs, after.ctimeMs, after.ino, hash(buffers[filename])]);
    }
    const validation = JSON.parse(buffers['validation.json'].toString('utf8'));
    if (validation.trade_date !== tradeDate.replaceAll('-', '') || validation.session !== 'regular close' || validation.date_return_arithmetic !== 'passed') throw Error('Failed validation or mismatched trade date/session');
    const dimensions = pngSize(buffers[expected[0]]);
    const [w, h] = dimensions;
    if (w < 1080 || h < 1350 || w / h < 0.8 || w / h > 1.91) throw Error('PNG dimensions outside allowed minimum/ratio');
    if (JSON.stringify(validation.dimensions) !== JSON.stringify(dimensions)) throw Error('Validation dimensions mismatch');
    for (const filename of expected) if (JSON.stringify(pngSize(buffers[filename])) !== JSON.stringify(dimensions)) throw Error('Inconsistent image dimensions');
    const rawCaption = buffers['caption.txt'].toString('utf8');
    if (!Buffer.from(rawCaption).equals(buffers['caption.txt'])) throw Error('Caption is not valid UTF-8');
    const caption = rawCaption.trim();
    if (!caption || [...caption].length > 2200) throw Error('Caption must contain 1..2200 Unicode codepoints');
    const hashtagCount = (caption.match(/#[\p{L}\p{N}_]+/gu) || []).length;
    if (hashtagCount > 5 || !Number.isInteger(validation.hashtags) || validation.hashtags !== hashtagCount) throw Error('Hashtag validation failed');
    const zip = path.join(edition, 'cards.zip');
    const unzip = args => execFileSync('/usr/bin/unzip', args, { encoding: null, maxBuffer: 256 * 1024 * 1024, timeout: 30_000, stdio: ['ignore','pipe','pipe'] });
    unzip(['-t', zip]);
    const zipNames = unzip(['-Z1', zip]).toString('utf8').split('\n').filter(Boolean);
    if (new Set(zipNames).size !== zipNames.length || zipNames.some(n => n.includes('\\') || n.startsWith('/') || n.split('/').includes('..') || n.includes('\0'))) throw Error('Unsafe or duplicate ZIP entry');
    if (zipNames.some(n => n.includes('/')) || zipNames.some(n => ![...expected, 'caption.txt', 'sources.txt'].includes(n))) throw Error('Unexpected ZIP entry');
    for (const filename of [...expected, 'caption.txt']) {
      if (!zipNames.includes(filename) || !unzip(['-p', zip, filename]).equals(buffers[filename])) throw Error(`ZIP bytes mismatch: ${filename}`);
    }
    if (!zipNames.includes('sources.txt') || !unzip(['-p', zip, 'sources.txt']).toString('utf8').trim()) throw Error('ZIP sources.txt is missing/empty');
    // Detect changes during external ZIP verification as well.
    for (const [filename, size, mtime, ctime, ino] of stats) {
      const end = await regular(path.join(edition, filename));
      if (end.size !== size || end.mtimeMs !== mtime || end.ctimeMs !== ctime || end.ino !== ino) throw Error('Input changed during ZIP verification');
    }
    const digest = createHash('sha256');
    for (const filename of [...expected, 'caption.txt', 'validation.json']) { const b = buffers[filename]; digest.update(`${filename}\0${b.length}\0`); digest.update(b); }
    const fingerprint = digest.digest('hex');
    return { id: hash(`${ACCOUNT}\0${name}\0${fingerprint}`).slice(0, 24), account: ACCOUNT, edition, trade_date: tradeDate.replaceAll('-', ''), images: expected.map(n => path.join(edition, n)), caption: path.join(edition, 'caption.txt'), fingerprint, observation: hash(JSON.stringify(stats)) };
  }
  function conflict(state, job, ignoreId) {
    return Object.values(state.jobs).find(j => j.id !== ignoreId && ['ready', 'in_progress', 'posted', 'blocked'].includes(j.status) && (j.trade_date === job.trade_date || j.fingerprint === job.fingerprint));
  }
  async function init() { return transaction(async () => {
    try { await fs.lstat(stateFile); const state = await load(); return { status: 'already_initialized', account: ACCOUNT, baseline_count: state.baseline.length }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const baseline = await directories();
    await save({ version: 1, account: ACCOUNT, root, initialized_at: new Date(clock()).toISOString(), baseline, jobs: {} });
    return { status: 'initialized', account: ACCOUNT, baseline_count: baseline.length };
  }); }
  async function scan() { return transaction(async () => {
    const state = await load(), now = +new Date(clock()), rejected = [];
    const present = await directories();
    // Re-evaluate readiness every scan; terminal/manual states are never retried.
    for (const j of Object.values(state.jobs)) {
      if (['posted', 'blocked', 'in_progress'].includes(j.status)) continue;
      if (!present.includes(path.basename(j.edition))) { j.status = 'invalid'; j.reason = 'Edition directory is missing'; delete j.firstSeen; j.observations = 0; }
      else if (j.status === 'ready') j.status = 'observing';
    }
    for (const name of present) {
      if (state.baseline.includes(name)) continue;
      const old = Object.values(state.jobs).find(j => path.basename(j.edition) === name);
      if (old && ['posted', 'blocked', 'in_progress'].includes(old.status)) continue;
      let candidate;
      try { candidate = await inspect(name); } catch (e) {
        if (old) { old.status = 'invalid'; old.reason = errorText(e); delete old.firstSeen; old.observations = 0; }
        rejected.push({ edition: name, reason: errorText(e) }); continue;
      }
      if (old && old.id !== candidate.id) delete state.jobs[old.id];
      const same = old && old.id === candidate.id && old.observation === candidate.observation && ['observing', 'ready'].includes(old.status);
      const job = { ...candidate, status: 'observing', firstSeen: same ? old.firstSeen : now, lastSeen: now, observations: same ? old.observations + 1 : 1 };
      state.jobs[job.id] = job;
      const duplicate = conflict(state, job, job.id);
      if (duplicate) { job.status = 'duplicate'; job.reason = `Duplicate of ${duplicate.id} (${duplicate.status})`; }
      else if (job.observations >= 2 && now - job.firstSeen >= STABLE_MS) job.status = 'ready';
    }
    // Vanished candidates cannot remain ready.
    await save(state);
    return { status: 'ok', account: ACCOUNT, ready: Object.values(state.jobs).filter(j => j.status === 'ready').map(publicJob), attention: Object.values(state.jobs).filter(j => ['blocked','in_progress'].includes(j.status)).map(publicJob), rejected };
  }); }
  async function claim(id) { return transaction(async () => {
    const state = await load(), job = state.jobs[id];
    if (!job || job.status !== 'ready') throw Error('Job is not ready; scan twice at least 120 seconds apart');
    let current;
    try { current = await inspect(path.basename(job.edition)); } catch (e) { job.status = 'invalid'; job.reason = errorText(e); await save(state); throw e; }
    if (current.id !== job.id || current.fingerprint !== job.fingerprint || current.observation !== job.observation || job.observations < 2 || +new Date(clock()) - job.firstSeen < STABLE_MS) {
      job.status = 'invalid'; job.reason = 'Inputs changed or stability requirement failed'; await save(state); throw Error(job.reason);
    }
    if (conflict(state, job, id)) throw Error('Another job already reserves this trade date or fingerprint');
    job.status = 'in_progress'; job.claimed_at = new Date(clock()).toISOString();
    await save(state);
    return { status: 'claimed', job: publicJob(job) };
  }); }
  async function markPosted(id, url) { return transaction(async () => {
    let u; try { u = new URL(url); } catch { throw Error('Invalid Instagram post URL'); }
    if (u.protocol !== 'https:' || !['instagram.com','www.instagram.com'].includes(u.hostname) || u.port || u.username || u.password || !/^\/(p|reel)\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)) throw Error('Expected HTTPS Instagram /p/ or /reel/ post URL');
    const state = await load(), job = state.jobs[id];
    if (!job || job.status !== 'in_progress') throw Error('Only the current in_progress job can be marked posted');
    job.status = 'posted'; job.receipt = { url: u.href, posted_at: new Date(clock()).toISOString() }; await save(state);
    return { status: 'posted', job: publicJob(job) };
  }); }
  async function markBlocked(id, reason) { return transaction(async () => {
    if (typeof reason !== 'string' || !reason.trim()) throw Error('A reason is required');
    const state = await load(), job = state.jobs[id];
    if (!job || !['ready','in_progress'].includes(job.status)) throw Error('Only ready/in_progress jobs can be blocked');
    job.status = 'blocked'; job.reason = reason.trim(); job.blocked_at = new Date(clock()).toISOString(); await save(state);
    return { status: 'blocked', job: publicJob(job) };
  }); }
  async function status() { return transaction(async () => {
    const state = await load(); return { status: 'ok', account: ACCOUNT, baseline_count: state.baseline.length, jobs: Object.values(state.jobs).map(publicJob), attention: Object.values(state.jobs).filter(j => ['in_progress','blocked'].includes(j.status)).map(publicJob) };
  }); }
  return { init, scan, claim, markPosted, markBlocked, status };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const watcher = createWatcher(path.dirname(fileURLToPath(import.meta.url)));
  const [command, ...args] = process.argv.slice(2);
  const commands = { init: [0, () => watcher.init()], scan: [0, () => watcher.scan()], status: [0, () => watcher.status()], list: [0, () => watcher.status()], claim: [1, () => watcher.claim(args[0])], 'mark-posted': [2, () => watcher.markPosted(args[0], args[1])], 'mark-blocked': [2, () => watcher.markBlocked(args[0], args[1])] };
  try {
    if (!commands[command] || args.length !== commands[command][0]) throw Error('Usage: node instagram-watch.mjs init|scan|status|list|claim <id>|mark-posted <id> <instagram_post_url>|mark-blocked <id> "<reason>"');
    console.log(JSON.stringify(await commands[command][1]()));
  } catch (e) { console.error(JSON.stringify({ status: 'error', account: ACCOUNT, error: errorText(e) })); process.exitCode = 1; }
}
