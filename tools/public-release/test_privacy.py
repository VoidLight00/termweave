import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import sys
from unittest.mock import patch

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

    def test_detached_head_without_refs_still_scans_history(self):
        self.write('old.py', 'sk-' + 'D' * 30)
        self.commit()
        branch = self.git('symbolic-ref', 'HEAD').decode().strip()
        self.git('checkout', '--detach', '-q')
        self.git('update-ref', '-d', branch)
        self.assertEqual(self.git('for-each-ref'), b'')
        self.assertTrue(any(f['scope'] == 'history' and f['category'] == 'credential'
                            for f in self.scan()['findings']))

    def test_history_read_failure_is_not_empty_history(self):
        audit = privacy.Audit(self.root)
        original = audit.git
        def failed(*args):
            if args[0] == 'rev-list':
                raise RuntimeError('synthetic history failure')
            return original(*args)
        audit.git = failed
        self.assertIn('repository_scan_incomplete', audit.run()['counts'])

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

class UnbornPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q', '-b', 'main')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args],
                              capture_output=True, check=True).stdout

    def scan(self):
        return privacy.Audit(self.root).run()

    def test_empty_and_staged_clean_repository(self):
        self.assertEqual(self.scan()['status'], 'PASS')
        (self.root / 'main.py').write_text('print("clean")\n')
        self.git('add', '-A')
        result = self.scan()
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['scanned_items'], 2)

    def test_unborn_index_and_current_scanned_independently(self):
        (self.root / 'main.py').write_text('sk-' + 'S' * 30)
        self.git('add', '-A')
        (self.root / 'main.py').write_text('clean')
        (self.root / 'new.py').write_text('sk-' + 'T' * 30)
        result = self.scan()
        self.assertEqual(result['status'], 'FAIL')
        self.assertEqual({f['scope'] for f in result['findings']
                          if f['category'] == 'credential'}, {'index', 'current'})
        self.assertNotIn('repository_scan_incomplete', result['counts'])

    def test_corrupt_or_nonempty_refs_are_not_unborn(self):
        for oid in ('not-an-object', 'a' * 40):
            with self.subTest(oid=oid):
                ref = self.root / '.git/refs/heads/broken'
                ref.write_text(oid + '\n')
                self.assertIn('repository_scan_incomplete', self.scan()['counts'])
                ref.unlink()

    def test_invalid_detached_head_is_not_unborn(self):
        (self.root / '.git/HEAD').write_text('a' * 40 + '\n')
        self.assertIn('repository_scan_incomplete', self.scan()['counts'])

    def test_git_failures_are_not_empty_history(self):
        original = subprocess.run
        for command in ('for-each-ref', 'rev-parse', 'symbolic-ref', 'cat-file'):
            with self.subTest(command=command):
                def failed(args, **kwargs):
                    if args[0] == 'git' and args[3] == command:
                        return subprocess.CompletedProcess(args, 128, b'', b'synthetic error')
                    return original(args, **kwargs)
                with patch.object(privacy.subprocess, 'run', side_effect=failed):
                    self.assertEqual(self.scan()['status'], 'FAIL')

    def test_head_probe_error_is_not_unborn(self):
        original = subprocess.run
        for code in (1, 128):
            with self.subTest(code=code):
                def failed(args, **kwargs):
                    if args[3:] == ['rev-parse', '--verify', '--quiet', 'HEAD']:
                        return subprocess.CompletedProcess(args, code, b'', b'synthetic error')
                    return original(args, **kwargs)
                with patch.object(privacy.subprocess, 'run', side_effect=failed):
                    self.assertIn('repository_scan_incomplete', self.scan()['counts'])

    def test_unborn_cli_exit_codes(self):
        script = str(Path(__file__).with_name('privacy.py'))
        for dirty, expected in ((False, 0), (True, 1)):
            if dirty:
                (self.root / 'main.py').write_text('ghp_' + 'U' * 30)
                self.git('add', '-A')
            result = subprocess.run([sys.executable, script, str(self.root)], capture_output=True)
            self.assertEqual(result.returncode, expected)
            self.assertEqual(json.loads(result.stdout)['status'], 'FAIL' if dirty else 'PASS')

    def test_build_guard_blocks_commit_without_running_export(self):
        build = Path(__file__).with_name('build_public.sh').read_text()
        start = build.index('git -C "$out" add -A\n')
        stop = build.index('src=', start)
        guard = build[start:stop]
        self.assertIn('python3 "$repo/tools/public-release/privacy.py" "$out"', guard)
        self.assertLess(stop, build.index('git -C "$out" commit'))
        self.assertIn('"$harness" leakscan "$out" --public', build)
        # Execute only the real staging/guard block, never the exporter or a commit.
        # A function records whether control could reach the next (commit) operation.
        repo = Path(__file__).resolve().parents[2]
        script = 'set -euo pipefail\nrepo=$1\nout=$2\n' + guard
        script += 'commit_probe() { touch "$3"; }\ncommit_probe "$@"\n'
        marker = self.root / '.git/commit-reached'
        for dirty, expected in ((False, 0), (True, 1)):
            with self.subTest(dirty=dirty):
                marker.unlink(missing_ok=True)
                (self.root / 'main.py').write_text('sk-' + 'V' * 30 if dirty else 'clean')
                result = subprocess.run(['zsh', '-c', script, 'guard-test', str(repo),
                                         str(self.root), str(marker)], capture_output=True)
                self.assertEqual(result.returncode, expected)
                self.assertEqual(marker.exists(), not dirty)
                self.assertEqual(self.git('for-each-ref'), b'')


class EmailBoundaryTests(unittest.TestCase):
    def test_patch_filename_tokens_are_not_emails(self):
        for token in (b'@xterm%2Fxterm@5.5.0.patch', b'patches/@xterm%2Fxterm@5.5.0.patch',
                      b'"@xterm%2Fxterm@5.5.0.patch"', b'@scope%2Fpkg@1.2.3.patch'):
            with self.subTest(token=token):
                self.assertIsNone(privacy.EMAIL.search(token))
                audit = privacy.Audit('.')
                audit.inspect('package.json', '', 'current', token)
                self.assertEqual(audit.findings, [])
                self.assertEqual(privacy.safe_path(token.decode()), token.decode())

    def test_real_email_token_boundaries(self):
        address = b'private.person+tag@personal-provider.org'
        for text in (address, b'<' + address + b'>', b'"' + address + b'"',
                     b'Contact: ' + address + b'.', b'mailto:' + address,
                     address + b', next', b'(' + address + b')'):
            with self.subTest(text=text):
                self.assertEqual(privacy.EMAIL.search(text).group(), address)
                audit = privacy.Audit('.')
                audit.inspect('source.py', '', 'current', text)
                self.assertEqual([f['category'] for f in audit.findings], ['personal_email'])
        self.assertTrue(privacy.safe_path(address.decode()).startswith('[path-sha256:'))

    def test_patch_like_real_email_is_not_blanket_excluded(self):
        for address in (b'author@release.patch', b'author@5.5.0.patch',
                        b'person%tag@personal-provider.org'):
            self.assertEqual(privacy.EMAIL.search(address).group(), address)

    def test_email_domain_not_truncated_to_example_exception(self):
        audit = privacy.Audit('.')
        audit.inspect('source.py', '', 'current', b'person@example.com.private-provider.org')
        self.assertEqual([f['category'] for f in audit.findings], ['personal_email'])


if __name__ == '__main__':
    unittest.main()
