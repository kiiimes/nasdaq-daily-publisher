import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWatcher} from './instagram-watch.mjs';
import {atomic} from './cloud_publish.mjs';
export const digest=b=>createHash('sha256').update(b).digest('hex');
export function immutable(existing,files) {
  if(existing && (Object.keys(existing).sort().join()!==files.map(f=>f.name).sort().join() || files.some(f=>existing[f.name]!==f.sha256)))throw Error('immutable_asset_conflict');
}
export async function validateJpegs(job,run=execFileSync) {
  if(job.status!=='ready'||![5,6].includes(job.images.length))throw Error('stable_editorial_card_job_required');
  const dir=path.join(job.edition,'api-images');
  if((await fs.lstat(dir)).isSymbolicLink())throw Error('jpeg_symlink');
  const names=(await fs.readdir(dir)).sort();
  const expected=Array.from({length:job.images.length},(_,i)=>String(i+1).padStart(2,'0'));
  if(job.images.map(p=>path.basename(p)).join()!==expected.map(n=>n+'.png').join())throw Error('png_sequence_failed');
  if(names.join()!==expected.map(n=>n+'.jpg').join())throw Error('jpeg_allowlist_failed');
  // Re-encode source PNG using the exact builder settings and compare bytes.
  const script=`import sys,io,json,hashlib\nfrom PIL import Image\nr=[]\nfor i in range(1,int(sys.argv[2])+1):\n p=sys.argv[1]+'/'+str(i).zfill(2)\n im=Image.open(p+'.png'); j=Image.open(sys.argv[1]+'/api-images/'+str(i).zfill(2)+'.jpg')\n assert im.size==j.size==(1080,1350) and j.format=='JPEG'\n b=io.BytesIO();im.save(b,format='JPEG',quality=95,subsampling=0)\n raw=open(sys.argv[1]+'/api-images/'+str(i).zfill(2)+'.jpg','rb').read()\n assert raw==b.getvalue() and len(raw)<8*1024*1024\n r.append(hashlib.sha256(raw).hexdigest())\nprint(json.dumps(r))`;
  let hashes;try{hashes=JSON.parse(run('python3',['-c',script,job.edition,String(job.images.length)],{stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:30000}));}catch{throw Error('jpeg_derivation_or_dimensions_failed');}
  const files=[];
  for(let i=0;i<names.length;i++){const source=path.join(dir,names[i]);const st=await fs.lstat(source);if(!st.isFile()||st.isSymbolicLink())throw Error('jpeg_not_regular');const bytes=await fs.readFile(source);if(digest(bytes)!==hashes[i])throw Error('jpeg_changed');files.push({name:names[i],pngname:path.basename(job.images[i]),sha256:hashes[i],bytes});}
  return files;
}
export function assetDirectory(edition,files) {
  if(!/^\d{4}-\d{2}-\d{2}-five-cards$/.test(edition))throw Error('invalid_edition');
  const revision=digest(JSON.stringify(files.map(f=>[f.name,f.sha256])));
  return 'revisions/'+revision+'/'+edition;
}
export async function prepare(root,id) {
  if(process.env.PUBLISH_ENABLED!=='true'||process.env.AUTOMATION_ENABLED!=='true')throw Error('publish_disabled');
  if(!process.env.ASSETS_DEPLOY_KEY)throw Error('missing_secret:ASSETS_DEPLOY_KEY');
  const w=createWatcher(root), status=await w.status();const job=status.jobs.find(j=>j.id===id);
  if(status.attention.length||!job)throw Error('job_not_ready');
  const files=await validateJpegs(job),edition=path.basename(job.edition);
  if(!/^\d{4}-\d{2}-\d{2}-five-cards$/.test(edition))throw Error('invalid_edition');
  const temp=await fs.mkdtemp(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'nasdaq-assets-'));
  try {
    const key=path.join(temp,'key'),hosts=path.join(temp,'known_hosts');
    await fs.writeFile(key,process.env.ASSETS_DEPLOY_KEY,{mode:0o600});
    const response=await fetch('https://api.github.com/meta',{redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('github_host_keys_unavailable');
    const keys=(await response.json()).ssh_keys;if(!Array.isArray(keys)||!keys.length||keys.some(k=>typeof k!=='string'||!/^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+$|^ecdsa-sha2-nistp256 [A-Za-z0-9+/=]+$/.test(k)))throw Error('github_host_keys_invalid');
    await fs.writeFile(hosts,keys.map(k=>'github.com '+k).join('\n')+'\n',{mode:0o600});
    const repo=path.join(temp,'repo');
    const env={PATH:process.env.PATH,HOME:temp,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_SSH_COMMAND:`ssh -i '${key.replaceAll("'","'\\''")}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='${hosts.replaceAll("'","'\\''")}'`};
    const git=(args,cwd=repo)=>{try{return execFileSync('git',args,{cwd,env,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:60000}).trim();}catch{throw Error('assets_git_failed');}};
    git(['clone','--depth','1','--branch','main','git@github.com:kiiimes/nasdaq-card-assets.git',repo],temp);
    const assetPath=assetDirectory(edition,files);
    const target=path.join(repo,assetPath);let existing=null;
    try{if((await fs.lstat(target)).isSymbolicLink())throw Error('asset_symlink');existing={};for(const n of await fs.readdir(target)){const p=path.join(target,n);if(!(await fs.lstat(p)).isFile()||(await fs.lstat(p)).isSymbolicLink())throw Error('asset_invalid');existing[n]=digest(await fs.readFile(p));}}catch(e){if(e.code!=='ENOENT')throw e;}
    immutable(existing,files);
    if(!existing){await fs.mkdir(target,{recursive:true});for(const f of files)await fs.writeFile(path.join(target,f.name),f.bytes,{flag:'wx'});
      git(['add','--',...files.map(f=>assetPath+'/'+f.name)]);git(['-c','user.name=nasdaq assets','-c','user.email=automation@users.noreply.github.com','commit','-m','Add immutable JPEG edition '+edition]);git(['push','origin','HEAD:main']);}
    const sha=git(['rev-parse','HEAD']);if(!/^[a-f0-9]{40}$/.test(sha))throw Error('invalid_commit');
    const manifest={job_id:id,edition,files:files.map(({bytes,...f})=>({...f,url:`https://raw.githubusercontent.com/kiiimes/nasdaq-card-assets/${sha}/${assetPath}/${f.name}`}))};
    await atomic(path.join(root,'.instagram-auto',id+'.manifest.json'),manifest);return manifest;
  }finally{await fs.rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const root=path.dirname(fileURLToPath(import.meta.url));
  (async()=>{const [command,id]=process.argv.slice(2);if(command!=='prepare')throw Error('usage_prepare');let job=id;if(!job){const r=JSON.parse(await fs.readFile(path.join(root,'.cloud-ready.json'),'utf8'));if(r.attention.length||r.ready.length!==1)throw Error('not_one_ready');job=r.ready[0].id;}await prepare(root,job);console.log('JPEG assets prepared');})().catch(e=>{if(/^missing_secret:[A-Z_]+$/.test(e.message))console.error(e.message);console.error('Asset preparation failed safely');process.exitCode=1;});
}
