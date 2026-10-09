import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
const root=join(import.meta.dir,'..');const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const inventory=[];
const names:string[]=[];
for(const entry of readdirSync(join(root,'node_modules'))){if(entry.startsWith('.'))continue;if(entry.startsWith('@')){for(const child of readdirSync(join(root,'node_modules',entry)))names.push(entry+'/'+child);}else names.push(entry);}
for(const name of names.sort()) {
 const path=join(root,'node_modules',name,'package.json');const bytes=readFileSync(path);const metadata=JSON.parse(bytes.toString());
 inventory.push({name,version:metadata.version,declaredLicense:metadata.license??'UNKNOWN',packageHash:createHash('sha256').update(bytes).digest('hex'),scope:pkg.dependencies[name]?'runtime':'development'});
}
const out=join(root,'evidence/p5b');mkdirSync(out,{recursive:true});writeFileSync(join(out,'dependency-inventory.json'),JSON.stringify({scope:'installed top-level direct/transitive package metadata; declared licenses are not legal approval',dependencies:inventory},null,2));
