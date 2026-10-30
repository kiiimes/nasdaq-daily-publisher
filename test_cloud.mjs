import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {rebase,materialize,portable,durableWatcher,checkpoint} from './cloud_publish.mjs';
import {immutable,validateJpegs} from './upload-media.mjs';
const job={id:'x',account:'daily.nasdaq.kr',edition:'/old/editions/2026-10-30-five-cards',images:['/old/editions/2026-10-30-five-cards/01.png'],caption:'/old/editions/2026-10-30-five-cards/caption.txt',status:'in_progress'};
test('portable root rebasing preserves terminal claim',()=>{const p=rebase(job,'/old',true);assert.equal(p.edition,'editions/2026-10-30-five-cards');const n=rebase(p,'/new');assert.equal(n.caption,'/new/editions/2026-10-30-five-cards/caption.txt');assert.equal(n.status,'in_progress');assert.throws(()=>rebase({...p,caption:'../secret'},'/new'));});
test('preclaim checkpoint precedes irreversible caller',async()=>{const order=[];const w=durableWatcher({claim:async()=>{order.push('claim');return {status:'claimed'};}},async()=>order.push('push'));await w.claim('x');order.push('POST');assert.deepEqual(order,['claim','push','POST']);});
test('failed checkpoint cannot return claim or reach POST',async()=>{let post=false;const w=durableWatcher({claim:async()=>({status:'claimed'})},async()=>{throw Error('push failed');});await assert.rejects(async()=>{await w.claim('x');post=true;});assert.equal(post,false);});
test('public paths immutable including unexpected extra file',()=>{const f=[{name:'01.jpg',sha256:'a'}];immutable({'01.jpg':'a'},f);assert.throws(()=>immutable({'01.jpg':'b'},f));assert.throws(()=>immutable({'01.jpg':'a','key':'secret'},f));});
test('baseline old posts persist through fresh checkout',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-test-'));try{await fs.writeFile(path.join(root,'cloud_state.seed.json'),JSON.stringify({baseline:['2020-01-02-five-cards'],receipts:[{id:'TEST-POSTED',edition:'2020-01-02-five-cards',status:'posted',receipt:{url:'https://example.invalid/TEST-post'}}]}));const s=await materialize(root);assert.deepEqual(s.baseline,['2020-01-02-five-cards']);assert.equal(Object.values(s.jobs)[0].status,'posted');const p=await portable(root);assert.equal(Object.values(p.jobs)[0].receipt.url,'https://example.invalid/TEST-post');assert.ok(!JSON.stringify(p).includes(root));}finally{await fs.rm(root,{recursive:true,force:true});}});
test('checkpoint rejects credentials before any git operation',async()=>{let calls=0;await assert.rejects(()=>checkpoint('/tmp',['.env'],()=>{calls++;return '';}));assert.equal(calls,0);});
test('only ready five card job can upload',async()=>{await assert.rejects(()=>validateJpegs({...job,status:'in_progress'}));});

const privateSSH='git@github.com:kiiimes/nasdaq-instagram-automation.git';
const privateURL='ssh://git@github.com/kiiimes/nasdaq-instagram-automation.git';
async function checkpointFixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'TEST-checkpoint-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'cloud_state.json'),'{}');
  await fs.writeFile(path.join(root,'codex_session.enc'),'TEST-ENCRYPTED-FIXTURE');
  return root;
}
function mockGit(calls,{raw=privateSSH,fetch=raw,push=fetch,staged='cloud_state.json\ncodex_session.enc'}={}) {
  return (root,args)=>{
    calls.push(args);
    if(args[0]==='config')return raw;
    if(args[0]==='remote')return args.includes('--push')?push:fetch;
    if(args[0]==='diff')return staged;
    return '';
  };
}
const mutations=calls=>calls.filter(a=>a[0]==='add'||a[0]==='push'||a.includes('commit'));
test('checkpoint accepts only exact private SSH origins before index mutation',async t=>{
  const root=await checkpointFixture(t);
  for(const origin of [privateSSH,privateURL]) {
    const calls=[];await checkpoint(root,[],mockGit(calls,{raw:origin}));
    assert.equal(calls.length,8);
    assert.deepEqual(calls.slice(0,3),[
      ['config','--get-all','remote.origin.url'],
      ['remote','get-url','--all','origin'],
      ['remote','get-url','--push','--all','origin'],
    ]);
    assert.equal(mutations(calls).length,4);
    assert.deepEqual(calls.at(-1),['push','origin','HEAD:main']);
  }
});
test('checkpoint rejects missing, public, non-SSH, ambiguous and lookalike origins without mutation',async t=>{
  const root=await checkpointFixture(t);
  for(const raw of ['', 'git@github.com:kiiimes/nasdaq-daily-publisher.git',
    'https://github.com/kiiimes/nasdaq-instagram-automation.git',
    privateSSH+'\n'+privateSSH,privateSSH+' ',privateSSH+'-other',
    'ssh://git@github.com.evil.invalid/kiiimes/nasdaq-instagram-automation.git',
    'git@github.com:someone/nasdaq-instagram-automation.git']) {
    const calls=[];await assert.rejects(checkpoint(root,[],mockGit(calls,{raw})),/private_checkpoint_origin_rejected/);
    assert.deepEqual(mutations(calls),[]);
  }
});
test('checkpoint rejects pushurl or Git URL rewrites away from private repo',async t=>{
  const root=await checkpointFixture(t);
  const publicURL='git@github.com:kiiimes/nasdaq-daily-publisher.git';
  for(const options of [{push:publicURL},{fetch:publicURL},{push:privateSSH+'\n'+publicURL}]) {
    const calls=[];await assert.rejects(checkpoint(root,[],mockGit(calls,options)),/private_checkpoint_origin_rejected/);
    assert.deepEqual(mutations(calls),[]);
  }
});
test('checkpoint fails closed on remote inspection errors',async t=>{
  const root=await checkpointFixture(t);
  for(const failAt of [0,1,2]) {
    const calls=[],base=mockGit(calls);
    await assert.rejects(checkpoint(root,[],(r,a)=>{if(calls.length===failAt)throw Error('TEST git failure');return base(r,a);}),/private_checkpoint_origin_rejected/);
    assert.deepEqual(mutations(calls),[]);
  }
});
test('checkpoint still pushes pending local commit when no new changes',async t=>{
  const root=await checkpointFixture(t),calls=[];
  await checkpoint(root,[],mockGit(calls,{staged:''}));
  assert.equal(calls.some(a=>a.includes('commit')),false);
  assert.deepEqual(calls.at(-1),['push','origin','HEAD:main']);
});
test('checkpoint refuses unrelated staging without committing or pushing',async t=>{
  const root=await checkpointFixture(t),calls=[];
  await assert.rejects(checkpoint(root,[],mockGit(calls,{staged:'cloud_state.json\n.env'})),/unexpected_staged_files/);
  assert.equal(calls.some(a=>a.includes('commit')||a[0]==='push'),false);
});
test('a public-origin checkpoint failure blocks irreversible publish after local preclaim',async t=>{
  const root=await checkpointFixture(t),calls=[];let post=false,claimed=false;
  const watcher=durableWatcher({claim:async()=>{claimed=true;return {status:'claimed'};}},
    ()=>checkpoint(root,[],mockGit(calls,{raw:'git@github.com:kiiimes/nasdaq-daily-publisher.git'})));
  await assert.rejects(async()=>{await watcher.claim('TEST');post=true;},/private_checkpoint_origin_rejected/);
  assert.equal(claimed,true);assert.equal(post,false);assert.deepEqual(mutations(calls),[]);
});
