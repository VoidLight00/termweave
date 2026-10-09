import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('exporter',Path(__file__).with_name('export_candidate.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name).resolve();self.root=self.base/'source';self.root.mkdir()
        module.git(self.root,'init','-q')
        (self.root/'LICENSE').write_text('MIT License\nCopyright 2026 Synthetic Author\n')
        (self.root/'main.py').write_text('print("safe")\n')
        module.git(self.root,'add','.');module.git(self.root,'commit','-qm','synthetic')
        self.manifest=self.base/'manifest.json';self.destination=self.base/'candidate'
        self.plan()
    def plan(self,paths=('LICENSE','main.py')):
        rows=[{'path':p,'sha256':hashlib.sha256((self.root/p).read_bytes()).hexdigest(),'mode':'100644'} for p in paths]
        self.manifest.write_text(json.dumps({'version':1,'source_commit':module.git(self.root,'rev-parse','HEAD').decode().strip(),'files':rows}))
    def run_export(self):return module.export(self.root,self.manifest,self.destination)
    def test_exact_snapshot_without_history_private_files_or_remote(self):
        (self.root/'private.log').write_text('private history')
        module.git(self.root,'add','.');module.git(self.root,'commit','-qm','private log')
        self.plan()
        original=module.git(self.root,'rev-parse','HEAD')
        result=self.run_export()
        self.assertEqual(result['status'],'PASS');self.assertTrue(result['source_preserved'])
        self.assertFalse((self.destination/'private.log').exists())
        self.assertEqual(module.git(self.destination,'rev-list','--count','HEAD').strip(),b'1')
        self.assertEqual(module.git(self.destination,'remote').strip(),b'')
        self.assertEqual(module.git(self.root,'rev-parse','HEAD'),original)
        self.assertEqual(self.destination.stat().st_mode & 0o777,0o700)
    def test_changed_hash_refuses_before_output(self):
        (self.root/'main.py').write_text('changed')
        with self.assertRaisesRegex(ValueError,'source_changed'):self.run_export()
        self.assertFalse(self.destination.exists())
    def test_symlink_refused(self):
        (self.root/'linked.py').symlink_to(self.root/'main.py');self.plan(('LICENSE','linked.py'))
        with self.assertRaisesRegex(ValueError,'source_symlink'):self.run_export()
    def test_explicit_private_file_refused(self):
        (self.root/'private.log').write_text('safe-looking');self.plan(('LICENSE','private.log'))
        with self.assertRaisesRegex(ValueError,'private_or_unsafe_path'):self.run_export()
    def test_sensitive_content_is_not_reported_as_publishable(self):
        secret='ghp_'+'Z'*30;(self.root/'main.py').write_text(secret);self.plan()
        result=self.run_export()
        self.assertEqual(result['status'],'FAIL');self.assertNotIn(secret,json.dumps(result))
        self.assertFalse(result['published'])
    def test_missing_runtime_fails_before_export_unless_inspection_requested(self):
        (self.root/'src').mkdir();(self.root/'src/app.ts').write_text('export const ready=true;')
        result=self.run_export()
        self.assertEqual(result['status'],'FAIL');self.assertFalse(self.destination.exists())
        self.assertEqual(result['missing_required'],[{'path':'src/app.ts','category':'runtime_build_or_verification'}])
        result=module.export(self.root,self.manifest,self.destination,audit_incomplete=True)
        self.assertEqual(result['privacy_status'],'PASS');self.assertEqual(result['status'],'FAIL')
        self.assertFalse(result['publish_ready'])
    def test_missing_dependency_notice_fails(self):
        (self.root/'docs').mkdir();(self.root/'docs/dependency-notices.md').write_text('Synthetic attribution')
        result=self.run_export()
        self.assertEqual(result['completeness'],'FAIL')
        self.assertEqual(result['missing_required'][0]['category'],'source_attribution')

    def test_existing_destination_never_overwritten(self):
        self.destination.mkdir()
        with self.assertRaisesRegex(ValueError,'destination_must_be_new'):self.run_export()

if __name__=='__main__':unittest.main()
