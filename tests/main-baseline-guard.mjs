import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
const script=resolve('scripts/check-main-baseline.mjs'),dir=await mkdtemp(join(tmpdir(),'erp-baseline-'));
const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try{git('init','--quiet');git('-c','user.name=ERP test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','base');const first=git('rev-parse','HEAD');git('update-ref','refs/remotes/origin/main',first);await mkdir(join(dir,'migration-review'));await writeFile(join(dir,'migration-review/baseline.json'),JSON.stringify({main_commit:first}));let result=spawnSync(process.execPath,[script],{cwd:dir,encoding:'utf8'});assert.equal(result.status,0,result.stderr);git('-c','user.name=ERP test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','new group work');git('update-ref','refs/remotes/origin/main',git('rev-parse','HEAD'));result=spawnSync(process.execPath,[script],{cwd:dir,encoding:'utf8'});assert.equal(result.status,1);assert.ok(result.stderr.includes('main changed'));assert.equal(git('rev-parse','origin/main'),git('rev-parse','HEAD'));console.log('PASS: baseline gate accepts reviewed main and blocks later group commits without changing main.');}finally{await rm(dir,{recursive:true,force:true});}
