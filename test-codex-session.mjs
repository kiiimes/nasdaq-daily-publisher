import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {runSession} from './codex_session.mjs';
const repository='kiiimes/nasdaq-instagram-automation';
async function fixture(fn) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'TEST-codex-')); const home=path.join(root,'dedicated'); await fs.mkdir(home,{mode:0o700});
 const state=path.join(root,'encrypted.json'); const env={CODEX_AUTH_KEY:randomBytes(32).toString('base64'),HOME:root,GITHUB_WORKSPACE:path.join(root,'checkout')};
 const raw=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'TEST-ACCESS',id_token:'TEST-ID',refresh_token:'TEST-REFRESH'},last_refresh:'TEST',extra:{preserve:true}});
 await fs.writeFile(path.join(home,'auth.json'),raw,{mode:0o600});
 try { await fn({root,home,state,env,raw,options:{home,state,repository}}); } finally { await fs.rm(root,{recursive:true,force:true}); }
}
test('roundtrip preserves fields, random nonces, private modes, refreshed auth',()=>fixture(async f=>{
 await runSession('persist',f.options,f.env); const first=JSON.parse(await fs.readFile(f.state));
 assert(!(await fs.readFile(f.state,'utf8')).includes('TEST-REFRESH'));
 await runSession('persist',f.options,f.env); const second=JSON.parse(await fs.readFile(f.state)); assert.notEqual(first.iv,second.iv);
 await fs.rm(f.home,{recursive:true}); await runSession('restore',f.options,f.env);
 assert.equal(await fs.readFile(path.join(f.home,'auth.json'),'utf8'),f.raw);
 assert.equal((await fs.stat(f.home)).mode&0o777,0o700); assert.equal((await fs.stat(path.join(f.home,'auth.json'))).mode&0o777,0o600); assert.equal((await fs.stat(f.state)).mode&0o777,0o600);
 const refreshed=JSON.parse(f.raw); refreshed.tokens.refresh_token='TEST-ROTATED'; await fs.writeFile(path.join(f.home,'auth.json'),JSON.stringify(refreshed));
 await runSession('persist',f.options,f.env); await runSession('restore',f.options,f.env); assert.equal(JSON.parse(await fs.readFile(path.join(f.home,'auth.json'))).tokens.refresh_token,'TEST-ROTATED');
}));
test('wrong key, tamper, version AAD, repository mismatch fail',()=>fixture(async f=>{
 await runSession('persist',f.options,f.env); const raw=await fs.readFile(f.state,'utf8');
 await assert.rejects(runSession('restore',f.options,{...f.env,CODEX_AUTH_KEY:randomBytes(32).toString('base64')}));
 for(const [k,v] of [['repository','evil/repo'],['version',2],['tag',randomBytes(16).toString('base64')],['ciphertext',randomBytes(15).toString('base64')]]) {
  const e=JSON.parse(raw); e[k]=v; await fs.writeFile(f.state,JSON.stringify(e)); await assert.rejects(runSession('restore',f.options,f.env));
 }
 await assert.rejects(runSession('persist',{...f.options,repository:'evil/repo'},f.env));
}));
test('symlinks and workspace home rejected',()=>fixture(async f=>{
 await fs.symlink(f.home,path.join(f.root,'link')); await assert.rejects(runSession('persist',{...f.options,home:path.join(f.root,'link')},f.env));
 await fs.symlink(path.join(f.home,'auth.json'),f.state); await assert.rejects(runSession('persist',f.options,f.env));
 await assert.rejects(runSession('persist',f.options,{...f.env,GITHUB_WORKSPACE:f.root}));
}));
test('invalid auth/key/private modes and normal CLI errors leak nothing',()=>fixture(async f=>{
 await assert.rejects(runSession('persist',f.options,{...f.env,CODEX_AUTH_KEY:'TEST-SECRET'}));
 await fs.chmod(path.join(f.home,'auth.json'),0o644); await assert.rejects(runSession('persist',f.options,f.env)); await fs.chmod(path.join(f.home,'auth.json'),0o600);
 await fs.writeFile(path.join(f.home,'auth.json'),JSON.stringify({auth_mode:'apikey',tokens:{}})); await assert.rejects(runSession('persist',f.options,f.env));
 const r=spawnSync(process.execPath,[new URL('./codex_session.mjs',import.meta.url).pathname,'persist','--state',f.state,'--home',f.home,'--repository',repository],{env:{...process.env,...f.env,CODEX_AUTH_KEY:'TEST-SECRET'},encoding:'utf8'});
 assert.equal(r.status,1); assert.equal(r.stderr.trim(),'{"ok":false}'); assert.equal(r.stdout,'');
}));
