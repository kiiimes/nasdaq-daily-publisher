/** Offline only: synthetic files and mocked Git. No network, keys, or private state. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RUNTIME_FILES, stageRuntime, cli as stageCli} from './stage-runtime.mjs';
import {verifyStateConnection, cli as connectionCli} from './verify-state-connection.mjs';
const privateSSH = 'git@github.com:kiiimes/nasdaq-instagram-automation.git';
function mockGit(calls, {origin = privateSSH, fetch = origin, push = fetch, failPush = false} = {}) {
  return (root, args) => {
    calls.push([...args]);
    if (args[0] === 'config') return origin;
    if (args[0] === 'remote') return args.includes('--push') ? push : fetch;
    if (args[0] === 'push' && args[1] === '--dry-run') {
      if (failPush) throw Error('TEST-SENSITIVE-REMOTE-OUTPUT');
      return 'TEST-SENSITIVE-REMOTE-OUTPUT';
    }
    throw Error('TEST unexpected git call');
  };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'TEST-stage-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), runtime = path.join(root, 'runtime');
  await fs.mkdir(source); await fs.mkdir(runtime); await fs.mkdir(path.join(runtime, '.git'));
  for (const name of RUNTIME_FILES) await fs.writeFile(path.join(source, name), 'TEST-public-' + name);
  return {root, source, runtime};
}
const contents = (dir, name) => fs.readFile(path.join(dir, name), 'utf8');
test('explicit runtime allowlist is exactly sixteen unique root-level code/config files', () => {
  assert.equal(RUNTIME_FILES.length, 16); assert.equal(new Set(RUNTIME_FILES).size, 16);
  assert.ok(Object.isFrozen(RUNTIME_FILES));
  for (const name of RUNTIME_FILES) {
    assert.equal(path.basename(name), name);
    assert.match(name, /\.(py|mjs|json)$/);
    assert.doesNotMatch(name, /seed|state|\.enc|^test|^\./);
  }
});
test('staging copies only allowlisted source and preserves every private sentinel', async t => {
  const {source, runtime} = await fixture(t), calls = [];
  const privateFiles = ['cloud_state.seed.json', 'cloud_state.json', 'codex_session.enc', '.gitignore', '.env'];
  for (const name of privateFiles) {
    await fs.writeFile(path.join(source, name), 'TEST-never-copy');
    await fs.writeFile(path.join(runtime, name), 'TEST-private-preserved');
  }
  await fs.mkdir(path.join(source, 'editions')); await fs.mkdir(path.join(runtime, 'editions'));
  await fs.writeFile(path.join(runtime, 'editions/TEST'), 'TEST-edition-preserved');
  await fs.writeFile(path.join(runtime, '.git/TEST'), 'TEST-git-preserved');
  assert.deepEqual(await stageRuntime(source, runtime, {run: mockGit(calls)}), {ok: true, files_staged: 16, private_state_copied: false});
  for (const name of RUNTIME_FILES) assert.equal(await contents(runtime, name), 'TEST-public-' + name);
  for (const name of privateFiles) assert.equal(await contents(runtime, name), 'TEST-private-preserved');
  assert.equal(await contents(runtime, 'editions/TEST'), 'TEST-edition-preserved');
  assert.equal(await contents(runtime, '.git/TEST'), 'TEST-git-preserved');
  assert.equal(calls.length, 3); assert.equal((await fs.readdir(runtime)).some(n => n.startsWith('.stage-runtime-')), false);
});
test('public origin is rejected before any runtime source write', async t => {
  const {source, runtime} = await fixture(t), calls = [];
  await assert.rejects(stageRuntime(source, runtime, {run: mockGit(calls, {origin: 'git@github.com:kiiimes/nasdaq-daily-publisher.git'})}), /origin_rejected/);
  assert.deepEqual(await fs.readdir(runtime), ['.git']);
});
test('resolved fetch or push rewrites are rejected before copying', async t => {
  const {source, runtime} = await fixture(t);
  for (const options of [{fetch: 'TEST-other'}, {push: 'TEST-other'}]) {
    await assert.rejects(stageRuntime(source, runtime, {run: mockGit([], options)}), /origin_rejected/);
    assert.deepEqual(await fs.readdir(runtime), ['.git']);
  }
});
test('missing final source file fails complete preflight with no partial copy', async t => {
  const {source, runtime} = await fixture(t);
  await fs.rm(path.join(source, RUNTIME_FILES.at(-1)));
  await assert.rejects(stageRuntime(source, runtime, {run: mockGit([])}));
  assert.deepEqual(await fs.readdir(runtime), ['.git']);
});
for (const side of ['source', 'runtime']) {
  test(side + ' symlink file rejected without following target or copying earlier files', async t => {
    const f = await fixture(t), target = path.join(f.root, 'TEST-target'), name = RUNTIME_FILES.at(-1);
    await fs.writeFile(target, 'TEST-target-preserved');
    if (side === 'source') await fs.rm(path.join(f.source, name));
    await fs.symlink(target, path.join(f[side], name));
    await assert.rejects(stageRuntime(f.source, f.runtime, {run: mockGit([])}), /runtime_file_rejected/);
    assert.equal(await fs.readFile(target, 'utf8'), 'TEST-target-preserved');
    assert.equal((await fs.readdir(f.runtime)).includes(RUNTIME_FILES[0]), false);
  });
  test(side + ' hardlink file rejected', async t => {
    const f = await fixture(t), target = path.join(f.root, 'TEST-target'), name = RUNTIME_FILES.at(-1);
    await fs.writeFile(target, 'TEST-target-preserved');
    if (side === 'source') await fs.rm(path.join(f.source, name));
    await fs.link(target, path.join(f[side], name));
    await assert.rejects(stageRuntime(f.source, f.runtime, {run: mockGit([])}), /runtime_file_rejected/);
    assert.equal(await fs.readFile(target, 'utf8'), 'TEST-target-preserved');
  });
  test(side + ' root symlink rejected before any Git inspection', async t => {
    const f = await fixture(t), link = path.join(f.root, 'TEST-link'), calls = [];
    await fs.symlink(f[side], link);
    await assert.rejects(stageRuntime(side === 'source' ? link : f.source, side === 'runtime' ? link : f.runtime, {run: mockGit(calls)}), /directory_rejected/);
    assert.equal(calls.length, 0);
  });
}
test('directory in place of an allowlisted destination is rejected', async t => {
  const {source, runtime} = await fixture(t);
  await fs.mkdir(path.join(runtime, RUNTIME_FILES.at(-1)));
  await assert.rejects(stageRuntime(source, runtime, {run: mockGit([])}), /file_rejected/);
  assert.equal((await fs.readdir(runtime)).includes(RUNTIME_FILES[0]), false);
});
test('same and nested roots rejected without Git calls', async t => {
  const {source, runtime} = await fixture(t), calls = [];
  await fs.mkdir(path.join(source, 'nested'));
  for (const [a, b] of [[source, source], [source, path.join(source, 'nested')], [path.join(source, 'nested'), source]])
    await assert.rejects(stageRuntime(a, b, {run: mockGit(calls)}), /roots_rejected/);
  assert.equal(calls.length, 0); assert.deepEqual(await fs.readdir(runtime), ['.git']);
});
test('symlink Git directory rejected', async t => {
  const {source, runtime, root} = await fixture(t), calls = [];
  await fs.rmdir(path.join(runtime, '.git')); await fs.mkdir(path.join(root, 'TEST-git'));
  await fs.symlink(path.join(root, 'TEST-git'), path.join(runtime, '.git'));
  await assert.rejects(stageRuntime(source, runtime, {run: mockGit(calls)}), /directory_rejected/);
  assert.equal(calls.length, 0);
});
test('connection verification defaults to three read-only remote checks', () => {
  const calls = [], result = verifyStateConnection('/TEST', {run: mockGit(calls)});
  assert.deepEqual(result, {private_origin_verified: true, push_dry_run: false, mutations: false, automation_ready: false});
  assert.equal(calls.length, 3); assert.equal(calls.some(a => a[0] === 'push'), false);
});
test('connection dry-run is explicit and only HEAD:main; remote output not returned', () => {
  const calls = [], result = verifyStateConnection('/TEST', {dryRun: true, run: mockGit(calls)});
  assert.deepEqual(calls.at(-1), ['push', '--dry-run', 'origin', 'HEAD:main']);
  assert.equal(calls.length, 4); assert.equal(result.push_dry_run, true);
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE/);
});
test('connection guard failure never attempts dry-run', () => {
  const calls = [];
  assert.throws(() => verifyStateConnection('/TEST', {dryRun: true, run: mockGit(calls, {push: 'TEST-other'})}), /origin_rejected/);
  assert.equal(calls.some(a => a[0] === 'push'), false);
});
test('failed dry-run sanitizes sensitive exception text', () => {
  assert.throws(() => verifyStateConnection('/TEST', {dryRun: true, run: mockGit([], {failPush: true})}), error => {
    assert.equal(error.message, 'private_connection_dry_run_failed');
    assert.doesNotMatch(String(error), /SENSITIVE/); return true;
  });
});
test('non-boolean dry-run option rejected without Git', () => {
  const calls = [];
  assert.throws(() => verifyStateConnection('/TEST', {dryRun: 'true', run: mockGit(calls)}), /options_rejected/);
  assert.equal(calls.length, 0);
});
test('invalid CLI arguments fail with safe summaries before Git', async () => {
  const old = console.error, output = []; console.error = x => output.push(x);
  try {
    assert.equal(await stageCli([]), 1);
    assert.equal(await connectionCli([]), 1);
    assert.equal(await connectionCli(['/TEST', '--actual-push']), 1);
  } finally { console.error = old; }
  assert.equal(output.length, 3); assert.doesNotMatch(output.join(' '), /TEST|actual-push/);
});
test('workflow keeps health public-only and never uploads artifacts or grants token writes', async () => {
  const yml = await fs.readFile(new URL('./.github/workflows/daily.yml', import.meta.url), 'utf8');
  const health = yml.split('  health:')[1].split('  connections:')[0];
  assert.match(health, /runs-on: macos-latest/); assert.match(health, /timeout-minutes: 5/);
  assert.match(health, /python-version: '3.13'/); assert.match(health, /node-version: '22'/);
  assert.match(health, /Pillow==13.0.0/); assert.match(health, /python3 -m unittest discover/);
  assert.match(health, /node --test test\*\.mjs/); assert.match(health, /python3 cloud_daily.py health/);
  assert.doesNotMatch(health, /secrets\.|repository:|codex_session\.mjs (restore|persist)/);
  assert.doesNotMatch(yml, /contents: write|upload-artifact|actions\/cache|GITHUB_TOKEN/);
  for (const action of yml.matchAll(/uses: (actions\/[^@]+)@([^\s]+)/g)) assert.match(action[2], /^[0-9a-f]{40}$/);
});
test('workflow gated config check precedes private generation checkout and uses immutable source', async () => {
  const yml = await fs.readFile(new URL('./.github/workflows/daily.yml', import.meta.url), 'utf8');
  const generate = yml.split('  generate:')[1].split('  publish:')[0];
  assert.ok(generate.indexOf('c.model_isolation_verified !== true') < generate.indexOf('ssh-key:'));
  for (const section of [generate, yml.split('  publish:')[1]]) {
    assert.match(section, /github.repository == 'kiiimes\/nasdaq-daily-publisher'/);
    assert.match(section, /github.ref == 'refs\/heads\/main'/);
    assert.match(section, /vars.AUTOMATION_ENABLED == 'true'/);
    assert.match(section, /vars.MODEL_ISOLATION_VERIFIED == 'true'/);
    assert.match(section, /ref: \$\{\{ github.sha \}\}/);
    assert.match(section, /repository: kiiimes\/nasdaq-instagram-automation\n          ref: main/);
    assert.match(section, /ssh-key: \$\{\{ secrets.STATE_DEPLOY_KEY \}\}\n          persist-credentials: true/);
  }
});
