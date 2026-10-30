import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ACCOUNT, PublishError, createPublisher, validateConfig, validateManifest, validatePublicUrl, loadCredentials, runCli } from './instagram-api.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// Entirely synthetic fixtures. No external calls: all fetch and DNS are mocked.
const TOKEN = 'synthetic-private-value-123456789';
const config = { host: 'graph.instagram.com', version: 'v99.0', ig_user_id: '123', username: ACCOUNT, access_token: TOKEN };
const id = 'abcdef123456abcdef123456';
const jpg = Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x01,0xff,0xd9]);
const digest = createHash('sha256').update(jpg).digest('hex');
const edition = '/synthetic/project/editions/2026-10-29-five-cards';
const job = { id, account: ACCOUNT, status: 'ready', edition, images: [edition+'/01.png',edition+'/02.png'], caption: edition+'/caption.txt', fingerprint: 'a'.repeat(64), trade_date: '20261029' };
const caption = 'Synthetic Nasdaq report\n#nasdaq';
const manifest = { job_id: id, files: [1,2].map(n => ({ name: `0${n}.jpg`, url: `https://assets.example.org/2026-10-29-five-cards/0${n}.jpg`, sha256: digest })) };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const clone = structuredClone;
function fixture(overrides = {}) {
  const calls = [], events = []; let clock = 1000, created = 200;
  const j = clone(job);
  const watcher = {
    async status() { events.push('status'); return { account: ACCOUNT, jobs: [clone(j), ...(overrides.otherJobs ?? [])] }; },
    async claim(got) { assert.equal(got,id); events.push('claim'); if(overrides.claimError) throw Error(TOKEN); j.status = 'in_progress'; return { status: 'claimed', job: clone(j) }; },
    async markBlocked(got, reason) { assert.equal(got,id); events.push('blocked'); assert.ok(!reason.includes(TOKEN)); if(overrides.blockError) throw Error(TOKEN); j.status = 'blocked'; },
    async markPosted(got, url) { events.push('posted'); assert.equal(got,id); assert.equal(url,'https://www.instagram.com/p/Synthetic_123/'); if(overrides.postedError) throw Error(TOKEN); j.status = 'posted'; return { status: 'posted' }; }
  };
  const fetchImpl = async (url, init) => {
    const u = new URL(url), body = new URLSearchParams(init.body);
    calls.push({ url, init, body });
    if (u.hostname === 'assets.example.org') { events.push('asset'); return overrides.asset ? overrides.asset(u,init) : new Response(jpg, {headers:{'Content-Type':'image/jpeg'}}); }
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!u.searchParams.has('access_token')); assert.ok(!body.has('access_token'));
    assert.equal(init.redirect, 'error');
    if (u.pathname === '/v99.0/123' && init.method === 'GET') { events.push('identity'); return json({id: '123',username: overrides.wrongAccount ? 'someone.else' : ACCOUNT}); }
    if (u.pathname === '/v99.0/123/media') { events.push(body.get('media_type') === 'CAROUSEL' ? 'parent' : 'child'); return json({id: String(++created)}); }
    if (u.pathname === '/v99.0/123/media_publish') { events.push('publish'); if(overrides.publish) return overrides.publish(u,init); return json({id:'501'}); }
    if (u.pathname === '/v99.0/501') { events.push('receipt'); if(overrides.receipt) return overrides.receipt(u,init); return json({permalink:'https://www.instagram.com/p/Synthetic_123/',caption: caption+'\n'}); }
    if (/\/20[123]$/.test(u.pathname)) { events.push('poll:'+u.pathname.split('/').at(-1)); return json({status_code:overrides.containerStatus ?? 'FINISHED',status:'ignored server text '+TOKEN}); }
    throw Error('Unexpected fixture call');
  };
  const publisher = createPublisher(config, { fetchImpl, sleep: async ms => { clock += ms; }, now: () => clock, resolveHost: async () => [{address: '93.184.216.34'}], requestTimeoutMs: 50, pollIntervalMs: 1, containerTimeoutMs: 3, ...overrides.options });
  return {publisher, calls, events, watcher, j, publish: m => publisher.publish(id, m ?? clone(manifest), {watcher, readCaption: async () => caption})};
}
async function rejectsCode(promise, code, uncertain = false) {
  await assert.rejects(promise, e => { assert.ok(e instanceof PublishError); assert.equal(e.code,code); assert.equal(e.uncertain,uncertain); assert.ok(!JSON.stringify(e).includes(TOKEN)); assert.ok(!e.message.includes(TOKEN)); return true; });
}

test('ordered child, child, parent, single publish, receipt, markPosted flow', async () => {
  const f = fixture(); const receipt = await f.publish();
  assert.equal(receipt.status,'posted'); assert.equal(receipt.url,'https://www.instagram.com/p/Synthetic_123/');
  assert.deepEqual(f.events,['identity','status','claim','asset','asset','child','poll:201','child','poll:202','parent','poll:203','publish','receipt','posted']);
  const mutations = f.calls.filter(x=>x.init.method==='POST');
  assert.deepEqual([...mutations[0].body], [['is_carousel_item','true'],['image_url',manifest.files[0].url]]);
  assert.equal(mutations[2].body.get('children'),'201,202'); assert.equal(mutations[2].body.get('caption'),caption); assert.equal(mutations[2].body.get('media_type'),'CAROUSEL');
  assert.equal(mutations[3].body.get('creation_id'),'203');
  assert.ok(!JSON.stringify(receipt).includes(TOKEN));
});
test('healthcheck is one strict read-only identity GET', async () => { const f=fixture(); assert.equal((await f.publisher.check()).username,ACCOUNT); assert.equal(f.calls.length,1); assert.equal(f.calls[0].init.method,'GET'); });
test('wrong account prevents watcher claim and all mutations', async () => { const f=fixture({wrongAccount:true}); await rejectsCode(f.publish(),'account_identity_mismatch'); assert.deepEqual(f.events,['identity']); });
test('both explicitly configured API hosts supported; no implicit version', async () => {
  for(const host of ['graph.facebook.com','graph.instagram.com']) assert.equal(validateConfig({...config,host}).host,host);
  for(const value of [undefined,'vXX.0','latest','v1.0']) assert.throws(()=>validateConfig({...config,version:value}), /explicit_api_version_required/);
  for(const access_token of [undefined,'','secret','REPLACE_ME_ACCESS_TOKEN']) assert.throws(()=>validateConfig({...config,access_token}),/usable_token_required/);
});
test('all unsafe URL forms rejected before networking', () => {
  for(const url of ['http://assets.example.org/a.jpg','file:///01.jpg','https://localhost/a.jpg','https://foo.local/a.jpg','https://127.0.0.1/a.jpg','https://10.1.2.3/a.jpg','https://169.254.169.254/a.jpg','https://2130706433/a.jpg','https://[::1]/a.jpg','https://user:password@assets.example.org/a.jpg','https://assets.example.org/a.jpg?access_token=synthetic','https://assets.example.org:444/a.jpg','https://assets.example.org/a.jpg#token']) assert.throws(()=>validatePublicUrl(url),PublishError);
});
test('manifest cardinality, ordering, source mapping, edition and hashes strict', () => {
  const bad = [ m=>m.files.pop(),m=>m.files.reverse(),m=>m.files[0].sha256='oops',m=>m.job_id='other',m=>m.files[0].pngname='02.png',m=>m.files[0].source_name='../01.png',m=>m.files[0].url=m.files[0].url.replace('2026-10-29','2026-10-28'),m=>m.files[0].url=m.files[0].url.replace('assets.example.org','other.example.org') ];
  for(const alter of bad) { const m=clone(manifest); alter(m); assert.throws(()=>validateManifest(m,job,id),PublishError); }
  const m=clone(manifest); m.files.forEach((f,i)=>f.pngname=`0${i+1}.png`); assert.equal(validateManifest(m,job,id).length,2);
});
test('maximum twenty images accepted, twenty-one rejected',()=> {
  const j=clone(job),m=clone(manifest); j.images=Array.from({length:20},(_,i)=>`${edition}/${String(i+1).padStart(2,'0')}.png`); m.files=j.images.map((_,i)=>({name:`${String(i+1).padStart(2,'0')}.jpg`,url:`https://assets.example.org/2026-10-29-five-cards/${String(i+1).padStart(2,'0')}.jpg`,sha256:digest})); assert.equal(validateManifest(m,j,id).length,20); j.images.push(edition+'/21.png'); m.files.push({...m.files[0],name:'21.jpg'}); assert.throws(()=>validateManifest(m,j,id),PublishError);
});
test('duplicate reservation and non-ready jobs cannot claim or publish', async()=> {
  for(const status of ['ready','posted','blocked','in_progress']) { const f=fixture({otherJobs:[{...job,id:'different',status}]}); await rejectsCode(f.publish(),'duplicate_watcher_job'); assert.ok(!f.events.includes('claim')); }
  const f=fixture(); f.j.status='blocked'; await rejectsCode(f.publish(),'job_not_ready'); assert.ok(!f.events.includes('claim'));
});
test('claim failure never reaches media and sanitizes watcher errors', async()=> { const f=fixture({claimError:true}); await rejectsCode(f.publish(),'watcher_claim_failed'); assert.ok(!f.events.includes('child')); });
test('asset HTTP has no auth, body, or cookies and redirects are errors', async()=> {
  const f=fixture(); await f.publish(); for(const c of f.calls.filter(c=>c.url.includes('assets.example.org'))) { assert.equal(c.init.headers,undefined); assert.equal(c.init.body,undefined); assert.equal(c.init.credentials,'omit'); assert.equal(c.init.redirect,'error'); }
});
test('JPEG hash mismatch blocks claimed job before API mutations', async()=> { const f=fixture(); const m=clone(manifest);m.files[0].sha256='0'.repeat(64);await rejectsCode(f.publish(m),'asset_hash_mismatch');assert.equal(f.j.status,'blocked');assert.ok(!f.events.includes('child')); });
test('PNG masquerading as JPG rejected', async()=> { const f=fixture({asset:()=>new Response(Buffer.from([137,80,78,71,13,10,26,10]))});await rejectsCode(f.publish(),'asset_not_jpeg');assert.equal(f.j.status,'blocked'); });
test('download limited by stream and Content-Length to eight MiB', async()=> {
  for(const asset of [()=>new Response(jpg,{headers:{'content-length':String(8*1024*1024+1)}}),()=>new Response(Buffer.alloc(8*1024*1024+1))]) {const f=fixture({asset}); await rejectsCode(f.publish(),'response_too_large');assert.equal(f.j.status,'blocked');}
});
test('DNS private answers rejected and never fetched',async()=> {const f=fixture({options:{resolveHost:async()=>[{address:'10.0.0.3'}]}});await rejectsCode(f.publish(),'asset_dns_not_public');assert.ok(!f.events.includes('asset'));});
test('asset redirect/network rejection sanitized and blocks',async()=> { const f=fixture({asset:()=>{throw Error('https://private.example/?access_token='+TOKEN);}});await rejectsCode(f.publish(),'asset_request_failed');assert.equal(f.j.status,'blocked'); });
for(const status of ['ERROR','EXPIRED']) test('container '+status+' prevents publish and blocks',async()=>{const f=fixture({containerStatus:status});await rejectsCode(f.publish(),'container_failed');assert.equal(f.j.status,'blocked');assert.ok(!f.events.includes('publish'));});
test('container poll bounded by clock and iteration count',async()=>{for(const now of [undefined,()=>1000]){const f=fixture({containerStatus:'IN_PROGRESS',options:{...(now?{now}:{}),containerTimeoutMs:3}});await rejectsCode(f.publish(),'container_timeout');assert.ok(f.calls.length<10);assert.equal(f.j.status,'blocked');}});
for(const [label,publish,code] of [['network',()=>{throw Error(TOKEN+' https://example.org/?token='+TOKEN);},'request_failed'],['5xx',()=>json({error:{message:TOKEN}},503),'graph_http_503'],['timeout',()=>new Promise(()=>{}),'request_timeout']]) test('publish '+label+' is uncertain, blocks, and never retries',async()=>{const f=fixture({publish});await rejectsCode(f.publish(),code,true);assert.equal(f.j.status,'blocked');assert.equal(f.events.filter(x=>x==='publish').length,1);assert.ok(!f.events.includes('posted'));});
test('missing publish id also uncertain and single attempt',async()=>{const f=fixture({publish:()=>json({})});await rejectsCode(f.publish(),'missing_graph_id',true);assert.equal(f.events.filter(x=>x==='publish').length,1);});
test('permalink failure uncertain; bounded GET-only receipt retries',async()=>{const f=fixture({receipt:()=>json({caption,permalink:'https://evil.example.org/p/foo/'})});await rejectsCode(f.publish(),'publication_unconfirmed',true);assert.equal(f.events.filter(x=>x==='receipt').length,3);assert.equal(f.events.filter(x=>x==='publish').length,1);assert.equal(f.j.status,'blocked');});
test('receipt transient GET failure can recover without publishing again',async()=>{let n=0;const f=fixture({receipt:()=>++n<3?json({},503):json({caption,permalink:'https://instagram.com/p/Synthetic_123'})});assert.equal((await f.publish()).status,'posted');assert.equal(n,3);assert.equal(f.events.filter(x=>x==='publish').length,1);});
test('caption mismatch uncertain, not marked posted',async()=>{const f=fixture({receipt:()=>json({caption:'Different caption',permalink:'https://instagram.com/p/Synthetic_123/'})});await rejectsCode(f.publish(),'published_caption_mismatch',true);assert.equal(f.j.status,'blocked');assert.ok(!f.events.includes('posted'));});
test('markPosted persistence error blocks uncertain; block failure explicitly reported',async()=>{const f=fixture({postedError:true,blockError:true});await assert.rejects(f.publish(),e=>e.code==='posted_state_persist_failed'&&e.uncertain&&e.block_persist_failed);});
test('dry-run has no network, watcher calls, claim or source mutation',()=>{const f=fixture();const before=JSON.stringify(manifest);const result=f.publisher.dryRun(id,manifest,job,caption);assert.equal(result.network,false);assert.equal(result.claimed,false);assert.equal(result.images[0].pngname,'01.png');assert.equal(f.calls.length,0);assert.equal(f.events.length,0);assert.equal(JSON.stringify(manifest),before);assert.ok(!JSON.stringify(result).includes(TOKEN));});
test('default config errors never include tokens, URLs or provider messages',()=>{const e=new PublishError('request_failed',true);assert.deepEqual(e.toJSON(),{status:'blocked',code:'request_failed',uncertain:true});assert.ok(!JSON.stringify(e).includes(TOKEN));});

test('CLI read-only dry-run, secure credentials, missing readiness, injected publish adapter',async()=>{
  const root=await fs.mkdtemp(path.join(DIR,'api-test-'));
  try {
    await rejectsCode(loadCredentials(root),'credentials_missing_not_ready');
    const cd=path.join(root,'.instagram-api');await fs.mkdir(cd,{mode:0o700});await fs.writeFile(path.join(cd,'credentials.json'),JSON.stringify(config),{mode:0o600});
    assert.equal((await loadCredentials(root)).username,ACCOUNT);
    await fs.chmod(path.join(cd,'credentials.json'),0o644);await rejectsCode(loadCredentials(root),'insecure_credentials_permissions');await fs.chmod(path.join(cd,'credentials.json'),0o600);
    const localEdition=path.join(root,'editions',path.basename(edition));await fs.mkdir(localEdition,{recursive:true});await fs.writeFile(path.join(localEdition,'caption.txt'),caption);
    const local={...job,edition:localEdition,caption:path.join(localEdition,'caption.txt'),images:[path.join(localEdition,'01.png'),path.join(localEdition,'02.png')]};
    await fs.mkdir(path.join(root,'.instagram-auto'));const statePath=path.join(root,'.instagram-auto','state.json');const stateText=JSON.stringify({version:1,root,account:ACCOUNT,jobs:{[id]:local}});await fs.writeFile(statePath,stateText);
    const mp=path.join(root,'manifest.json');await fs.writeFile(mp,JSON.stringify(manifest));let network=0,factory=0;
    const result=await runCli(['dry-run',id,mp],{root,fetchImpl:()=>{network++;throw Error('No network');},watcherFactory:()=>{factory++;throw Error('No watcher');}});
    assert.equal(result.status,'dry_run');assert.equal(network,0);assert.equal(factory,0);assert.equal(await fs.readFile(statePath,'utf8'),stateText);assert.deepEqual(await fs.readdir(path.join(root,'.instagram-auto')),['state.json']);
    const f=fixture();f.watcher.status=async()=>({account:ACCOUNT,jobs:[local]});f.watcher.claim=async()=>({status:'claimed',job:{...local,status:'in_progress'}});
    const published=await runCli(['publish',id,mp],{root,fetchImpl:async(url,init)=>{const u=new URL(url);if(u.pathname==='/v99.0/123')return json({id:'123',username:ACCOUNT});if(u.hostname==='assets.example.org')return new Response(jpg);if(u.pathname==='/v99.0/123/media'){const body=new URLSearchParams(init.body);return json({id:body.has('children')?'203':body.get('image_url').endsWith('01.jpg')?'201':'202'});}if(u.pathname==='/v99.0/123/media_publish')return json({id:'501'});if(u.pathname==='/v99.0/501')return json({caption,permalink:'https://www.instagram.com/p/Synthetic_123/'});return json({status_code:'FINISHED'});},watcherFactory:()=>f.watcher,publisherOptions:{resolveHost:async()=>[{address:'93.184.216.34'}]}});
    assert.equal(published.status,'posted');assert.ok(f.events.includes('posted'));
    await fs.rm(cd,{recursive:true});const cli=spawnSync(process.execPath,[path.join(DIR,'instagram-api.mjs'),'check'],{encoding:'utf8'});assert.equal(cli.status,1);const error=JSON.parse(cli.stderr);assert.equal(error.status,'blocked');assert.equal(error.code,'credentials_missing_not_ready');assert.ok(!cli.stderr.includes(TOKEN));
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});


test('identity id mismatch prevents all mutations even when username matches',async()=>{
  let count=0;const p=createPublisher(config,{fetchImpl:async()=>{count++;return json({id:'124',username:ACCOUNT});}});
  await rejectsCode(p.check(),'account_identity_mismatch');assert.equal(count,1);
});
test('pre-publication media POST errors block without uncertain publication',async()=>{
  const f=fixture();const p=createPublisher(config,{fetchImpl:async(url,init)=>new URL(url).pathname==='/v99.0/123'?json({id:'123',username:ACCOUNT}):json({error:{message:TOKEN}},500),verifyAssets:false});
  await rejectsCode(p.publish(id,manifest,{watcher:f.watcher,readCaption:async()=>caption}),'graph_http_500');assert.equal(f.j.status,'blocked');
});
test('parent container error blocks without irreversible publish call',async()=>{
  const f=fixture();let media=0,published=0;const p=createPublisher(config,{verifyAssets:false,fetchImpl:async(url,init)=>{
    const u=new URL(url);if(u.pathname==='/v99.0/123')return json({id:'123',username:ACCOUNT});
    if(u.pathname==='/v99.0/123/media')return json({id:String(200+(++media))});
    if(u.pathname==='/v99.0/123/media_publish'){published++;return json({id:'501'});}
    return json({status_code:u.pathname.endsWith('/203')?'ERROR':'FINISHED'});
  }});await rejectsCode(p.publish(id,manifest,{watcher:f.watcher,readCaption:async()=>caption}),'container_failed');assert.equal(media,3);assert.equal(published,0);assert.equal(f.j.status,'blocked');
});
test('receipt query strings and non-post Instagram paths never accepted',async()=>{
  for(const url of ['https://www.instagram.com/p/Synthetic_123/?token=bad','https://www.instagram.com/daily.nasdaq.kr/','http://www.instagram.com/p/Synthetic_123/','https://instagram.com.evil.example.org/p/Synthetic_123/']){
    const f=fixture({receipt:()=>json({caption,permalink:url})});await rejectsCode(f.publish(),'publication_unconfirmed',true);assert.ok(!f.events.includes('posted'));
  }
});
