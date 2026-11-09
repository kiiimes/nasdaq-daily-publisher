import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWatcher, ACCOUNT} from './instagram-watch.mjs';
import {createPublisher,loadCredentials} from './instagram-api.mjs';
const json = async p => JSON.parse(await fs.readFile(p,'utf8'));
const editionRE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+cards$/;
const relative = p => typeof p === 'string' && !path.isAbsolute(p) && !p.includes('\\') && !p.split('/').includes('..');
export async function atomic(file,data) {
  const temp=file+'.tmp'; await fs.writeFile(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600}); await fs.rename(temp,file);
}
export function rebase(job,root,toPortable=false) {
  const j=structuredClone(job), name=path.basename(j.edition);
  if(!editionRE.test(name)) throw Error('invalid_edition');
  const base='editions/'+name;
  const convert=(value,expected) => {
    if(typeof value!=='string' || (path.isAbsolute(value) ? !value.endsWith('/'+expected) : value!==expected)) throw Error('invalid_portable_path');
    return toPortable ? expected : path.join(root,expected);
  };
  j.edition=convert(j.edition,base);
  j.caption=convert(j.caption,base+'/caption.txt');
  j.images=j.images.map((v,i)=>convert(v,base+'/'+String(i+1).padStart(2,'0')+'.png'));
  // Filesystem identity is deliberately not portable across fresh checkouts.
  if(!['posted','blocked','in_progress'].includes(j.status)) { delete j.observation; delete j.firstSeen; j.observations=0; j.status='observing'; }
  return j;
}
export async function materialize(root) {
  let state;
  try {state=await json(path.join(root,'cloud_state.json'));}
  catch(e) {if(e.code!=='ENOENT')throw e; const seed=await json(path.join(root,'cloud_state.seed.json')); state={version:1,account:ACCOUNT,baseline:seed.baseline,jobs:{}};
    for(const r of seed.receipts) state.jobs[r.id]={...r,account:ACCOUNT,edition:'editions/'+r.edition,images:[],caption:'editions/'+r.edition+'/caption.txt'};
  }
  if(state.version!==1||state.account!==ACCOUNT||!Array.isArray(state.baseline)||!state.jobs)throw Error('invalid_cloud_state');
  for(const name of state.baseline)if(!editionRE.test(name))throw Error('invalid_baseline');
  const local={...state,root,jobs:Object.fromEntries(Object.entries(state.jobs).map(([id,j])=>[id,rebase(j,root)]))};
  await fs.mkdir(path.join(root,'.instagram-auto'),{recursive:true,mode:0o700});
  await atomic(path.join(root,'.instagram-auto/state.json'),local); return local;
}
export async function portable(root) {
  const local=await json(path.join(root,'.instagram-auto/state.json'));
  const state={version:1,account:ACCOUNT,baseline:local.baseline,jobs:{},publication_history:local.publication_history??[],repost_requests:local.repost_requests??[]};
  for(const [id,j] of Object.entries(local.jobs))state.jobs[id]=rebase(j,root,true);
  let previous; try{previous=await json(path.join(root,'cloud_state.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const [id,j] of Object.entries(previous?.jobs??{})) {
    if(['posted','blocked'].includes(j.status))state.jobs[id]=j;
    if(j.status==='in_progress'&&!state.jobs[id])state.jobs[id]=j;
  }
  await atomic(path.join(root,'cloud_state.json'),state); return state;
}
export function git(root,args) {
  try{return execFileSync('git',args,{cwd:root,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:60000}).trim();}
  catch{throw Error('private_checkpoint_git_failed');}
}
// Exact SSH destinations only. Check both configured and Git-resolved URLs so
// pushurl and url.*.insteadOf / pushInsteadOf cannot redirect private state.
export function requirePrivateOrigin(root,run=git) {
  const allowed=new Set([
    'git@github.com:kiiimes/nasdaq-instagram-automation.git',
    'ssh://git@github.com/kiiimes/nasdaq-instagram-automation.git',
  ]);
  for(const args of [
    ['config','--get-all','remote.origin.url'],
    ['remote','get-url','--all','origin'],
    ['remote','get-url','--push','--all','origin'],
  ]) {
    let value;
    try { value=run(root,args); } catch { throw Error('private_checkpoint_origin_rejected'); }
    if(typeof value!=='string'||!allowed.has(value))throw Error('private_checkpoint_origin_rejected');
  }
}
export async function checkpoint(root,extra=[],run=git) {
  const files=['cloud_state.json','codex_session.enc',...extra];
  const allowed=/^editions\/\d{4}-\d{2}-\d{2}(?:-korea|-[a-z0-9-]+cards)?\/(?:market\.json|movers\.json|research\.json|editorial\.json|0[1-6]\.png|caption\.txt|sources\.txt|preview\.jpg|validation\.json|index\.html|cards\.zip|api-images\/0[1-6]\.jpg)$/;
  const existing=[];
  for(const f of files) {
    if(!relative(f)||(!['cloud_state.json','codex_session.enc'].includes(f)&&!allowed.test(f)))throw Error('checkpoint_path_rejected');
    try {const st=await fs.lstat(path.join(root,f));if(!st.isFile()||st.isSymbolicLink())throw Error('checkpoint_file_rejected');
      let p=path.dirname(path.join(root,f));while(p!==root){if((await fs.lstat(p)).isSymbolicLink())throw Error('checkpoint_symlink');p=path.dirname(p);}
      existing.push(f);
    }catch(e){if(e.code!=='ENOENT')throw e;}
  }
  // No index, commit, or push mutation until private destination is verified.
  requirePrivateOrigin(root,run);
  for(const f of existing)run(root,['add','--',f]);
  // Refuse unrelated staged files instead of accidentally committing credentials.
  const staged=run(root,['diff','--cached','--name-only']).split('\n').filter(Boolean);
  if(staged.some(f=>!files.includes(f)))throw Error('unexpected_staged_files');
  if(staged.length)run(root,['-c','user.name=nasdaq automation','-c','user.email=automation@users.noreply.github.com','commit','-m','Checkpoint encrypted session and publication state']);
  // Always push: a prior failed push may have left an unpushed local commit.
  run(root,['push','origin','HEAD:main']);
}
export function durableWatcher(watcher,persist) {
  return {...watcher,claim:async id=>{const claim=await watcher.claim(id);await persist();return claim;},
    markPosted:async(id,url)=>{const r=await watcher.markPosted(id,url);await persist();return r;},
    markBlocked:async(id,reason)=>{const r=await watcher.markBlocked(id,reason);await persist();return r;}};
}
export async function authorizeRepost(root,date,requestId,{run=git,refresh}={}) {
  if(process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.REPOST_MODE!=='repost')throw Error('manual_repost_only');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d+$/.test(requestId))throw Error('explicit_repost_date_required');
  const parsed=new Date(date+'T00:00:00Z');
  if(!Number.isFinite(+parsed)||parsed.toISOString().slice(0,10)!==date)throw Error('invalid_repost_date');
  requirePrivateOrigin(root,run);
  const state=await materialize(root),td=date.replaceAll('-',''),edition='editions/'+date+'-five-cards';
  if((state.repost_requests??[]).includes(requestId))throw Error('repost_request_already_consumed');
  if(Object.values(state.jobs).some(j=>['blocked','in_progress'].includes(j.status)))throw Error('uncertain_publication_requires_review');
  const jobs=Object.values(state.jobs).filter(j=>j.trade_date===td);
  if(!jobs.length||jobs.some(j=>j.status!=='posted'||path.basename(j.edition)!==date+'-five-cards'))throw Error('posted_edition_required');
  const update=refresh??(()=>execFileSync('python3',['build_edition.py','--caption-only','--market',`editions/${date}/market.json`,'--editorial',`editions/${date}-korea/editorial.json`,'--movers',`editions/${date}-korea/movers.json`,'--output',edition],{cwd:root,stdio:['ignore','pipe','pipe'],timeout:60000}));
  await update();
  state.publication_history=[...(state.publication_history??[]),...jobs.map(j=>({...rebase(j,root,true),repost_request:requestId}))];
  state.repost_requests=[...(state.repost_requests??[]),requestId];
  for(const j of jobs)delete state.jobs[j.id];
  state.baseline=state.baseline.filter(name=>name!==date+'-five-cards');
  const portableState={...state};delete portableState.root;
  portableState.jobs=Object.fromEntries(Object.entries(state.jobs).map(([id,j])=>[id,rebase(j,root,true)]));
  await atomic(path.join(root,'cloud_state.json'),portableState);
  await atomic(path.join(root,'.instagram-auto/state.json'),state);
  await checkpoint(root,[edition+'/caption.txt',edition+'/cards.zip'],run);
}

export async function scanStable(root,wait=ms=>new Promise(r=>setTimeout(r,ms))) {
  await materialize(root);const w=createWatcher(root);let result=await w.scan();
  if(!result.attention.length&&!result.ready.length) {
    const s=await json(path.join(root,'.instagram-auto/state.json'));
    const observing=Object.values(s.jobs).filter(j=>j.status==='observing');
    if(observing.length){const remaining=Math.max(0,...observing.map(j=>120000-(Date.now()-j.firstSeen)))+25;
      if(remaining>125000)throw Error('stability_wait_exceeded');await wait(remaining);result=await w.scan();}
  }
  await portable(root);await checkpoint(root);return result;
}
export function selectPublication(result,state,date) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date).toISOString().slice(0,10)!==date)throw Error('invalid_publish_date');
  const td=date.replaceAll('-','');
  if(result.attention.length)throw Error('publication_requires_review');
  const ready=result.ready.filter(j=>j.trade_date===td);
  if(ready.length>1)throw Error('multiple_current_editions');
  const posted=Object.values(state.jobs??{}).some(j=>j.trade_date===td&&j.status==='posted') || (state.baseline??[]).includes(date+'-five-cards');
  if(!ready.length&&!posted)throw Error('current_edition_not_ready');
  if(ready.length&&posted)throw Error('current_edition_already_reserved');
  return {...result,ready};
}
export async function publish(root,id,manifest) {
  if(process.env.PUBLISH_ENABLED!=='true'||process.env.AUTOMATION_ENABLED!=='true')throw Error('publish_disabled');
  if(!process.env.IG_ACCESS_TOKEN)throw Error('missing_secret:IG_ACCESS_TOKEN');
  const dir=path.join(root,'.instagram-api');await fs.mkdir(dir,{mode:0o700});
  const file=path.join(dir,'credentials.json');
  try {
    await fs.writeFile(file,JSON.stringify({host:process.env.IG_HOST,version:process.env.IG_VERSION,ig_user_id:process.env.IG_ID,username:ACCOUNT,access_token:process.env.IG_ACCESS_TOKEN}),{mode:0o600,flag:'wx'});
    const publisher=createPublisher(await loadCredentials(root));
    const w=durableWatcher(createWatcher(root),async()=>{await portable(root);await checkpoint(root);});
    return await publisher.publish(id,manifest,{watcher:w,readCaption:j=>fs.readFile(j.caption,'utf8')});
  } finally {await fs.rm(dir,{recursive:true,force:true});}
}
async function main() {
  const root=path.dirname(fileURLToPath(import.meta.url)),[command,id]=process.argv.slice(2);
  if(command==='authorize-repost'){await authorizeRepost(root,id,process.env.GITHUB_RUN_ID);console.log('Explicit dated repost authorized; original receipts retained');}
  else if(command==='scan'){
    let r=await scanStable(root);
    const date=process.env.REPOST_MODE==='repost'?process.env.REPOST_DATE:process.env.PUBLISH_TRADE_DATE;
    if(date)r=selectPublication(r,await json(path.join(root,'.instagram-auto/state.json')),date);
    await atomic(path.join(root,'.cloud-ready.json'),r);
    if(process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,'publish_ready='+String(r.ready.length===1&&!r.attention.length)+'\n');
    console.log(JSON.stringify({ready:r.ready.map(j=>j.id),attention:r.attention.length,status:r.ready.length?'ready':'already_posted'}));
  }
  else if(command==='checkpoint'){await portable(root);const extra=[];for(const d of await fs.readdir(path.join(root,'editions')).catch(()=>[])){
    if(!/^\d{4}-\d{2}-\d{2}(?:-korea|-[a-z0-9-]+cards)?$/.test(d))continue;
    for(const f of await fs.readdir(path.join(root,'editions',d),{recursive:true}))extra.push('editions/'+d+'/'+f);
  }await checkpoint(root,extra.filter(f=>!f.endsWith('/api-images')));}
  else if(command==='publish'){const r=await json(path.join(root,'.cloud-ready.json'));if(r.attention.length||r.ready.length!==1)throw Error('manual_attention_or_not_one_ready');const job=r.ready[0];if(id&&id!==job.id)throw Error('job_mismatch');console.log(JSON.stringify(await publish(root,job.id,await json(path.join(root,'.instagram-auto',job.id+'.manifest.json')))));}
  else throw Error('usage_scan_checkpoint_publish');
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(e=>{if(/^missing_secret:[A-Z_]+$/.test(e.message))console.error(e.message);console.error('Cloud operation failed; review safe persisted state; never retry uncertain jobs.');process.exitCode=1;});
