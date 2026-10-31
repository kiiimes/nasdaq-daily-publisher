import sys,os,json,tempfile,threading,subprocess
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
sys.path.insert(0,str(Path(__file__).resolve().parent))
from editorial_runtime import arguments
seen=[]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  b=self.rfile.read(int(self.headers['Content-Length'])); d=json.loads(b); seen.append(d)
  if len(seen)==1:
   out=[{'id':'fc1','type':'function_call','call_id':'call1','name':'exec_command','arguments':json.dumps({'cmd':'touch '+str(canary)})}, {'id':'fc2','type':'custom_tool_call','call_id':'call2','name':'apply_patch','input':'*** Begin Patch\n*** Add File: '+str(canary)+'\n+bad\n*** End Patch'}]
  else: out=[{'id':'msg1','type':'message','role':'assistant','content':[{'type':'output_text','text':'BOUNDARY_OK'}]}]
  events=[{'type':'response.created','response':{'id':'resp'+str(len(seen))}}]
  for item in out:
   events.append({'type':'response.output_item.added','output_index':0,'item':item})
   events.append({'type':'response.output_item.done','output_index':0,'item':item})
  events.append({'type':'response.completed','response':{'id':'resp'+str(len(seen)),'status':'completed','output':out,'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}})
  raw=''.join('data: '+json.dumps(e)+'\n\n' for e in events).encode()
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
with tempfile.TemporaryDirectory() as td:
 work=Path(td); home=work/'home';home.mkdir(mode=0o700)
 (home/'auth.json').write_text(json.dumps({'OPENAI_API_KEY':'synthetic-offline-test'}))
 canary=work/'forbidden-write'
 server=HTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
 cmd=[os.environ.get('CODEX_EXECUTABLE','codex'),'exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--ephemeral','--sandbox','read-only']+arguments()+['-c','web_search="live"','-c','features.enable_request_compression=false','-c','model_providers.openai.supports_websockets=false','-c','cli_auth_credentials_store="file"','-o',str(work/'result'),'Say BOUNDARY_OK']
 cmd += ['-c','model_provider="mock"','-c',f'model_providers.mock={{name="Mock",base_url="http://127.0.0.1:{server.server_port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}}']
 env={k:os.environ[k] for k in ('PATH','LANG','SYSTEMROOT') if k in os.environ}; env.update({'CODEX_HOME':str(home),'HOME':str(work),'OPENAI_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1','OPENAI_API_KEY':'synthetic-offline-test'})
 r=subprocess.run(cmd,env=env,cwd=work,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=50)
 assert r.returncode == 0 and len(seen)==2 and not canary.exists(), r.stderr.decode()[-4000:]
 assert all([t['type'] for t in d.get('tools',[])] == ['web_search'] for d in seen)
 assert all('unsupported' in x.get('output','') for x in seen[1]['input'] if x.get('type') in ('function_call_output','custom_tool_call_output'))
 print('Web-only tool registration verified; forced shell and file-edit calls rejected before execution.')
 if r.returncode or not seen:print(r.stderr.decode()[-4500:])
 server.shutdown()
