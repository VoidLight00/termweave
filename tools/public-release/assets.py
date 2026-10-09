"""Exact-byte, pinned upstream font verification. No extension-wide exceptions."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import urllib.request

MAX_ASSET_BYTES = 16 * 1024 * 1024
OFFICIAL_REPOS = {'JetBrains/JetBrainsMono', 'naver/d2-coding-font', 'google/fonts'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch_pinned(url):
    match = re.fullmatch(r'https://raw\.githubusercontent\.com/([^/]+/[^/]+)/([a-f0-9]{40})/(.+)', url)
    if not match or match[1] not in OFFICIAL_REPOS or '..' in PurePosixPath(match[3]).parts:
        raise ValueError('untrusted_asset_origin')
    with urllib.request.urlopen(url, timeout=30) as response:
        if response.geturl() != url:
            raise ValueError('asset_redirect')
        data = response.read(MAX_ASSET_BYTES + 1)
    if len(data) > MAX_ASSET_BYTES:
        raise ValueError('asset_too_large')
    return data


def local_file(root, path):
    if not isinstance(path, str) or not re.fullmatch(r'[A-Za-z0-9_./-]+', path) or path.startswith('/') or '..' in PurePosixPath(path).parts:
        raise ValueError('invalid_asset_path')
    target = root / path
    if any(parent.is_symlink() for parent in [target, *target.parents] if parent != root.parent):
        raise ValueError('asset_symlink')
    if not target.is_file() or target.stat().st_size > MAX_ASSET_BYTES:
        raise ValueError('invalid_asset_file')
    return target.read_bytes()


class VerifiedAssets:
    def __init__(self, root, manifest, scan_text):
        self.records = {}
        self.notices = {}
        root = Path(root).resolve()
        rows = json.loads(Path(manifest).read_text())
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValueError('invalid_asset_manifest')
        from fontTools.ttLib import TTFont
        for row in rows:
            if set(row) != {'path', 'sha256', 'bytes', 'source', 'license_path', 'license_sha256', 'license_source', 'format'}:
                raise ValueError('invalid_asset_record')
            if row['path'] in self.records or row['format'] not in {'woff2', 'ttf'}:
                raise ValueError('invalid_asset_format')
            data = local_file(root, row['path'])
            notice = local_file(root, row['license_path'])
            if sha(data) != row['sha256'] or len(data) != row['bytes'] or sha(notice) != row['license_sha256']:
                raise ValueError('asset_hash_mismatch')
            if fetch_pinned(row['source']) != data or fetch_pinned(row['license_source']) != notice:
                raise ValueError('asset_upstream_mismatch')
            # A font and its license must be from the same owner/repository/commit.
            if row['source'].split('/')[:6] != row['license_source'].split('/')[:6]:
                raise ValueError('asset_license_revision_mismatch')
            if b'SIL OPEN FONT LICENSE Version 1.1' not in notice:
                raise ValueError('asset_license_unknown')
            font = TTFont(io.BytesIO(data), lazy=False, checkChecksums=2)
            expected = 'woff2' if data[:4] == b'wOF2' else 'ttf' if data[:4] == b'\x00\x01\x00\x00' else None
            if expected != row['format'] or not {'name', 'cmap', 'head', 'maxp'}.issubset(font.keys()):
                raise ValueError('asset_format_mismatch')
            if font['maxp'].numGlyphs <= 0 or not font.getBestCmap():
                raise ValueError('empty_font')
            # Parse every table, including metadata; reject embedded SVG/bitmap payloads.
            if any(tag in font for tag in ('SVG ', 'sbix', 'CBDT', 'EBDT', 'meta')):
                raise ValueError('unsupported_font_payload')
            for tag in font.keys():
                font[tag]
            for name in font['name'].names:
                scan_text(name.toUnicode().encode('utf-8'))
            font.close()
            self.records[row['path']] = row
            self.notices[row['license_path']] = row['license_sha256']

    def accepts(self, path, data):
        row = self.records.get(path)
        return bool(row and sha(data) == row['sha256'] and len(data) == row['bytes'])

    def is_notice(self, path, data):
        return self.notices.get(path) == sha(data)
