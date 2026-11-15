import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const baseline=JSON.parse(readFileSync('migration-review/baseline.json','utf8'));
const main=execFileSync('git',['rev-parse','origin/main'],{encoding:'utf8'}).trim();
if(main!==baseline.main_commit){console.error('STOP: main changed after this package was prepared. Compare the newer group work before uploading or merging. Expected '+baseline.main_commit+'; current '+main);process.exit(1);}
console.log('PASS: main matches the supplied snapshot '+main+'. This does not authorize merging or deploying.');
