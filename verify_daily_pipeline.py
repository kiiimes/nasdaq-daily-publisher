"""Run real generation in a disposable folder; never publish or replace editions."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

SOURCE = Path(__file__).resolve().parent
FILES = ('build_edition.py','check_kis.py','cloud_config.json','cloud_daily.py',
         'codex_editorial.py','collect_movers.py','daily_pipeline.py','editorial.schema.json',
         'fetch_market.py','research.schema.json','editorial_runtime.py','editorial-models.json')
with tempfile.TemporaryDirectory(prefix='nasdaq-integration-') as directory:
    root=Path(directory)
    for name in FILES: shutil.copyfile(SOURCE/name,root/name)
    (root/'cloud_state.seed.json').write_text('{"baseline":[],"jobs":{}}')
    result=subprocess.run([sys.executable,str(root/'cloud_daily.py'),'generate'],cwd=root,
        env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','TMPDIR','RUNNER_TEMP',
             'CODEX_HOME','LANG','SYSTEMROOT','KIS_APP_KEY','KIS_APP_SECRET','AUTOMATION_ENABLED')},timeout=2200)
    if result.returncode: raise SystemExit(result.returncode)
    print('Subscription research, fresh KIS crosscheck, editorial composition and five-card rendering verified. No publication performed.')
