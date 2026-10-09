import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('assets',Path(__file__).with_name('assets.py'))
assets=importlib.util.module_from_spec(spec);spec.loader.exec_module(assets)

class AssetTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        source=Path(__file__).resolve().parents[2]
        self.row=json.loads(Path(__file__).with_name('verified-fonts.json').read_text())[0]
        self.responses={}
        for field,remote in [('path','source'),('license_path','license_source')]:
            data=(source/self.row[field]).read_bytes();p=self.root/self.row[field];p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
            self.responses[self.row[remote]]=data
        self.manifest=self.root/'manifest.json';self.save()
    def save(self):self.manifest.write_text(json.dumps([self.row]))
    def load(self):
        with patch.object(assets,'fetch_pinned',side_effect=lambda url:self.responses[url]):
            return assets.VerifiedAssets(self.root,self.manifest,lambda data:None)
    def test_exact_official_font_parses_and_mutation_fails(self):
        verified=self.load();data=(self.root/self.row['path']).read_bytes()
        self.assertTrue(verified.accepts(self.row['path'],data))
        self.assertFalse(verified.accepts(self.row['path'],data+b'x'))
        self.assertFalse(verified.accepts('other.woff2',data))
    def test_changed_local_hash_fails(self):
        (self.root/self.row['path']).write_bytes(b'bad')
        with self.assertRaisesRegex(ValueError,'asset_hash_mismatch'):self.load()
    def test_remote_mismatch_fails(self):
        self.responses[self.row['source']]=b'changed'
        with self.assertRaisesRegex(ValueError,'asset_upstream_mismatch'):self.load()
    def test_mismatched_license_revision_fails(self):
        previous=self.row['license_source'];self.row['license_source']=previous.replace(previous.split('/')[5],'f'*40)
        self.responses[self.row['license_source']]=self.responses[previous];self.save()
        with self.assertRaisesRegex(ValueError,'asset_license_revision_mismatch'):self.load()
    def test_metadata_scanner_is_invoked(self):
        count=[]
        with patch.object(assets,'fetch_pinned',side_effect=lambda url:self.responses[url]):
            assets.VerifiedAssets(self.root,self.manifest,lambda data:count.append(len(data)))
        self.assertGreater(len(count),5)
    def test_unpinned_or_unknown_origin_refused_before_network(self):
        for url in ['https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt', 'https://raw.githubusercontent.com/unknown/fonts/'+'a'*40+'/font.ttf','http://localhost/font.ttf']:
            with self.assertRaisesRegex(ValueError,'untrusted_asset_origin'):assets.fetch_pinned(url)
    def test_png_not_covered_by_font_verifier(self):
        self.row['format']='png';self.save()
        with self.assertRaisesRegex(ValueError,'invalid_asset_format'):self.load()

if __name__=='__main__':unittest.main()
