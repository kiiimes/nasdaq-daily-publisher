import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {requirePrivateOrigin, git, portable} from './cloud_publish.mjs';
export function renderFiles(day,count=5) {
  if(![5,6].includes(count))throw Error('invalid_card_count');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw Error('invalid_render_date');
  const base='editions/'+day+'-five-cards/';
  return ['cloud_state.json','editions/'+day+'/market.json','editions/'+day+'-korea/movers.json','editions/'+day+'-korea/editorial.json',...Array.from({length:count},(_,i)=>base+String(i+1).padStart(2,'0')+'.png'),...['caption.txt','sources.txt','preview.jpg','validation.json','index.html','cards.zip'].map(n=>base+n),...Array.from({length:count},(_,i)=>base+'api-images/'+String(i+1).padStart(2,'0')+'.jpg')];
}
async function regular(root,name) {
  let current=root;
  const rootStat=await fs.lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw Error('render_checkpoint_path_rejected');
  for(const part of name.split('/')) {current=path.join(current,part);const s=await fs.lstat(current);if(s.isSymbolicLink()||(current===path.join(root,name)?!s.isFile()||s.nlink!==1:!s.isDirectory()))throw Error('render_checkpoint_path_rejected');}
}
export async function checkpointRendered(root,day,{run=git,persist=portable}={}) {
  root=path.resolve(root);
  requirePrivateOrigin(root,run);
  renderFiles(day); // Validate date before constructing a path.
  const base=path.join(root,'editions',day+'-five-cards');
  const names=(await fs.readdir(base)).filter(n=>/^\d+\.png$/.test(n)).sort();
  const count=names.length;
  if(![5,6].includes(count)||names.join()!==Array.from({length:count},(_,i)=>String(i+1).padStart(2,'0')+'.png').join())throw Error('invalid_card_sequence');
  const files=renderFiles(day,count);
  // No auth path is inspected, read, staged or rewritten by this checkpoint.
  await persist(root);
  for(const f of files)await regular(root,f);
  const stagedBefore=run(root,['diff','--cached','--name-only']).split('\n').filter(Boolean);
  if(stagedBefore.some(f=>!files.includes(f)))throw Error('unexpected_staged_files');
  for(const f of files)run(root,['add','--',f]);
  const stagedAfter=run(root,['diff','--cached','--name-only']).split('\n').filter(Boolean);
  if(stagedAfter.some(f=>!files.includes(f)))throw Error('unexpected_staged_files');
  if(stagedAfter.length)run(root,['-c','user.name=nasdaq automation','-c','user.email=automation@users.noreply.github.com','commit','-m','Render reviewed regular-close edition '+day]);
  run(root,['push','origin','HEAD:main']);
  return {ok:true,trade_date:day,files_checked:files.length,private_checkpoint:true,auth_accessed:false,published:false};
}
export async function cli(args=process.argv.slice(2)) {
  try {if(args.length!==2||args[0]!=='--date')throw Error('usage');console.log(JSON.stringify(await checkpointRendered(process.cwd(),args[1])));return 0;}
  catch {console.error('Reviewed render checkpoint rejected; private output suppressed.');return 1;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await cli();
