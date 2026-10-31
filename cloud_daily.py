"""Cloud orchestration. No shell interpolation and no credentials in editorial children."""
import argparse
from datetime import datetime, timedelta, time, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from zoneinfo import ZoneInfo
ROOT = Path(__file__).resolve().parent
NY = ZoneInfo('America/New_York')

def trade_date(explicit=None, now=None):
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(NY)
    day = local.date()
    if local.time().replace(tzinfo=None) < time(16):
        day -= timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    if explicit:
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', explicit):
            raise ValueError('Date must be YYYY-MM-DD')
        day = datetime.strptime(explicit, '%Y-%m-%d').date()
    close = datetime.combine(day, time(16), NY)
    age = now - close.astimezone(timezone.utc)
    if day.weekday() >= 5 or age.total_seconds() < 0 or age > timedelta(hours=120):
        raise ValueError('Date is weekend, unclosed, or older than 120h')
    return day.isoformat()

def child(args, kis=False, timeout=485, retain_kis_cache=False):
    safe = {k: v for k, v in os.environ.items() if k in ('PATH','HOME','TMPDIR','RUNNER_TEMP','CODEX_HOME','LANG','SYSTEMROOT')}
    credential_file = ROOT/'.env'
    token_file = ROOT/'.kis-token.json'
    owned = False
    keep_cache = False
    try:
        if not kis:
            # Broker files must never reach an editorial/LLM stage.
            token_file.unlink(missing_ok=True)
            if credential_file.exists():
                raise ValueError('Refusing non-broker child while credential file exists')
        if kis:
            for key in ('KIS_APP_KEY','KIS_APP_SECRET'):
                if not os.environ.get(key): raise ValueError('Missing secret: '+key)
                safe[key] = os.environ[key]
                if '\n' in safe[key] or '\r' in safe[key]: raise ValueError('Invalid secret format: '+key)
            # Existing read-only check_kis.py expects a file, not environment.
            # Never overwrite a pre-existing file or leave ours for another stage.
            fd = os.open(credential_file, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
            owned = True
            with os.fdopen(fd,'w') as f:
                f.write('KIS_APP_KEY='+safe['KIS_APP_KEY']+'\nKIS_APP_SECRET='+safe['KIS_APP_SECRET']+'\n')
        result = subprocess.run(args, cwd=ROOT, env=safe, capture_output=True, timeout=timeout)
        if result.returncode:
            if Path(args[1]).name == 'codex_editorial.py':
                import re
                for line in result.stderr.decode('utf8', errors='replace').splitlines():
                    if re.fullmatch(r'EDITORIAL_DIAGNOSTIC [A-Za-z]+ [A-Za-z0-9_:,]+', line):
                        print(line, file=sys.stderr)
            raise ValueError('Stage failed: '+Path(args[1]).name+'; requested date unavailable or validation failed; no date substitution')
        if kis and retain_kis_cache:
            if token_file.exists(): token_file.chmod(0o600)
            keep_cache = True
    finally:
        try:
            if owned: credential_file.unlink(missing_ok=True)
        finally:
            if not keep_cache: token_file.unlink(missing_ok=True)

def read(p):
    return json.loads(p.read_text())

def generate(day):
    final = ROOT/'editions'/(day+'-five-cards')
    cloud = ROOT/'cloud_state.json'
    seed = read(ROOT/'cloud_state.seed.json')
    state = read(cloud) if cloud.exists() else seed
    jobs = [j for j in state.get('jobs',{}).values() if j.get('trade_date') == day.replace('-','')]
    if any(j.get('status') in ('blocked','in_progress') for j in jobs):
        raise ValueError('Trade date has an unresolved reservation; manual review only')
    if final.name in state.get('baseline', []) or any(j.get('status') == 'posted' for j in jobs):
        print(json.dumps({'status':'already_posted','edition':final.name}))
        return False
    if final.exists():
        # Publish watcher still validates every artifact/hash and claim before POST.
        print(json.dumps({'status':'already_rendered','edition':final.name}))
        return True
    work = ROOT/'editions'/(day+'-korea'); work.mkdir(parents=True, exist_ok=True)
    research, editorial = work/'research.json', work/'editorial.json'
    child([sys.executable,'codex_editorial.py','research','--date',day,'--output',str(research)])
    data = read(research)
    if data.get('trade_date') != day.replace('-','') or data.get('session') != 'regular close': raise ValueError('Research date/session mismatch')
    picks = data.get('picks', [])
    if not 2 <= len(picks) <= 8 or len({p.get('symbol') for p in picks}) != len(picks): raise ValueError('Invalid research picks')
    from collect_movers import selection
    symbols = [selection(f"{p['exchange']}:{p['symbol']}:{p['name']}") for p in picks]
    market = ROOT/'editions'/day/'market.json'
    token_file = ROOT/'.kis-token.json'
    try:
        # Only the consecutive quote children may share a broker token.
        token_file.unlink(missing_ok=True)
        if not market.exists():
            child([sys.executable,'daily_pipeline.py','fetch','--date',day],kis=True,retain_kis_cache=True)
        if read(market).get('trade_date') != day.replace('-',''): raise ValueError('Market cache date mismatch')
        movers = work/'movers.json'
        if movers.exists(): raise ValueError('Movers cache exists; manual review rather than silently reuse other selections')
        args = [sys.executable,'collect_movers.py','--date',day]
        for p in symbols: args += ['--symbol', ':'.join(p)]
        child(args,kis=True)
    finally:
        token_file.unlink(missing_ok=True)
    child([sys.executable,'codex_editorial.py','compose','--date',day,'--research',str(research),'--market',str(market),'--movers',str(movers),'--output',str(editorial)])
    child([sys.executable,'build_edition.py','--market',str(market),'--editorial',str(editorial),'--movers',str(movers),'--output',str(final)],timeout=80)
    print(json.dumps({'status':'generated','edition':final.name}))
    return True

def health():
    cfg=read(ROOT/'cloud_config.json')
    required=['daily_pipeline.py','collect_movers.py','build_edition.py','codex_editorial.py','codex_session.mjs','instagram-watch.mjs','instagram-api.mjs','cloud_publish.mjs','cloud_daily.py','fetch_market.py','check_kis.py','research.schema.json','editorial.schema.json']
    missing=[p for p in required if not (ROOT/p).is_file()]
    python_supported=sys.version_info[:2]==(3,13)
    font=Path('/System/Library/Fonts/AppleSDGothicNeo.ttc')
    apple_font=font.is_file()
    pillow_version=None
    pillow_font_load=False
    try:
        import PIL
        from PIL import ImageFont
        pillow_version=PIL.__version__
        if apple_font:
            ImageFont.truetype(str(font), 24)
            pillow_font_load=True
    except (ImportError, OSError, ValueError):
        pass
    environment_ok=not missing and python_supported and apple_font and pillow_font_load
    # Readiness here is presence only: health never opens private state/auth.
    def private_file(name):
        p=ROOT/name
        return not p.is_symlink() and p.is_file()
    private_state_ready=private_file('cloud_state.seed.json')
    auth_ready=private_file('codex_session.enc')
    print(json.dumps({'mode':'health','read_only':True,'network':False,'ai_calls':0,'missing_files':missing,'python_supported':python_supported,'apple_font':apple_font,'pillow_version':pillow_version,'pillow_font_load':pillow_font_load,'environment_ok':environment_ok,'private_state_ready':private_state_ready,'auth_ready':auth_ready,'automation_ready':False,'codex_version':cfg['codex_version'],'publishing_enabled':False}))
    if not environment_ok: raise ValueError('Health environment incomplete; inspect health report')

def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['health','generate']);p.add_argument('--date');a=p.parse_args()
    if a.mode=='health': health();return
    if os.environ.get('AUTOMATION_ENABLED')!='true': raise ValueError('AUTOMATION_ENABLED is not true')
    eligible = generate(trade_date(a.date))
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('publish_eligible=' + str(eligible).lower() + '\n')
if __name__=='__main__':
    try: main()
    except (ValueError,OSError,KeyError,subprocess.TimeoutExpired) as e:
        print(str(e) if isinstance(e,ValueError) else 'Cloud generation failed safely',file=sys.stderr);sys.exit(1)
