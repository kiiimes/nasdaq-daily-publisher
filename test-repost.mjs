import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {authorizeRepost,portable} from './cloud_publish.mjs';
const day='2026-10-30',edition=`editions/${day}-five-cards`;
async function fixture(t,status='posted') {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'TEST-repost-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,edition),{recursive:true});
 for(const f of ['caption.txt','cards.zip'])await fs.writeFile(path.join(root,edition,f),'TEST');
 const job={id:'original',trade_date:'20261030',status,edition,caption:edition+'/caption.txt',images:[],receipt:{url:'https://www.instagram.com/p/TEST/'}};
 await fs.writeFile(path.join(root,'cloud_state.json'),JSON.stringify({version:1,account:'daily.nasdaq.kr',baseline:[path.basename(edition),'2026-10-29-five-cards'],jobs:{original:job}}));
 const prev={...process.env};process.env.GITHUB_EVENT_NAME='workflow_dispatch';process.env.GITHUB_REF='refs/heads/main';process.env.REPOST_MODE='repost';
 t.after(()=>{for(const key of ['GITHUB_EVENT_NAME','GITHUB_REF','REPOST_MODE']){if(prev[key]===undefined)delete process.env[key];else process.env[key]=prev[key];}});
 return root;
}
const git=(root,args)=>['config','remote'].includes(args[0])?'git@github.com:kiiimes/nasdaq-instagram-automation.git':'';
test('explicit repost archives receipt, keeps other baseline and consumes run id across portable checkpoint',async t=>{
 const root=await fixture(t);let refreshed=0;
 await authorizeRepost(root,day,'123',{run:git,refresh:async()=>{refreshed++;}});
 const state=await portable(root);
 assert.equal(refreshed,1);assert.deepEqual(state.jobs,{});assert.deepEqual(state.baseline,['2026-10-29-five-cards']);
 assert.equal(state.publication_history[0].receipt.url,'https://www.instagram.com/p/TEST/');assert.deepEqual(state.repost_requests,['123']);
 await assert.rejects(()=>authorizeRepost(root,day,'123',{run:git,refresh:()=>{throw Error('must not refresh');}}),/already_consumed/);
});
test('uncertain jobs cannot be reset by repost',async t=>{
 const root=await fixture(t,'in_progress');await assert.rejects(()=>authorizeRepost(root,day,'124',{run:git,refresh:()=>assert.fail()}),/uncertain/);
});
test('schedule, invalid date and unposted date cannot authorize',async t=>{
 const root=await fixture(t);const options={run:git,refresh:()=>assert.fail()};
 process.env.GITHUB_EVENT_NAME='schedule';await assert.rejects(()=>authorizeRepost(root,day,'124',options),/manual/);
 process.env.GITHUB_EVENT_NAME='workflow_dispatch';
 for(const value of ['', '../x','2026-02-30','2026-10-29'])await assert.rejects(()=>authorizeRepost(root,value,'124',options));
});
