/** Copy public runtime code only. Private state and Git metadata never move. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {requirePrivateOrigin, git} from './cloud_publish.mjs';
export const RUNTIME_FILES = Object.freeze([
  'build_edition.py', 'check_kis.py', 'cloud_config.json', 'cloud_daily.py',
  'cloud_publish.mjs', 'codex_editorial.py', 'codex_session.mjs',
  'collect_movers.py', 'daily_pipeline.py', 'editorial.schema.json',
  'fetch_market.py', 'instagram-api.mjs', 'instagram-watch.mjs',
  'research.schema.json', 'upload-media.mjs', 'stage-runtime.mjs',
]);
async function directory(input) {
  const absolute = path.resolve(input);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('runtime_directory_rejected');
  }
  return absolute;
}
async function regular(file, optional = false) {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw Error('runtime_file_rejected');
  } catch (error) { if (!optional || error.code !== 'ENOENT') throw error; }
}
export async function stageRuntime(sourceInput, runtimeInput, {run = git} = {}) {
  const source = await directory(sourceInput), runtime = await directory(runtimeInput);
  const nested = (a, b) => b === a || b.startsWith(a + path.sep);
  if (nested(source, runtime) || nested(runtime, source)) throw Error('runtime_roots_rejected');
  await directory(path.join(runtime, '.git'));
  // Use the trusted PUBLIC implementation, before reading or copying code.
  requirePrivateOrigin(runtime, run);
  const entries = [];
  for (const name of RUNTIME_FILES) {
    const from = path.join(source, name), to = path.join(runtime, name);
    await regular(from); await regular(to, true);
    const handle = await fs.open(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw Error('runtime_file_rejected');
      entries.push({to, bytes: await handle.readFile()});
    } finally { await handle.close(); }
  }
  // Preflight every path before the first write; use fresh exclusive temp files.
  for (const {to, bytes} of entries) {
    const temp = path.join(runtime, '.stage-runtime-' + randomUUID());
    try {
      await fs.writeFile(temp, bytes, {flag: 'wx', mode: 0o644});
      await regular(to, true);
      await fs.rename(temp, to);
    } finally { await fs.rm(temp, {force: true}); }
  }
  return {ok: true, files_staged: entries.length, private_state_copied: false};
}
export async function cli(args = process.argv.slice(2)) {
  try {
    if (args.length !== 2) throw Error('arguments');
    console.log(JSON.stringify(await stageRuntime(...args))); return 0;
  } catch { console.error('Runtime staging rejected; no source content is logged.'); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await cli();
