"""Offline layout/package regression with synthetic evidence only."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from PIL import Image
import build_edition as b
from test_codex_editorial import fixtures

class LayoutTests(unittest.TestCase):
    def test_five_and_six_card_packages_and_refresh(self):
        for focus in (False, True):
            with self.subTest(focus=focus), tempfile.TemporaryDirectory() as tmp:
                _, m, movers, e = fixtures()
                e['up'][0]['name'] = movers['stocks'][0]['name'] = '마이크로소프트'
                e['up'][0]['business'] = '합성 테스트'
                for item in e['korea']:item['body']='가나다라마바사 아자차카타파하 가나다라마 바사아자차 카타파하 가나다라마 바사아자차 카타파하 가나다라마 바사아자차'
                e['up'][0]['metrics'] = [{'label':'합성 수치','value':'12%','period':'TEST','source_ids':['TEST']}]
                e['up'][0]['takeaway'] = '합성 테스트 요약'
                if focus:
                    e['sources'][0]['supports'].append('focus.0')
                    e['focus'] = [{'title':'핵심 수치 비교', 'body':'합성 데이터 설명입니다.\n실제 투자정보가 아닙니다.', 'source_ids':['TEST'], 'metrics':[{'label':'합성 비교','value':'최소 10%대 중반','period':'TEST','source_ids':['TEST']}], 'subject':'합성 기업', 'subtitle':'합성 수치 비교', 'takeaway':'합성 요약'}]
                out = b.build(m, e, Path(tmp)/'cards', movers)
                n = 6 if focus else 5
                self.assertEqual(len(list(out.glob('*.png'))), n)
                self.assertEqual(len(list((out/'api-images').glob('*.jpg'))), n)
                self.assertEqual(json.loads((out/'validation.json').read_text())['card_count'], n)
                b.refresh_caption(m, e, movers, out)
                with zipfile.ZipFile(out/'cards.zip') as z:
                    self.assertIn(f'{n:02d}.png', z.namelist())
                    self.assertEqual(len(z.namelist()), n+2)
                with Image.open(out/'01.png') as im:self.assertEqual(im.size,(1080,1350))

    def test_focus_requires_claim_coverage(self):
        _,m,v,e=fixtures()
        e['focus']=[{'title':'TEST','body':'TEST','source_ids':['TEST']}]
        with self.assertRaisesRegex(ValueError,'focus.0'):b.validate(m,e,v)

    def test_long_body_is_rejected_not_shrunk(self):
        _,m,v,e=fixtures();e['up'][0]['why']='가나다라마바사 '*100
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)/'cards'
            with self.assertRaisesRegex(ValueError,'overflow'):b.build(m,e,out,v)
            self.assertFalse(out.exists())

    def test_metrics_require_matching_evidence(self):
        _,m,v,e=fixtures()
        e['up'][0]['metrics']=[{'label':'TEST','value':'12%','period':'TEST','source_ids':['MISSING']}]
        with self.assertRaises(ValueError):b.validate(m,e,v)
