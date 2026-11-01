import importlib.util
from pathlib import Path
import unittest
from datetime import datetime, timezone
spec=importlib.util.spec_from_file_location('daily',Path(__file__).with_name('cloud_daily.py'));daily=importlib.util.module_from_spec(spec);spec.loader.exec_module(daily)
class Dates(unittest.TestCase):
    def test_before_close(self):
        self.assertEqual(daily.trade_date(now=datetime(2026,10,30,19,59,tzinfo=timezone.utc)),'2026-10-29')
    def test_after_close(self):
        self.assertEqual(daily.trade_date(now=datetime(2026,10,30,20,1,tzinfo=timezone.utc)),'2026-10-30')
    def test_weekend(self):
        self.assertEqual(daily.trade_date(now=datetime(2026,11,1,12,tzinfo=timezone.utc)),'2026-10-30')
    def test_korean_monday_and_tuesday_mornings(self):
        self.assertEqual(daily.trade_date(now=datetime(2026,11,1,22,tzinfo=timezone.utc)), '2026-10-30')
        self.assertEqual(daily.trade_date(now=datetime(2026,11,2,22,tzinfo=timezone.utc)), '2026-11-02')
    def test_explicit(self):
        now=datetime(2026,10,30,20,1,tzinfo=timezone.utc)
        for value in ['2026-10-31','2026-10-23','2026-11-02','2026-02-30','x']:
            with self.assertRaises(ValueError):daily.trade_date(value,now)
    def test_child_no_secrets(self):
        import os
        import tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temporary, patch.object(daily,'ROOT',Path(temporary)), patch.dict(os.environ,{'IG_ACCESS_TOKEN':'SENSITIVE','CODEX_AUTH_KEY':'SECRET','GITHUB_TOKEN':'TOKEN','KIS_APP_KEY':'KIS'}), patch.object(daily.subprocess,'run') as run:
            run.return_value.returncode=0;daily.child(['python3','codex_editorial.py'])
            env=run.call_args.kwargs['env'];self.assertFalse(any(k in env for k in ['IG_ACCESS_TOKEN','CODEX_AUTH_KEY','GITHUB_TOKEN','KIS_APP_KEY']))
if __name__=='__main__':unittest.main()
