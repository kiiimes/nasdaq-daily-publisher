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
