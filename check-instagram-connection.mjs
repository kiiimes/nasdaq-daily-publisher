import fs from 'node:fs';
import {ACCOUNT, createPublisher, validateConfig} from './instagram-api.mjs';
const c=JSON.parse(fs.readFileSync(new URL('./cloud_config.json',import.meta.url),'utf8'));
// Never print response bodies, tokens or exception messages from remote services.
async function getOnly(url, options={}) {
  if (options.method && options.method !== 'GET') throw Error('read_only_check');
  const response=await fetch(url,{...options,method:'GET',redirect:'error',signal:AbortSignal.timeout(15000)});
  if (!response.ok) {
    let data; try { data=await response.clone().json(); } catch {}
    const code=Number.isInteger(data?.error?.code)?data.error.code:0;
    const subcode=Number.isInteger(data?.error?.error_subcode)?data.error.error_subcode:0;
    console.error(JSON.stringify({http_status:response.status,meta_code:code,meta_subcode:subcode}));
  }
  return response;
}
try {
  const config=validateConfig({host:c.ig_host,version:c.ig_version,ig_user_id:c.ig_id,username:ACCOUNT,access_token:process.env.IG_ACCESS_TOKEN});
  await createPublisher(config,{fetchImpl:getOnly}).check();
  console.log('Expected Instagram account identity verified.');
  const r=await getOnly(`https://${config.host}/${config.version}/${config.ig_user_id}/content_publishing_limit`,{headers:{Authorization:`Bearer ${config.access_token}`}});
  if(!r.ok) throw Error('limit_check_failed');
  const data=await r.json();
  if(!Array.isArray(data.data)||!data.data.length||data.error) throw Error('limit_response_invalid');
  console.log('Publishing-limit endpoint accessible. No media created or published; actual publication remains unverified.');
} catch {
  console.error('Instagram connection check failed; no credentials or response bodies logged.');
  process.exitCode=1;
}
