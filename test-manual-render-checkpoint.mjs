import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {checkpointRendered,renderFiles} from './manual_render_checkpoint.mjs';
const date='2026-10-30',origin='git@github.com:kiiimes/nasdaq-instagram-automation.git';
async function fixture(t) {const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'TEST-reviewed-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));for(const f of renderFiles(date)){await fs.mkdir(path.dirname(path.join(root,f)),{recursive:true});await fs.writeFile(path.join(root,f),'TEST');}return root;}
function mock(calls,remote=origin,staged='cloud_state.json'){return (root,args)=>{calls.push(args);if(args[0]==='config'||args[0]==='remote')return remote;if(args[0]==='diff')return staged;return '';};}
test('reviewed checkpoint allowlist excludes auth and other dates',()=>{const f=renderFiles(date);assert.equal(f.length,20);assert.ok(f.every(x=>!x.includes('.enc')&&!x.includes('auth')));assert.throws(()=>renderFiles('../2026-10-30'));});
test('reviewed checkpoint uses only private allowlisted files',async t=>{const root=await fixture(t),calls=[];await fs.writeFile(path.join(root,'codex_session.enc'),'TEST-AUTH-DO-NOT-READ');const r=await checkpointRendered(root,date,{run:mock(calls),persist:async()=>{}});assert.equal(r.auth_accessed,false);assert.equal(r.published,false);assert.ok(!JSON.stringify(calls).includes('codex_session'));assert.deepEqual(calls.at(-1),['push','origin','HEAD:main']);});
test('public origin rejected before persistence or any index mutation',async t=>{const root=await fixture(t),calls=[];let persisted=false;await assert.rejects(checkpointRendered(root,date,{run:mock(calls,'git@github.com:kiiimes/nasdaq-daily-publisher.git'),persist:async()=>{persisted=true;}}));assert.equal(persisted,false);assert.ok(calls.every(a=>a[0]!=='add'&&a[0]!=='push'));});
test('unrelated staged auth rejected before add or push',async t=>{const root=await fixture(t),calls=[];await assert.rejects(checkpointRendered(root,date,{run:mock(calls,origin,'codex_session.enc'),persist:async()=>{}}));assert.ok(calls.every(a=>a[0]!=='add'&&a[0]!=='push'));});
test('symlink and missing render output reject before add',async t=>{const root=await fixture(t);await fs.rm(path.join(root,'editions/'+date+'-five-cards/01.png'));await fs.symlink(path.join(root,'cloud_state.json'),path.join(root,'editions/'+date+'-five-cards/01.png'));const calls=[];await assert.rejects(checkpointRendered(root,date,{run:mock(calls),persist:async()=>{}}));assert.ok(calls.every(a=>a[0]!=='add'&&a[0]!=='push'));});
