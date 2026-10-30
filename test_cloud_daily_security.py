"""Offline regressions: all broker files, children, Pillow and font probes are fake."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('security_daily', Path(__file__).with_name('cloud_daily.py'))
daily = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daily)


class Isolated(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.enterContext(patch.object(daily, 'ROOT', self.root))
        self.enterContext(patch.dict(os.environ, {
            'PATH': '/fake/bin', 'KIS_APP_KEY': 'FAKE_KEY',
            'KIS_APP_SECRET': 'FAKE_SECRET', 'IG_ACCESS_TOKEN': 'FAKE_IG',
            'CODEX_AUTH_KEY': 'FAKE_AUTH', 'GITHUB_TOKEN': 'FAKE_GH',
        }, clear=True))
        self.token = self.root / '.kis-token.json'
        self.envfile = self.root / '.env'

    def json(self, name, data):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data))

    def assert_clean(self):
        self.assertFalse(self.token.exists())
        self.assertFalse(self.envfile.exists())


class ChildSecurity(Isolated):
    def broker(self, *args, **kwargs):
        self.assertEqual(stat.S_IMODE(self.envfile.stat().st_mode), 0o600)
        self.token.write_text('FAKE_TOKEN')
        self.token.chmod(0o644)
        return types.SimpleNamespace(returncode=0)

    def test_retained_token_is_private_and_env_removed(self):
        with patch.object(daily.subprocess, 'run', side_effect=self.broker):
            daily.child(['python', 'daily_pipeline.py'], kis=True, retain_kis_cache=True)
        self.assertFalse(self.envfile.exists())
        self.assertEqual(stat.S_IMODE(self.token.stat().st_mode), 0o600)

    def test_default_broker_child_removes_both_files(self):
        with patch.object(daily.subprocess, 'run', side_effect=self.broker):
            daily.child(['python', 'collect_movers.py'], kis=True)
        self.assert_clean()

    def test_editorial_cannot_observe_broker_files_or_secrets(self):
        self.token.write_text('FAKE_STALE')
        def editorial(*args, **kwargs):
            self.assert_clean()
            for secret in ('KIS_APP_KEY', 'KIS_APP_SECRET', 'IG_ACCESS_TOKEN', 'CODEX_AUTH_KEY', 'GITHUB_TOKEN'):
                self.assertNotIn(secret, kwargs['env'])
            return types.SimpleNamespace(returncode=0)
        with patch.object(daily.subprocess, 'run', side_effect=editorial):
            daily.child(['python', 'codex_editorial.py'])
        self.assert_clean()

    def test_preexisting_env_is_not_read_or_overwritten(self):
        self.envfile.write_text('FAKE_PREEXISTING')
        with patch.object(daily.subprocess, 'run') as run:
            with self.assertRaises(FileExistsError):
                daily.child(['python', 'fetch.py'], kis=True)
            with self.assertRaisesRegex(ValueError, 'credential file exists'):
                daily.child(['python', 'codex_editorial.py'])
            run.assert_not_called()
        self.assertEqual(self.envfile.read_text(), 'FAKE_PREEXISTING')

    def test_failure_cleans_even_when_retention_requested(self):
        def fail(*args, **kwargs):
            self.broker(*args, **kwargs)
            return types.SimpleNamespace(returncode=1)
        with patch.object(daily.subprocess, 'run', side_effect=fail):
            with self.assertRaises(ValueError):
                daily.child(['python', 'daily_pipeline.py'], kis=True, retain_kis_cache=True)
        self.assert_clean()

    def test_timeout_cleans_even_when_retention_requested(self):
        def timeout(*args, **kwargs):
            self.broker(*args, **kwargs)
            raise subprocess.TimeoutExpired('fake', 1)
        with patch.object(daily.subprocess, 'run', side_effect=timeout):
            with self.assertRaises(subprocess.TimeoutExpired):
                daily.child(['python', 'daily_pipeline.py'], kis=True, retain_kis_cache=True)
        self.assert_clean()

    def test_missing_secret_cleans_stale_token_without_launch(self):
        self.token.write_text('FAKE_STALE')
        with patch.dict(os.environ, {'KIS_APP_SECRET': ''}), patch.object(daily.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                daily.child(['python', 'fetch.py'], kis=True)
            run.assert_not_called()
        self.assert_clean()

    def test_invalid_secret_does_not_write_env(self):
        with patch.dict(os.environ, {'KIS_APP_SECRET': 'FAKE\nBAD'}), patch.object(daily.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                daily.child(['python', 'fetch.py'], kis=True)
            run.assert_not_called()
        self.assert_clean()

    def test_chmod_failure_cleans_files(self):
        original = Path.chmod
        def chmod(p, mode, **kwargs):
            if p == self.token and mode == 0o600:
                raise OSError('fake chmod failure')
            return original(p, mode, **kwargs)
        with patch.object(Path, 'chmod', chmod), patch.object(daily.subprocess, 'run', side_effect=self.broker):
            with self.assertRaises(OSError):
                daily.child(['python', 'fetch.py'], kis=True, retain_kis_cache=True)
        self.assert_clean()


class QuotePhase(Isolated):
    def setUp(self):
        super().setUp()
        self.day = '2026-10-29'
        self.json('cloud_state.seed.json', {})
        self.enterContext(patch.dict(sys.modules, {'collect_movers': types.SimpleNamespace(selection=lambda s: tuple(s.split(':')))}))
        self.stages = []
        self.failure = None
        self.market_cached = False

    def stage(self, args, **kwargs):
        stage = args[1]
        self.stages.append(stage)
        if stage == 'codex_editorial.py':
            self.assert_clean()
            self.assertNotIn('KIS_APP_KEY', kwargs['env'])
            if args[2] == 'research':
                self.json('editions/' + self.day + '-korea/research.json', {
                    'trade_date': '20261029', 'session': 'regular close',
                    'picks': [{'exchange': 'NAS', 'symbol': s, 'name': s} for s in ('AAPL', 'MSFT')],
                })
        elif stage == 'daily_pipeline.py':
            self.assertFalse(self.token.exists())
            self.assertTrue(self.envfile.exists())
            self.token.write_text('FAKE_SHARED_TOKEN')
            self.token.chmod(0o644)
            self.json('editions/' + self.day + '/market.json', {'trade_date': 'wrong' if self.failure == 'date' else '20261029'})
            if self.failure == 'movers_exist':
                self.json('editions/' + self.day + '-korea/movers.json', {})
        elif stage == 'collect_movers.py':
            self.assertTrue(self.envfile.exists())
            if self.market_cached:
                self.assertFalse(self.token.exists())
            else:
                self.assertEqual(self.token.read_text(), 'FAKE_SHARED_TOKEN')
                self.assertEqual(stat.S_IMODE(self.token.stat().st_mode), 0o600)
            if self.failure == 'collect':
                raise subprocess.TimeoutExpired('fake collect', 1)
            self.token.write_text('FAKE_FINAL_TOKEN')
        else:
            self.assert_clean()
        return types.SimpleNamespace(returncode=1 if self.failure == 'fetch' and stage == 'daily_pipeline.py' else 0)

    def generate(self):
        with patch.object(daily.subprocess, 'run', side_effect=self.stage), contextlib.redirect_stdout(io.StringIO()):
            daily.generate(self.day)

    def test_success_shares_only_quote_pair(self):
        self.token.write_text('FAKE_STALE')
        self.generate()
        self.assertEqual(self.stages, ['codex_editorial.py', 'daily_pipeline.py', 'collect_movers.py', 'codex_editorial.py', 'build_edition.py'])
        self.assert_clean()

    def test_cached_market_skips_fetch_and_starts_without_token(self):
        self.market_cached = True
        self.json('editions/' + self.day + '/market.json', {'trade_date': '20261029'})
        self.generate()
        self.assertNotIn('daily_pipeline.py', self.stages)
        self.assert_clean()

    def test_fetch_failure_cleans_and_never_composes(self):
        self.failure = 'fetch'
        with self.assertRaises(ValueError): self.generate()
        self.assertEqual(self.stages, ['codex_editorial.py', 'daily_pipeline.py'])
        self.assert_clean()

    def test_market_date_failure_cleans_retained_token(self):
        self.failure = 'date'
        with self.assertRaises(ValueError): self.generate()
        self.assert_clean()

    def test_existing_movers_failure_cleans_retained_token(self):
        self.failure = 'movers_exist'
        with self.assertRaises(ValueError): self.generate()
        self.assert_clean()

    def test_collection_timeout_cleans_and_never_composes(self):
        self.failure = 'collect'
        with self.assertRaises(subprocess.TimeoutExpired): self.generate()
        self.assertEqual(self.stages[-1], 'collect_movers.py')
        self.assert_clean()


class Health(Isolated):
    def setUp(self):
        super().setUp()
        self.json('cloud_config.json', {'codex_version': 'FAKE_VERSION'})
        for name in ('daily_pipeline.py', 'collect_movers.py', 'build_edition.py', 'codex_editorial.py', 'codex_session.mjs', 'instagram-watch.mjs', 'instagram-api.mjs', 'cloud_publish.mjs', 'cloud_daily.py', 'fetch_market.py', 'check_kis.py', 'research.schema.json', 'editorial.schema.json'):
            (self.root / name).touch()
        self.font = Path('/System/Library/Fonts/AppleSDGothicNeo.ttc')
        self.font_present = True
        original = Path.is_file
        def is_file(p):
            return self.font_present if p == self.font else original(p)
        self.enterContext(patch.object(Path, 'is_file', is_file))
        self.enterContext(patch.object(daily.sys, 'version_info', (3, 13, 0)))
        self.load = Mock()
        pillow = types.ModuleType('PIL')
        pillow.__version__ = '13.0.0'
        pillow.ImageFont = types.SimpleNamespace(truetype=self.load)
        self.enterContext(patch.dict(sys.modules, {'PIL': pillow}))
        self.run = self.enterContext(patch.object(daily.subprocess, 'run', side_effect=AssertionError('No subprocess allowed')))

    def report(self, fails=False):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            if fails:
                with self.assertRaises(ValueError): daily.health()
            else:
                daily.health()
        self.run.assert_not_called()
        report = json.loads(out.getvalue())
        self.assertEqual((report['ai_calls'], report['network'], report['publishing_enabled'], report['automation_ready']), (0, False, False, False))
        self.assertTrue(report['read_only'])
        return report

    def test_environment_success_without_human_login(self):
        report = self.report()
        self.assertTrue(report['environment_ok'])
        self.assertFalse(report['auth_ready'])
        self.assertFalse(report['private_state_ready'])
        self.assertNotIn('codex_session.enc', report['missing_files'])
        self.load.assert_called_once_with(str(self.font), 24)
        self.assertEqual(report['pillow_version'], '13.0.0')

    def test_auth_is_reported_separately_without_reading_file(self):
        (self.root / 'codex_session.enc').touch()
        report = self.report()
        self.assertTrue(report['environment_ok'])
        self.assertTrue(report['auth_ready'])

    def test_private_presence_is_separate_and_private_contents_never_read(self):
        # Invalid private JSON intentionally proves health does not parse it.
        for name in ('cloud_state.seed.json', 'cloud_state.json', 'codex_session.enc'):
            (self.root / name).write_text('TEST-NOT-JSON-NOT-AUTH')
        with patch.object(daily, 'read', wraps=daily.read) as read:
            report = self.report()
        read.assert_called_once_with(self.root / 'cloud_config.json')
        self.assertTrue(report['environment_ok'])
        self.assertTrue(report['private_state_ready'])
        self.assertTrue(report['auth_ready'])

    def test_state_without_required_seed_is_not_ready(self):
        (self.root / 'cloud_state.json').write_text('TEST-NOT-JSON')
        report = self.report()
        self.assertFalse(report['private_state_ready'])
        self.assertTrue(report['environment_ok'])

    def test_symlink_private_inputs_are_not_ready(self):
        target = self.root / 'TEST-private'
        target.touch()
        for name in ('cloud_state.seed.json', 'codex_session.enc'):
            (self.root / name).symlink_to(target)
        report = self.report()
        self.assertFalse(report['private_state_ready'])
        self.assertFalse(report['auth_ready'])
        self.assertTrue(report['environment_ok'])

    def test_missing_code_fails_environment_not_auth(self):
        (self.root / 'daily_pipeline.py').unlink()
        report = self.report(fails=True)
        self.assertFalse(report['environment_ok'])
        self.assertEqual(report['missing_files'], ['daily_pipeline.py'])

    def test_unsupported_python_fails_environment(self):
        with patch.object(daily.sys, 'version_info', (3, 12, 9)):
            report = self.report(fails=True)
        self.assertFalse(report['python_supported'])

    def test_missing_original_font_fails_without_fallback(self):
        self.font_present = False
        report = self.report(fails=True)
        self.assertFalse(report['apple_font'])
        self.load.assert_not_called()

    def test_font_file_present_but_unloadable_fails_environment(self):
        self.load.side_effect = OSError('fake invalid font')
        report = self.report(fails=True)
        self.assertTrue(report['apple_font'])
        self.assertFalse(report['pillow_font_load'])

    def test_pillow_missing_fails_environment(self):
        with patch.dict(sys.modules, {'PIL': None}):
            report = self.report(fails=True)
        self.assertFalse(report['pillow_font_load'])
        self.assertIsNone(report['pillow_version'])


if __name__ == '__main__':
    unittest.main()
