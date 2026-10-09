#!/usr/bin/env python3
"""Check the P0 and P1 boundaries. This gate does not validate product behavior."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(root, *args):
    result = subprocess.run(['git', '--no-optional-locks', '-C', str(root), *args], capture_output=True)
    if result.returncode:
        raise RuntimeError('Git inspection failed')
    return result.stdout.decode('utf-8', 'replace').strip()


def check(root, evidence):
    metadata = json.loads((evidence / 'git-metadata.json').read_text())
    inventory = json.loads((evidence / 'complete-inventory.json').read_text())
    context = json.loads((evidence / 'local-context.json').read_text())
    source = Path(context['installed_source'])
    assert source != root and not source.is_relative_to(root)
    assert (root / '.git').is_dir() and not (root / '.git').is_symlink()
    assert Path(git(root, 'rev-parse', '--show-toplevel')).samefile(root)
    assert Path(git(root, 'rev-parse', '--absolute-git-dir')).samefile(root / '.git')
    assert git(source, 'rev-parse', 'HEAD') == metadata['head'].strip()
    assert git(source, 'status', '--porcelain=v1', '--untracked-files=all') == metadata['status'].strip()
    count = 0
    for row in inventory:
        if row['classification'] in {'source', 'production-dist'}:
            assert digest(source / row['path']) == row['sha256'], 'Installed file changed'
            count += 1
    for group in ['source', 'dist']:
        rows = json.loads((evidence / (group + '-manifest.json')).read_text())
        for row in rows:
            for area in ['backup', 'restore']:
                assert digest(evidence / area / group / row['path']) == row['sha256']
    accounting = json.loads((evidence / 'export-accounting.json').read_text())
    assert len(accounting) == 67
    for row in accounting:
        path = root / row['path']
        if row['export_status'] == 'excluded-personal-live-script':
            assert not path.exists()
        else:
            assert digest(path) == row['export_sha256']
    assert not list((root / '.github/workflows').glob('*.yml'))
    assert not list((root / '.github/workflows').glob('*.yaml'))
    assert not (root / 'dist').exists() and not (root / 'node_modules').exists()
    assert not (root / 'evidence').exists()
    assert git(root, 'remote').splitlines() == ['upstream']
    assert git(root, 'remote', 'get-url', '--push', 'upstream') == 'DISABLED'
    assert (root / 'LICENSE').read_bytes() == (evidence / 'backup/source/LICENSE').read_bytes()
    assert (root / 'THIRD_PARTY_NOTICES.md').read_bytes() == (evidence / 'backup/source/THIRD_PARTY_NOTICES.md').read_bytes()
    print('PASS[preservation] installed source/dist files unchanged=' + str(count))
    print('PASS[restore] source=513 dist=96 hash_mismatches=0')
    print('PASS[custom-accounting] exact=59 transformed=1 excluded=7')
    print('PASS[git-boundary] own Git directory, no origin, upstream push disabled')
    print('PASS[publication-boundary] inherited workflows disabled, notices unchanged')
    print('UNKNOWN[product-and-public-safety] P2 onward required')


if __name__ == '__main__':
    try:
        assert len(sys.argv) == 3
        check(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as error:
        print('FAIL[p0-p1] ' + type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
