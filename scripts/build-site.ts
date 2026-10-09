/** Offline source-release page. No inherited media downloads or absent-directory copies. */
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';
const root=join(import.meta.dir,'..'),out=join(root,'_site');mkdirSync(out,{recursive:true});
const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
writeFileSync(join(out,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>TermWeave</title><body><h1>TermWeave ${version}</h1><p>Independent herdr web client. Source-only release; remote runtime distribution unsupported.</p><p>Read the repository README for reviewed local installation and limitations.</p></body></html>`);
process.stdout.write('Built offline TermWeave source page\n');
