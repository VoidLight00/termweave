import assert from 'node:assert/strict';import {readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
const root=join(import.meta.dir,'..');const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
assert.equal(pkg.name,'termweave');assert.equal(pkg.private,true);const manifestVersion=/^version = "([^"]+)"/m.exec(readFileSync(join(root,'herdr-plugin.toml'),'utf8'))?.[1];const productVersion=/PRODUCT_VERSION = "([^"]+)"/.exec(readFileSync(join(root,'shared/product.ts'),'utf8'))?.[1];assert.match(pkg.version,/^\d+\.\d+\.\d+$/);assert.equal(manifestVersion,pkg.version);assert.equal(productVersion,pkg.version);
assert.match(readFileSync(join(root,'herdr-plugin.toml'),'utf8'),/id = "VoidLight00.termweave"/);
for(const name of ['README.md','README.ko.md','README.zh.md','README.ja.md']){
 const text=readFileSync(join(root,name),'utf8');for(const command of ['sh install.sh --check','sh install.sh --install','scripts/owned-server.ts'])assert.ok(text.includes(command),`${name}: ${command}`);
 for(const match of text.matchAll(/\]\(([^)]+)\)/g)){const href=match[1]!;if(!href.startsWith('http'))assert.ok(existsSync(join(root,href)),`${name}: ${href}`);}
 assert.ok(!text.includes('user-attachments')&&!text.includes('docs/media/'));
}
for(const name of ['DockGroup.tsx','DockDivider.tsx','SplitTerminals.tsx','BrowserPanel.tsx','TerminalSearch.tsx','NativePaneMove.tsx'])assert.ok(!/[가-힣]/.test(readFileSync(join(root,'src/components',name),'utf8')),`hardcoded custom locale: ${name}`);
assert.ok(!/[가-힣]/.test(readFileSync(join(root,'src/lib/browserPreview.ts'),'utf8')));
process.stdout.write('PASS product identity, four-doc install/link parity and custom hardcode gate\n');
