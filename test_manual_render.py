"""Synthetic quotes and mocked builder only. No Git, font, network, model, or auth."""
from datetime import datetime, timedelta, timezone
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import manual_render as manual
from test_codex_editorial import fixtures

NOW = datetime(2020, 1, 2, 21, tzinfo=timezone.utc)
DAY = '2020-01-02'


def reviewed():
    _, market, movers, editorial = fixtures()
    for data in (market, movers, editorial):
        data['session'] = 'regular close'
    movers['verification'] = {'session': 'regular close', 'verified': True, 'quotes': [
        {**{key: row[key] for key in ('symbol', 'date', 'close', 'previous_close', 'change_pct')}, 'source_ids': ['TEST']}
        for row in movers['stocks']]}
    return market, movers, editorial


class Dates(unittest.TestCase):
    def test_closed_boundary_and_age(self):
        self.assertEqual(manual.checked_date(DAY, NOW).isoformat(), DAY)
        self.assertEqual(manual.checked_date(DAY, NOW + timedelta(hours=120)).isoformat(), DAY)
        for clock in (NOW - timedelta(microseconds=1), NOW + timedelta(hours=120, microseconds=1)):
            with self.assertRaises(ValueError): manual.checked_date(DAY, clock)

    def test_reject_bad_weekend_empty_and_naive(self):
        for day in ('', '20200102', '2020-1-2', '2020-02-30', '2020-01-04', '../2020-01-02'):
            with self.subTest(day=day), self.assertRaises(ValueError): manual.checked_date(day, NOW)
        with self.assertRaises(ValueError): manual.checked_date(DAY, NOW.replace(tzinfo=None))

    def test_dst_close_uses_new_york_offset(self):
        with self.assertRaises(ValueError): manual.checked_date('2020-07-02', datetime(2020, 7, 2, 19, 59, tzinfo=timezone.utc))
        self.assertEqual(str(manual.checked_date('2020-07-02', datetime(2020, 7, 2, 20, tzinfo=timezone.utc))), '2020-07-02')


class Verification(unittest.TestCase):
    def check(self, data): manual.verify_quotes(*data, manual.checked_date(DAY, NOW))

    def test_synthetic_verified_quotes_pass(self): self.check(reviewed())

    def test_literal_booleans_required(self):
        for value in (False, 1, 'true', None):
            for target, key in ((2, 'reviewed'), (1, 'verified')):
                data = reviewed()
                (data[target] if target == 2 else data[1]['verification'])[key] = value
                with self.subTest(value=value, key=key), self.assertRaises(ValueError): self.check(data)

    def test_matching_session_and_dates_all_inputs(self):
        for target in range(3):
            for key, value in (('session', 'extended hours'), ('trade_date', '20200101')):
                data = reviewed(); data[target][key] = value
                with self.subTest(target=target, key=key), self.assertRaises(ValueError): self.check(data)

    def test_missing_duplicate_extra_and_wrong_quote(self):
        mutations = [lambda v: v.pop('verification'),
                     lambda v: v['verification'].update(session='intraday'),
                     lambda v: v['verification']['quotes'].pop(),
                     lambda v: v['verification']['quotes'].append(copy.deepcopy(v['verification']['quotes'][0])),
                     lambda v: v['verification']['quotes'][0].update(symbol='TESTOTHER'),
                     lambda v: v['verification']['quotes'][0].update(date='20200101')]
        for mutate in mutations:
            data = reviewed(); mutate(data[1])
            with self.assertRaises(ValueError): self.check(data)

    def test_every_quote_value_must_match_exactly(self):
        for field, value in (('close', '110.01'), ('previous_close', '100.01'), ('change_pct', '10.01')):
            data = reviewed(); data[1]['verification']['quotes'][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): self.check(data)

    def test_matching_but_bad_math_rejected(self):
        data = reviewed()
        data[1]['stocks'][0]['change_pct'] = '9.99'
        data[1]['verification']['quotes'][0]['change_pct'] = '9.99'
        with self.assertRaises(ValueError): self.check(data)

    def test_verification_sources_required_and_covered(self):
        for ids in ([], ['MISSING'], ['TEST', 'TEST'], [1]):
            data = reviewed(); data[1]['verification']['quotes'][0]['source_ids'] = ids
            with self.assertRaises(ValueError): self.check(data)
        data = reviewed(); data[2]['sources'][0]['supports'].remove('up.TESTU')
        with self.assertRaises(ValueError): self.check(data)

    def test_builder_source_and_index_guards_remain_active(self):
        for mutate in (lambda e: e['crosscheck']['COMP'].update(close='111'),
                       lambda e: e['sources'][0]['supports'].remove('headline'),
                       lambda e: e['up'][0].update(change_pct='9')):
            data = reviewed(); mutate(data[2])
            with self.assertRaises(ValueError): self.check(data)


class PrivateRuntime(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='TEST-manual-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.market, self.movers, self.editorial = reviewed()
        self.seed = {'baseline': [], 'receipts': []}
        self.state = {'version': 1, 'account': manual.ACCOUNT, 'root': str(self.root), 'baseline': [], 'jobs': {}}
        self.put('cloud_state.seed.json', self.seed)
        self.put('.instagram-auto/state.json', self.state)
        self.put('editions/' + DAY + '/market.json', self.market)
        self.put('editions/' + DAY + '-korea/movers.json', self.movers)
        self.put('editions/' + DAY + '-korea/editorial.json', self.editorial)
        self.final = self.root / 'editions' / (DAY + '-five-cards')

    def put(self, name, data):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data))

    def run_render(self): return manual.render(DAY, self.root, NOW)

    def mock_build(self, args, **kwargs):
        self.final.mkdir()
        self.put(str(self.final.relative_to(self.root) / 'validation.json'), {'status': 'passed', 'trade_date': '20200102', 'session': 'regular close'})
        return SimpleNamespace(returncode=0)

    def test_only_trusted_source_builder_runs_with_safe_env_and_private_root(self):
        secrets = {key: 'TEST-DO-NOT-PASS' for key in ('KIS_APP_KEY', 'IG_ACCESS_TOKEN', 'CODEX_HOME', 'CODEX_AUTH_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'PYTHONPATH', 'NODE_OPTIONS', 'HOME')}
        with patch.dict(os.environ, secrets), patch.object(manual.subprocess, 'run', side_effect=self.mock_build) as call:
            self.assertEqual(self.run_render(), self.final)
        args, kwargs = call.call_args
        self.assertEqual(len(call.call_args_list), 1)
        self.assertEqual(args[0][1:3], ['-I', str(manual.SOURCE / 'build_edition.py')])
        self.assertEqual(kwargs['cwd'], self.root)
        self.assertFalse(set(secrets) & set(kwargs['env']))
        self.assertNotIn('--overwrite', args[0])
        self.assertTrue(kwargs['capture_output'])
        self.assertFalse((self.root / 'cloud_state.json').exists())

    def test_baseline_any_final_name_blocks(self):
        self.seed['baseline'] = [DAY + '-other-cards']; self.put('cloud_state.seed.json', self.seed)
        with patch.object(manual.subprocess, 'run') as call:
            with self.assertRaises(ValueError): self.run_render()
            call.assert_not_called()

    def test_all_state_job_statuses_reserve_date(self):
        for status in ('posted', 'blocked', 'in_progress', 'observing', 'ready'):
            for date in ('20200102', DAY):
                self.state['jobs'] = {'TEST': {'status': status, 'trade_date': date}}
                self.put('.instagram-auto/state.json', self.state)
                with self.subTest(status=status, date=date), self.assertRaises(ValueError): self.run_render()

    def test_receipt_and_portable_cloud_conflicts_block(self):
        self.seed['receipts'] = [{'edition': DAY + '-five-cards', 'status': 'posted'}]
        self.put('cloud_state.seed.json', self.seed)
        with self.assertRaises(ValueError): self.run_render()
        self.seed['receipts'] = []; self.put('cloud_state.seed.json', self.seed)
        self.put('cloud_state.json', {**self.state, 'baseline': [DAY + '-five-cards']})
        with self.assertRaises(ValueError): self.run_render()

    def test_missing_materialized_or_seed_state_blocks(self):
        for file in ('cloud_state.seed.json', '.instagram-auto/state.json'):
            path = self.root / file; saved = path.read_text(); path.unlink()
            with self.assertRaises(OSError): self.run_render()
            path.write_text(saved)

    def test_existing_final_never_overwritten(self):
        self.final.mkdir(); (self.final / 'TEST').write_text('TEST-preserve')
        with patch.object(manual.subprocess, 'run') as call:
            with self.assertRaises(ValueError): self.run_render()
            call.assert_not_called()
        self.assertEqual((self.final / 'TEST').read_text(), 'TEST-preserve')

    def test_dangling_final_and_input_symlinks_rejected(self):
        self.final.symlink_to(self.root / 'TEST-missing')
        with self.assertRaises(ValueError): self.run_render()
        self.final.unlink()
        target = self.root / 'editions' / DAY / 'market.json'
        backup = self.root / 'TEST-market'; target.rename(backup); target.symlink_to(backup)
        with self.assertRaises(ValueError): self.run_render()

    def test_hardlinked_input_rejected(self):
        target = self.root / 'editions' / DAY / 'market.json'
        os.link(target, self.root / 'TEST-link')
        with self.assertRaises(ValueError): self.run_render()

    def test_symlink_directory_and_noncanonical_root_rejected(self):
        work = self.root / '.instagram-auto'; work.rename(self.root / 'TEST-state'); work.symlink_to(self.root / 'TEST-state', target_is_directory=True)
        with self.assertRaises(ValueError): self.run_render()

    def test_subprocess_failure_timeout_and_false_success_block(self):
        for result in (SimpleNamespace(returncode=1), SimpleNamespace(returncode=0)):
            with patch.object(manual.subprocess, 'run', return_value=result):
                with self.assertRaises((ValueError, OSError)): self.run_render()
        with patch.object(manual.subprocess, 'run', side_effect=subprocess.TimeoutExpired('TEST', 120)):
            with self.assertRaises(subprocess.TimeoutExpired): self.run_render()

    def test_invalid_review_blocks_before_subprocess(self):
        self.editorial['reviewed'] = False; self.put('editions/' + DAY + '-korea/editorial.json', self.editorial)
        with patch.object(manual.subprocess, 'run') as call:
            with self.assertRaises(ValueError): self.run_render()
            call.assert_not_called()


if __name__ == '__main__': unittest.main()
