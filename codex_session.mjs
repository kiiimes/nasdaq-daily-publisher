/** Managed ChatGPT auth only. Never reads the default ~/.codex directory. */
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const VERSION = 1;
const REPOSITORY = 'kiiimes/nasdaq-instagram-automation';
function check(ok) { if (!ok) throw new Error('Session state rejected'); }
async function safePath(input) {
  const absolute = path.resolve(input);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { const s = await fs.lstat(current); check(!s.isSymbolicLink()); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return absolute;
}
function keyFrom(env) {
  const raw = env.CODEX_AUTH_KEY || '';
  check(/^[A-Za-z0-9+/]{43}=$/.test(raw));
  const key = Buffer.from(raw, 'base64');
  check(key.length === 32 && key.toString('base64') === raw);
  return key;
}
function authValid(raw) {
  check(raw.length <= 1048576);
  const auth = JSON.parse(raw.toString('utf8'));
  check(auth && auth.auth_mode === 'chatgpt' && auth.tokens && typeof auth.tokens === 'object');
  for (const k of ['access_token','id_token','refresh_token']) check(typeof auth.tokens[k] === 'string' && auth.tokens[k].trim().length > 0);
  return raw; // Preserve ALL CLI fields and bytes, not a reconstructed token bundle.
}
async function readPlain(file) {
  const h = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const s = await h.stat(); check(s.isFile() && s.size <= 2 * 1048576 && s.nlink === 1); return await h.readFile(); }
  finally { await h.close(); }
}
async function atomic(file, raw) {
  await safePath(file);
  const tmp = path.join(path.dirname(file), '.codex-state-' + randomBytes(16).toString('hex'));
  let h;
  try {
    h = await fs.open(tmp, 'wx', 0o600); await h.writeFile(raw); await h.sync(); await h.close(); h = null;
    await safePath(file); await fs.rename(tmp, file); await fs.chmod(file, 0o600);
  } finally { if (h) await h.close(); await fs.rm(tmp, {force:true}); }
}
function decoded(value, size) {
  check(typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value));
  const b = Buffer.from(value,'base64'); check(b.toString('base64') === value && (size === null || b.length === size)); return b;
}
async function sessionOperation(action, options, env = process.env) {
  check(['restore','persist'].includes(action) && options.repository === REPOSITORY && options.home && options.state);
  const key = keyFrom(env), home = await safePath(options.home), state = await safePath(options.state);
  check(home !== path.parse(home).root);
  if (env.GITHUB_WORKSPACE) {
    const workspace = await safePath(env.GITHUB_WORKSPACE);
    const rel = path.relative(workspace, home);
    check(rel !== '' && (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)));
  }
  // An explicit dedicated CODEX_HOME is required; never use laptop's default cache.
  if (env.HOME) check(home !== path.resolve(env.HOME, '.codex'));
  const authfile = await safePath(path.join(home,'auth.json'));
  check(state !== authfile && !state.startsWith(home + path.sep));
  const aad = Buffer.from(JSON.stringify({repository:options.repository,version:VERSION}));
  if (action === 'restore') {
    const envelope = JSON.parse((await readPlain(state)).toString('utf8'));
    check(Object.keys(envelope).sort().join(',') === 'ciphertext,iv,repository,tag,version');
    check(envelope.version === VERSION && envelope.repository === options.repository);
    const decipher = createDecipheriv('aes-256-gcm', key, decoded(envelope.iv,12));
    decipher.setAAD(aad); decipher.setAuthTag(decoded(envelope.tag,16));
    const raw = authValid(Buffer.concat([decipher.update(decoded(envelope.ciphertext,null)),decipher.final()]));
    await fs.mkdir(home,{recursive:true,mode:0o700}); await safePath(home); await fs.chmod(home,0o700);
    check((await fs.lstat(home)).isDirectory()); await atomic(authfile,raw);
    return {ok:true,restored:true};
  }
  const hs = await fs.lstat(home); check(hs.isDirectory() && (hs.mode & 0o077) === 0);
  const as = await fs.lstat(authfile); check((as.mode & 0o077) === 0);
  const raw = authValid(await readPlain(authfile));
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,iv); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(raw),cipher.final()]);
  const envelope = {version:VERSION,repository:options.repository,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
  await atomic(state,JSON.stringify(envelope) + '\n'); return {ok:true,persisted:true};
}
export async function runSession(action, options, env = process.env) {
  try { return await sessionOperation(action, options, env); }
  catch { throw new Error('Session state rejected'); }
}
export async function cli(argv = process.argv.slice(2), env = process.env) {
  try {
    const [action,...args] = argv, options = {};
    check(args.length === 6);
    for (let i=0;i<args.length;i+=2) { check(['--state','--home','--repository'].includes(args[i])); const k=args[i].slice(2); check(!(k in options)); options[k]=args[i+1]; }
    console.log(JSON.stringify(await runSession(action,options,env))); return 0;
  } catch { console.error('{"ok":false}'); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await cli();
