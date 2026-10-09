#!/usr/bin/env python3
"""Copy an explicit exact-hash manifest to a NEW private candidate repository."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

BLOCKED_PARTS = {'.git', '.env', 'node_modules', 'evidence', 'sessions', 'credentials', 'secrets', 'backups', '__pycache__', '.gradle', 'build', 'dist', '.idea'}
BLOCKED_SUFFIXES = {'.log', '.db', '.sqlite', '.sqlite3', '.pem', '.key', '.p12', '.pyc', '.apk', '.har'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_path(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_./-]+', value):
        raise ValueError('invalid_manifest_path')
    p = PurePosixPath(value)
    if p.is_absolute() or '..' in p.parts or str(p) != value or any(x in BLOCKED_PARTS or x.startswith('.env.') for x in p.parts) or p.suffix in BLOCKED_SUFFIXES:
        raise ValueError('private_or_unsafe_path')
    return p


def load_source(root, row):
    if set(row) != {'path', 'sha256', 'mode'} or row['mode'] not in {'100644', '100755'} or not re.fullmatch(r'[a-f0-9]{64}', row['sha256']):
        raise ValueError('invalid_manifest_record')
    path = validate_path(row['path'])
    target = root / path
    cursor = root
    for part in path.parts:
        cursor /= part
        if cursor.is_symlink():
            raise ValueError('source_symlink')
    if not target.is_file() or target.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('source_missing_or_oversize')
    data = target.read_bytes()
    if digest(data) != row['sha256']:
        raise ValueError('source_changed')
    return data


def git(root, *args):
    env = dict(os.environ)
    for key in list(env):
        if key.startswith('GIT_'):
            del env[key]
    env.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                'GIT_AUTHOR_NAME': 'TermWeave export', 'GIT_AUTHOR_EMAIL': 'export@example.invalid',
                'GIT_COMMITTER_NAME': 'TermWeave export', 'GIT_COMMITTER_EMAIL': 'export@example.invalid'})
    r = subprocess.run(['git', '-c', 'core.hooksPath='+os.devnull, '-c', 'init.templateDir=', '-C', str(root), *args], env=env, capture_output=True)
    if r.returncode:
        raise ValueError('candidate_git_failed')
    return r.stdout


def required_source_paths(root):
    paths = git(root, 'ls-files', '-co', '--exclude-standard', '-z').decode('utf-8').split('\0')
    required = {}
    for path in set(paths) - {''}:
        p = PurePosixPath(path)
        if not (root / path).is_file():
            continue
        if any(part in BLOCKED_PARTS for part in p.parts):
            continue
        if p.parts[0] in {'src', 'server', 'shared', 'public', 'mobile', 'scripts', 'gates', 'tools'}:
            # Tests are part of reproducibility and are not silently waived.
            required[path] = 'runtime_build_or_verification'
        elif p.name in {'package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'index.html'} or p.name.startswith(('tsconfig', 'vite.config')):
            required[path] = 'build_configuration'
        elif p.name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE')) or path in {'docs/source-provenance.json', 'docs/dependency-notices.md'}:
            required[path] = 'source_attribution'
    return required


def export(root, manifest_path, destination, asset_manifest=None, fixture_allowlist=None, audit_incomplete=False):
    root = Path(root).resolve()
    dest = Path(destination).absolute()
    if dest.exists() or dest.is_symlink() or not dest.parent.exists() or dest.parent.resolve() != dest.parent or dest == root or root in dest.parents:
        raise ValueError('destination_must_be_new_outside_source')
    manifest = json.loads(Path(manifest_path).read_text())
    if set(manifest) != {'version', 'source_commit', 'files'} or manifest['version'] != 1 or not re.fullmatch(r'[a-f0-9]{40}', manifest['source_commit']):
        raise ValueError('invalid_export_manifest')
    if git(root, 'rev-parse', 'HEAD').decode().strip() != manifest['source_commit']:
        raise ValueError('source_revision_changed')
    rows = manifest['files']
    if not isinstance(rows, list) or not rows or len(rows) > 10000 or len({x['path'] for x in rows}) != len(rows):
        raise ValueError('invalid_export_file_set')
    included = {row['path'] for row in rows}
    missing = [{'path': path, 'category': category} for path, category in sorted(required_source_paths(root).items()) if path not in included]
    if missing and not audit_incomplete:
        return {'status': 'FAIL', 'completeness': 'FAIL', 'missing_required': missing, 'published': False, 'exported_files': 0}
    # Validate all bytes before creating output. Never edit or stage the source repo.
    contents = [(row, load_source(root, row)) for row in rows]
    if not any(Path(row['path']).name.upper().startswith(('LICENSE', 'COPYING')) for row in rows):
        raise ValueError('source_license_required')
    dest.mkdir(mode=0o700)
    for row, data in contents:
        path = dest / row['path']
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_bytes(data)
        path.chmod(0o700 if row['mode'] == '100755' else 0o600)
    provenance = {'source_commit': manifest['source_commit'], 'export_manifest_sha256': digest(Path(manifest_path).read_bytes()),
                  'history': 'Source history is not included. This is a reviewed snapshot candidate, not a release.',
                  'files': rows}
    (dest/'EXPORT_PROVENANCE.json').write_text(json.dumps(provenance, indent=2)+'\n')
    (dest/'EXPORT_PROVENANCE.json').chmod(0o600)
    git(dest, 'init', '-q')
    git(dest, 'add', '-f', '--', *[row['path'] for row in rows], 'EXPORT_PROVENANCE.json')
    git(dest, 'commit', '-qm', 'Prepare reviewed source snapshot candidate')
    spec = importlib.util.spec_from_file_location('candidate_privacy', Path(__file__).with_name('privacy.py'))
    privacy = importlib.util.module_from_spec(spec);spec.loader.exec_module(privacy)
    result = privacy.Audit(dest, fixture_allowlist, asset_manifest=asset_manifest).run()
    result.update({'exported_files': len(rows), 'source_preserved': all(digest((root/row['path']).read_bytes()) == row['sha256'] for row in rows), 'published': False})
    result['privacy_status'] = result['status']
    result['completeness'] = 'FAIL' if missing else 'PASS'
    result['missing_required'] = missing
    result['publish_ready'] = False
    if not result['source_preserved'] or missing:
        result['status'] = 'FAIL'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source');parser.add_argument('manifest');parser.add_argument('destination')
    parser.add_argument('--audit-incomplete', action='store_true');parser.add_argument('--asset-manifest');parser.add_argument('--fixture-allowlist');parser.add_argument('--report', required=True)
    args = parser.parse_args()
    try:
        result = export(args.source, args.manifest, args.destination, args.asset_manifest, args.fixture_allowlist, args.audit_incomplete)
    except Exception as error:
        result = {'status': 'FAIL', 'error': str(error) if isinstance(error, ValueError) else 'export_failed', 'published': False}
    report = Path(args.report)
    fd = os.open(report, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:json.dump(result, out, indent=2)
    print(json.dumps({k:v for k,v in result.items() if k not in {'findings', 'missing_required'}}))
    return 0 if result['status'] == 'PASS' else 1

if __name__ == '__main__':
    sys.exit(main())
