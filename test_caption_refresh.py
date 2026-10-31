import tempfile
from pathlib import Path
import unittest
import zipfile
import build_edition as b
from test_codex_editorial import fixtures
class RefreshTests(unittest.TestCase):
    def test_caption_refresh_preserves_images_and_updates_matching_zip(self):
        _,m,v,e=fixtures()
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)/'edition';out.mkdir()
            for name in b.ZIP_FILES:(out/name).write_bytes(('TEST '+name).encode())
            images={p.name:p.read_bytes() for p in out.glob('*.png')}
            b.refresh_caption(m,e,v,out)
            caption=(out/'caption.txt').read_text()
            for emoji in ('🇺🇸','📊','📈','📉','🇰🇷'):self.assertIn(emoji,caption)
            with zipfile.ZipFile(out/'cards.zip') as z:self.assertEqual(z.read('caption.txt'),(out/'caption.txt').read_bytes())
            self.assertEqual(images,{p.name:p.read_bytes() for p in out.glob('*.png')})
