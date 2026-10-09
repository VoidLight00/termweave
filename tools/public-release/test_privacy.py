import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('privacy', Path(__file__).with_name('privacy.py'))
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)

class PrivacyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Synthetic Author')
        self.git('config', 'user.email', 'author@example.invalid')
        self.write('main.py', 'print("synthetic")\n')
        self.commit()

    def git(self, *args):
        r = subprocess.run(['git', '-C', str(self.root), *args], capture_output=True)
        self.assertEqual(r.returncode, 0)
        return r.stdout

    def write(self, name, data):
        p = self.root/name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data.encode() if isinstance(data, str) else data)

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'synthetic fixture')

    def scan(self, **kwargs):
        return privacy.Audit(self.root, **kwargs).run()

    def test_clean_source(self):
        self.assertEqual(self.scan()['status'], 'PASS')

    def test_secret_only_in_history(self):
        secret = 'sk-' + 'Z'*30
        self.write('old.py', secret)
        self.commit()
        self.git('rm', 'old.py')
        self.commit()
        r = self.scan()
        self.assertTrue(any(x['category']=='credential' and x['scope']=='history' for x in r['findings']))
        self.assertNotIn(secret, json.dumps(r))

    def test_current_and_staged_independent(self):
        self.write('main.py', '/Users/' + 'synthetic-person' + '/private')
        self.git('add', '.')
        self.write('main.py', 'clean')
        r = self.scan()
        self.assertTrue(any(x['scope']=='index' and x['category']=='personal_home' for x in r['findings']))

    def test_artifacts_and_private_address(self):
        self.write('.env', 'benign')
        self.write('devices/state.json', '{}')
        self.write('debug.log', 'benign')
        self.write('src/address.py', '10.' + '24.25.26')
        r = self.scan()
        self.assertGreaterEqual(r['counts']['private_artifact'], 3)
        self.assertIn('private_endpoint', r['counts'])

    def test_oss_notices_retained(self):
        body = 'MIT License\nCopyright 2026 Contributor <maintainer@public-oss.org>\n'
        self.write('LICENSE', body)
        self.commit()
        self.assertEqual(self.scan()['status'], 'PASS')
        self.assertEqual((self.root/'LICENSE').read_text(), body)

    def test_notice_cannot_hide_credentials(self):
        self.write('LICENSE', 'MIT\n' + 'sk-' + 'Q'*30)
        self.assertIn('credential', self.scan()['counts'])

    def test_unsupported_artifact_and_lfs(self):
        self.write('assets/screen.png', b'PNG synthetic metadata')
        self.write('large', 'version https://git-lfs.github.com/spec/v1\noid sha256:'+'a'*64+'\nsize 20\n')
        r = self.scan()
        self.assertIn('unsupported_artifact', r['counts'])
        self.assertIn('unverified_lfs_object', r['counts'])
        self.assertTrue(any(x['incomplete'] for x in r['findings']))

    def test_oversize_and_unreadable(self):
        self.write('big.txt', 'x'*101)
        self.write('locked.txt', 'private')
        (self.root/'locked.txt').chmod(0)
        self.addCleanup(lambda: (self.root/'locked.txt').chmod(0o600))
        r = self.scan(max_bytes=100)
        self.assertIn('oversize_unscanned', r['counts'])
        self.assertIn('unreadable_current_file', r['counts'])

    def test_exact_fixture_exception(self):
        text = ('sk-'+'F'*30).encode()
        self.write('tests/fixtures/credential.txt', text)
        allow = Path(self.temp.name).parent / (self.root.name+'-allow.json')
        self.addCleanup(lambda: allow.unlink(missing_ok=True))
        allow.write_text(json.dumps([{'path':'tests/fixtures/credential.txt','sha256':hashlib.sha256(text).hexdigest(),'category':'credential','reason':'Synthetic sentinel used only to test rejection.'}]))
        self.assertEqual(self.scan(allowlist=allow)['status'], 'PASS')
        self.write('tests/fixtures/credential.txt', text+b' changed')
        self.assertEqual(self.scan(allowlist=allow)['status'], 'FAIL')

    def test_broad_exception_refused(self):
        allow=self.root/'allow.json'
        allow.write_text(json.dumps([{'path':'*','sha256':'0'*64,'category':'credential','reason':'Broad exclusion must always be rejected.'}]))
        self.assertIn('invalid_fixture_allowlist', self.scan(allowlist=allow)['counts'])

    def test_personal_email_outside_notice(self):
        self.write('src/user.txt', 'private.person@personal-provider.org')
        r=self.scan()
        self.assertIn('personal_email', r['counts'])
        self.assertNotIn('private.person@personal-provider.org', json.dumps(r))

    def test_nonregular_symlink(self):
        (self.root/'outside').symlink_to('/does-not-exist')
        self.assertIn('nonregular_file', self.scan()['counts'])

    def test_ignored_env_is_not_silent_pass(self):
        self.write('.gitignore', '.env\n')
        self.write('.env', 'synthetic')
        self.assertIn('ignored_private_artifact', self.scan()['counts'])

    def test_truncated_history_blob_is_incomplete(self):
        audit = privacy.Audit(self.root)
        original = audit.git
        def broken(*args):
            data = original(*args)
            if args[:2] == ('cat-file', 'blob'):
                return data[:-1]
            return data
        audit.git = broken
        r = audit.run()
        self.assertIn('truncated_blob', r['counts'])

    def test_unreadable_history_blob_is_incomplete(self):
        audit = privacy.Audit(self.root)
        original = audit.git
        def broken(*args):
            if args[:2] == ('cat-file', 'blob'):
                raise RuntimeError('synthetic failure')
            return original(*args)
        audit.git = broken
        self.assertIn('unreadable_blob', audit.run()['counts'])

    def test_archive_and_binary_fail(self):
        self.write('archive.zip', b'PK\x00synthetic')
        self.write('unknown.dat', b'\x00synthetic')
        r = self.scan()
        self.assertIn('unsupported_artifact', r['counts'])
        self.assertEqual(r['counts']['binary_unverified'], 2)

    def test_notice_unrelated_email_still_requires_review(self):
        self.write('LICENSE', 'MIT License\nPrivate contact: person@private-mail.org\n')
        self.assertIn('personal_email', self.scan()['counts'])

    def test_verified_asset_cannot_bypass_private_artifact_path(self):
        from unittest.mock import Mock
        audit=privacy.Audit(self.root)
        audit.assets=Mock()
        audit.assets.accepts.return_value=True
        audit.inspect('credentials/font.ttf','','current',b'official font bytes')
        self.assertTrue(any(x['category']=='private_artifact' for x in audit.findings))

    def test_cli_exit_codes_and_no_values(self):
        script = str(Path(__file__).with_name('privacy.py'))
        import sys
        clean = subprocess.run([sys.executable, script, str(self.root)], capture_output=True)
        self.assertEqual(clean.returncode, 0)
        secret = 'ghp_' + 'S'*30
        self.write('main.py', secret)
        failed = subprocess.run([sys.executable, script, str(self.root)], capture_output=True)
        self.assertEqual(failed.returncode, 1)
        self.assertNotIn(secret.encode(), failed.stdout + failed.stderr)

if __name__ == '__main__':
    unittest.main()
