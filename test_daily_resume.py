import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import cloud_daily as daily

class ResumeTests(unittest.TestCase):
    def run_case(self,status,exists=False):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            state={'baseline':[],'jobs':{'test':{'trade_date':'20261030','status':status}}}
            (root/'cloud_state.seed.json').write_text(json.dumps(state))
            if exists:(root/'editions/2026-10-30-five-cards').mkdir(parents=True)
            with patch.object(daily,'ROOT',root),patch.object(daily,'child') as child:
                result=daily.generate('2026-10-30')
                child.assert_not_called()
                return result
    def test_posted_date_skips_generation_and_publication(self):
        self.assertIs(self.run_case('posted'),False)
    def test_existing_unposted_edition_is_handed_to_strict_publish_watcher(self):
        self.assertIs(self.run_case('ready',True),True)
    def test_uncertain_claim_never_retries(self):
        for status in ('in_progress','blocked'):
            with self.assertRaises(ValueError):self.run_case(status,True)

    def test_quote_mismatch_research_is_bounded_and_keeps_date(self):
        for always_fail in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory)
                (root/'cloud_state.seed.json').write_text('{"baseline":[],"jobs":{}}')
                attempts=[]
                def child(args,**kwargs):
                    self.assertIn('2020-01-02',args)
                    if args[1]=='codex_editorial.py' and args[2]=='research':
                        attempts.append(args)
                        target=root/'editions/2020-01-02-korea/research.json'
                        target.write_text(json.dumps({'trade_date':'20200102','session':'regular close','picks':[{'exchange':'NAS','symbol':s,'name':s} for s in ('TESTU','TESTD')]}))
                    elif args[1]=='daily_pipeline.py':
                        target=root/'editions/2020-01-02/market.json';target.parent.mkdir(parents=True,exist_ok=True);target.write_text('{"trade_date":"20200102"}')
                    elif args[1]=='codex_editorial.py' and args[2]=='compose':
                        if always_fail or len(attempts)==1:raise daily.IndependentQuoteMismatch('synthetic')
                with patch.object(daily,'ROOT',root),patch.object(daily,'child',side_effect=child):
                    if always_fail:
                        with self.assertRaises(daily.IndependentQuoteMismatch):daily.generate('2020-01-02')
                    else:
                        # Renderer does not take a --date argument.
                        original=child
                        def dispatch(args,**kwargs):
                            if args[1]!='build_edition.py':return original(args,**kwargs)
                        with patch.object(daily,'child',side_effect=dispatch):self.assertTrue(daily.generate('2020-01-02'))
                self.assertEqual(len(attempts),2)

    def test_saved_inputs_resume_only_renderer_and_keep_failure_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'cloud_state.seed.json').write_text('{"baseline":[],"jobs":{}}')
            work=root/'editions/2026-11-06-korea';work.mkdir(parents=True)
            for name in ('editorial.json','movers.json'):(work/name).write_text('{}')
            with patch.object(daily,'ROOT',root),patch.object(daily,'child') as child:
                self.assertTrue(daily.generate('2026-11-06'))
                self.assertEqual(child.call_args.args[0][1],'build_edition.py')
                self.assertEqual(child.call_count,1)
                child.side_effect=ValueError('invalid saved input')
                with self.assertRaises(ValueError):daily.generate('2026-11-06')
