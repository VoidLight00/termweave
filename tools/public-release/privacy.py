#!/usr/bin/env python3
"""Read-only public-source privacy gate. Findings contain no matched content."""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys

MAX_BYTES = 8 * 1024 * 1024
PATTERNS = {
    'personal_home': re.compile(rb'(?:/Users/|/home/)[A-Za-z0-9_.-]{1,100}/|[A-Za-z]:\\Users\\[^\\\r\n]{1,100}\\'),
    'credential': re.compile(rb'(?:sk-[A-Za-z0-9_-]{20,128}|gh[pousr]_[A-Za-z0-9]{20,128}|github_pat_[A-Za-z0-9_]{20,200}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{8,500}\.eyJ[A-Za-z0-9_-]{8,1000}\.[A-Za-z0-9_-]{8,500})'),
    'auth_value': re.compile(rb'(?i)(?:authorization\s*[:=]\s*[\"\x27]?\s*bearer\s+[A-Za-z0-9_.-]{12,200}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[\"\x27][A-Za-z0-9_./+=-]{12,200}[\"\x27])'),
    'private_endpoint': re.compile(rb'(?<![\d.])(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?![\d.])|https?://[A-Za-z0-9.-]+\.(?:internal|local)(?:[:/]|\b)'),
}
EMAIL = re.compile(rb'[A-Za-z0-9_.+-]{1,80}@[A-Za-z0-9.-]{1,80}\.[A-Za-z]{2,20}')
ARTIFACT_EXT = {'.log', '.db', '.sqlite', '.sqlite3', '.enex', '.har', '.pcap', '.pem', '.key', '.p12', '.pfx'}
UNSUPPORTED_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.mp4', '.mov', '.webm', '.woff', '.woff2', '.ttf', '.otf'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(path):
    raw = path.encode('utf-8', 'surrogateescape')
    if path.startswith('/') or '..' in PurePosixPath(path).parts or any(ord(c) < 32 for c in path) or EMAIL.search(raw) or any(p.search(raw) for p in PATTERNS.values()):
        return '[path-sha256:' + digest(raw) + ']'
    return path


class Audit:
    def __init__(self, root, allowlist=None, max_bytes=MAX_BYTES, asset_manifest=None):
        self.root = Path(root).resolve()
        self.limit = max_bytes
        self.findings = []
        self.exceptions = []
        self.scanned = 0
        self.allowed = 0
        self.seen = set()
        self.assets = None
        if asset_manifest:
            try:
                import importlib.util
                spec = importlib.util.spec_from_file_location('release_assets', Path(__file__).with_name('assets.py'))
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                def scan_metadata(data):
                    if any(pattern.search(data) for pattern in PATTERNS.values()):
                        raise ValueError('unsafe_asset_metadata')
                self.assets = module.VerifiedAssets(self.root, asset_manifest, scan_metadata)
            except Exception:
                self.issue('asset_verification_failed', incomplete=True)
        if allowlist:
            self.load_exceptions(allowlist)

    def issue(self, category, path='', blob='', scope='', incomplete=False):
        self.findings.append({'category': category, 'path': safe_path(path), 'blob': blob, 'scope': scope, 'incomplete': incomplete})

    def git(self, *args):
        result = subprocess.run(['git', '-C', str(self.root), *args], capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('git_read_failed')
        return result.stdout

    def load_exceptions(self, file):
        try:
            entries = json.loads(Path(file).read_text())
            if not isinstance(entries, list):
                raise ValueError()
            for x in entries:
                if set(x) != {'path', 'sha256', 'category', 'reason'} or not isinstance(x['reason'], str) or len(x['reason'].strip()) < 20:
                    raise ValueError()
                if x['category'] not in set(PATTERNS) | {'personal_email'} or not re.fullmatch(r'[a-f0-9]{64}', x['sha256']):
                    raise ValueError()
                p = x['path']
                if safe_path(p) != p or not re.fullmatch(r'[A-Za-z0-9_./-]+', p) or not any(t in PurePosixPath(p).parts for t in ('tests', 'fixtures', '__tests__')):
                    raise ValueError()
            self.exceptions = entries
        except Exception:
            self.issue('invalid_fixture_allowlist', incomplete=True)

    def matched(self, category, path, blob, scope, data):
        if any(x['path'] == path and x['category'] == category and x['sha256'] == digest(data) for x in self.exceptions):
            self.allowed += 1
        else:
            self.issue(category, path, blob, scope)

    def inspect(self, path, blob, scope, data):
        key = (path, blob or digest(data), scope)
        if key in self.seen:
            return
        self.seen.add(key)
        verified_asset = bool(self.assets and self.assets.accepts(path, data))
        if len(data) > self.limit and not verified_asset:
            self.issue('oversize_unscanned', path, blob, scope, True)
            return
        self.scanned += 1
        parts = PurePosixPath(path).parts
        base = PurePosixPath(path).name.lower()
        suffix = PurePosixPath(path).suffix.lower()
        if base == '.env' or base.startswith('.env.') or suffix in ARTIFACT_EXT or any(x.lower() in {'sessions', 'devices', 'cookies', 'credentials', 'secrets', 'backups', 'evidence'} for x in parts) or re.search(r'(?:device|session|cookie|credential|token)[-_](?:registry|store|state|dump|snapshot)\.(?:json|jsonl|yaml|yml)$', base):
            self.issue('private_artifact', path, blob, scope)
        if verified_asset:
            return
        if suffix in UNSUPPORTED_EXT:
            self.issue('unsupported_artifact', path, blob, scope, True)
        if data.startswith(b'version https://git-lfs.github.com/spec/v1'):
            self.issue('unverified_lfs_object', path, blob, scope, True)
        if b'\0' in data:
            self.issue('binary_unverified', path, blob, scope, True)
            return
        try:
            data.decode('utf-8')
        except UnicodeDecodeError:
            self.issue('non_utf8_unverified', path, blob, scope, True)
            return
        for category, pattern in PATTERNS.items():
            if pattern.search(data):
                self.matched(category, path, blob, scope, data)
        # Preserve OSS notice contacts without suppressing other privacy categories.
        notice = bool(re.fullmatch(r'(?:license|licence|copying|notice|third_party_notices)(?:[.-].*)?', base)) or bool(self.assets and self.assets.is_notice(path, data))
        for line in data.splitlines():
            for match in EMAIL.finditer(line):
                email = match.group().lower()
                domain = email.split(b'@')[-1]
                if domain in {b'example.com', b'example.org', b'example.net', b'example.invalid'} or domain.endswith(b'.invalid'):
                    continue
                if notice and (b'copyright' in line.lower() or b'spdx-filecopyrighttext:' in line.lower()):
                    continue
                self.matched('personal_email', path, blob, scope, data)
                return

    def blob(self, path, oid, scope, mode):
        if mode not in {'100644', '100755', ''}:
            self.issue('unsupported_git_mode', path, oid, scope, True)
            return
        try:
            size = int(self.git('cat-file', '-s', oid))
            asset_limit = 16 * 1024 * 1024 if self.assets and path in self.assets.records else self.limit
            if size > asset_limit:
                self.issue('oversize_unscanned', path, oid, scope, True)
                return
            data = self.git('cat-file', 'blob', oid)
            if len(data) != size:
                self.issue('truncated_blob', path, oid, scope, True)
                return
            self.inspect(path, oid, scope, data)
        except Exception:
            self.issue('unreadable_blob', path, oid, scope, True)

    def run(self):
        try:
            if (self.root / '.git').exists() is False:
                raise RuntimeError()
            if self.git('rev-parse', '--is-shallow-repository').strip() != b'false':
                self.issue('shallow_history', incomplete=True)
            if self.git('replace', '-l').strip():
                self.issue('git_replace_objects', incomplete=True)
            graft = self.git('rev-parse', '--git-path', 'info/grafts').decode().strip()
            gp = Path(graft) if Path(graft).is_absolute() else self.root / graft
            if gp.exists() and gp.stat().st_size:
                self.issue('git_grafts', incomplete=True)
            refs_before = self.git('show-ref')
            index_before = self.git('ls-files', '--stage', '-z')
            entries = index_before.split(b'\0')
            tracked = set()
            for entry in entries:
                if not entry:
                    continue
                meta, raw = entry.split(b'\t', 1)
                mode, oid, stage = meta.decode().split()
                path = raw.decode('utf-8', 'surrogateescape')
                tracked.add(path)
                if stage != '0':
                    self.issue('unmerged_index', path, oid, 'index', True)
                self.blob(path, oid, 'index', mode)
            untracked = self.git('ls-files', '--others', '--exclude-standard', '-z').split(b'\0')
            paths = tracked | {x.decode('utf-8', 'surrogateescape') for x in untracked if x}
            ignored = self.git('ls-files', '--others', '--ignored', '--exclude-standard', '-z').split(b'\0')
            for raw in ignored:
                if not raw:
                    continue
                path = raw.decode('utf-8', 'surrogateescape')
                pp = PurePosixPath(path)
                if pp.name == '.env' or pp.name.startswith('.env.') or pp.suffix.lower() in ARTIFACT_EXT or any(x.lower() in {'sessions', 'devices', 'cookies', 'credentials', 'secrets', 'backups', 'evidence'} for x in pp.parts):
                    self.issue('ignored_private_artifact', path, scope='current', incomplete=True)
            for path in sorted(paths):
                p = self.root / path
                try:
                    st = p.lstat()
                    if not stat.S_ISREG(st.st_mode):
                        self.issue('nonregular_file', path, scope='current', incomplete=True)
                        continue
                    asset_limit = 16 * 1024 * 1024 if self.assets and path in self.assets.records else self.limit
                    if st.st_size > asset_limit:
                        self.issue('oversize_unscanned', path, scope='current', incomplete=True)
                        continue
                    if st.st_mode & 0o444 == 0:
                        raise PermissionError()
                    with p.open('rb') as f:
                        data = f.read(asset_limit + 1)
                    after = p.stat()
                    if len(data) != st.st_size or (st.st_mtime_ns, st.st_ino) != (after.st_mtime_ns, after.st_ino):
                        self.issue('file_changed_during_scan', path, scope='current', incomplete=True)
                        continue
                    self.inspect(path, '', 'current', data)
                except Exception:
                    self.issue('unreadable_current_file', path, scope='current', incomplete=True)
            commits = self.git('rev-list', '--all', 'HEAD').splitlines()
            history_seen = set()
            for commit in commits:
                for entry in self.git('ls-tree', '-rz', '--full-tree', commit.decode()).split(b'\0'):
                    if not entry:
                        continue
                    meta, raw = entry.split(b'\t', 1)
                    mode, kind, oid = meta.decode().split()
                    path = raw.decode('utf-8', 'surrogateescape')
                    key = (path, oid, mode)
                    if key in history_seen:
                        continue
                    history_seen.add(key)
                    self.blob(path, oid, 'history', mode)
            known = {oid for _, oid, _ in history_seen}
            objects = self.git('rev-list', '--objects', '--no-object-names', '--all', 'HEAD').splitlines()
            check = subprocess.run(['git', '-C', str(self.root), 'cat-file', '--batch-check'], input=b'\n'.join(objects)+b'\n', capture_output=True, timeout=30)
            if check.returncode or len(check.stdout.splitlines()) != len(objects):
                self.issue('object_inventory_incomplete', incomplete=True)
            else:
                for row in check.stdout.splitlines():
                    fields = row.decode().split()
                    if len(fields) != 3:
                        self.issue('unreadable_reachable_object', incomplete=True)
                    elif fields[1] == 'blob' and fields[0] not in known:
                        self.blob('[unmapped-blob]', fields[0], 'history', '')
            if refs_before != self.git('show-ref') or index_before != self.git('ls-files', '--stage', '-z'):
                self.issue('repository_changed_during_scan', incomplete=True)
        except Exception:
            self.issue('repository_scan_incomplete', incomplete=True)
        return {'status': 'FAIL' if self.findings else 'PASS', 'candidate_review_required': bool(self.findings), 'scanned_items': self.scanned, 'fixture_exceptions_used': self.allowed, 'counts': dict(collections.Counter(x['category'] for x in self.findings)), 'findings': self.findings, 'scope': 'index, tracked current files, nonignored untracked files, every reachable commit tree; ignored files are not public source inputs'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', nargs='?', default='.')
    parser.add_argument('--fixture-allowlist')
    parser.add_argument('--asset-manifest')
    args = parser.parse_args()
    audit = Audit(args.root, args.fixture_allowlist, asset_manifest=args.asset_manifest)
    result = audit.run()
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 1 if result['status'] == 'FAIL' else 0


if __name__ == '__main__':
    sys.exit(main())
