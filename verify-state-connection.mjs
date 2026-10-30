/** Explicit opt-in SSH dry-run only. Never decrypts auth or changes state. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {requirePrivateOrigin, git} from './cloud_publish.mjs';
export function verifyStateConnection(root, {dryRun = false, run = git} = {}) {
  if (typeof dryRun !== 'boolean') throw Error('connection_options_rejected');
  requirePrivateOrigin(root, run);
  if (dryRun) {
    // git() captures BOTH stdout and stderr, including on error. Never log either.
    try { run(root, ['push', '--dry-run', 'origin', 'HEAD:main']); }
    catch { throw Error('private_connection_dry_run_failed'); }
  }
  return {private_origin_verified: true, push_dry_run: dryRun, mutations: false, automation_ready: false};
}
export async function cli(args = process.argv.slice(2)) {
  try {
    if (args.length < 1 || args.length > 2 || (args.length === 2 && args[1] !== '--dry-run')) throw Error('arguments');
    console.log(JSON.stringify(verifyStateConnection(path.resolve(args[0]), {dryRun: args.length === 2}))); return 0;
  } catch { console.error('Private SSH connection verification failed; remote output suppressed.'); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await cli();
