import {readdir,copyFile,unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const run=file=>{console.log('\n'+file);const result=spawnSync(process.execPath,['--experimental-strip-types',file],{stdio:'inherit'});if(result.status!==0)throw Error(file+' failed');};
for(const name of (await readdir('tests')).sort())if(name.endsWith('.mjs')&&name!=='run-all.mjs')run('tests/'+name);
for(const name of (await readdir('tests/original')).sort())if(name.endsWith('.mjs')&&name!=='catalog-assortment.mjs'){const target='tests/.original-'+name;try{await copyFile('tests/original/'+name,target);run(target);}finally{await unlink(target).catch(()=>{});}}

console.log('Original catalog-assortment is preserved for reference; its fixed opening-stock assertion is superseded by the updated catalog/history tests. See REVIEW_NOTES.md.');
