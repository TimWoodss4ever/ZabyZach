// Real browser storage and actual domain startup. No IndexedDB mock.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const root='test-results/workspace-storage/fixture';await mkdir(root,{recursive:true});
await writeFile(root+'/main.tsx',`
import React from 'react';import {createRoot} from 'react-dom/client';
import {browserStorage,initializeBrowserStorage,flushBrowserStorage,isBrowserStorageUnavailable,exportBrowserWorkspace,workspaceKeys} from '../../../src/browserStorage';
import {openWorkspaceDatabase} from '../../../src/workspaceDatabase';
import {BrowserStorageNotice} from '../../../src/BrowserStorageNotice';
import {loadState,saveState} from '../../../src/domain';
const api={keys:workspaceKeys,init:initializeBrowserStorage,get:browserStorage.getItem,put:browserStorage.setItem,remove:browserStorage.removeItem,flush:flushBrowserStorage,unavailable:isBrowserStorageUnavailable,backup:exportBrowserWorkspace,
 snapshot:async()=>{const db=await openWorkspaceDatabase();try{return await db.read();}finally{db.close();}},
 domain:()=>{const s=loadState();s.salesOrders.push({id:'NATIVE-TEAM-ORDER',customer:'Team',location:'Provo Campus Store',pickup:'2027-01-01',status:'Order Placed',lines:[{sku:'2001',qty:2}]});saveState(s);return s.ledger.length;},
 hasTeamOrder:()=>loadState().salesOrders.some(o=>o.id==='NATIVE-TEAM-ORDER')};
(window as any).workspaceTest=api;createRoot(document.getElementById('root')!).render(<BrowserStorageNotice/>);
`);
await writeFile(root+'/index.html','<div id="root"></div><script type="module" src="/main.tsx"></script>');
await writeFile(root+'/vite.config.ts',`import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';export default defineConfig({plugins:[react()],server:{host:'127.0.0.1',port:4182,strictPort:true,fs:{allow:[process.cwd()]}}});`);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js',root,'--config',root+'/vite.config.ts'],{stdio:['ignore','pipe','pipe']});let log='';server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);
let browser;const errors=[];const url='http://127.0.0.1:4182';
const open=async(context)=>{const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await p.waitForFunction(()=>!!window.workspaceTest);return p;};
try{
 for(let n=0;n<100;n++){try{if((await fetch(url)).ok)break;}catch{}if(n===99)throw Error(log);await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await open(context);
 const original=await page.evaluate(()=>{
   const k=window.workspaceTest.keys,v={[k[0]]:JSON.stringify({revision:7,salesOrders:[{id:'ORIGINAL-TEAM'}]}),[k[1]]:'{"1001":0.45}',[k[2]]:'ORIGINAL-BACKUP',[k[3]]:'ORIGINAL-COSTS'};
   for(const [key,value]of Object.entries(v))localStorage.setItem(key,value);
   localStorage.setItem('sb-test-auth-token','AUTH-KEEP');localStorage.setItem('zbyzack-purchasing-request','RETRY-KEEP');return v;
 });
 await page.evaluate(()=>window.workspaceTest.init());
 assert.deepEqual(await page.evaluate(async()=> (await window.workspaceTest.snapshot()).legacyBackup),original);
 assert.equal(await page.evaluate(()=>window.workspaceTest.keys.every(k=>localStorage.getItem(k)===null)),true);
 assert.equal(await page.evaluate(()=>localStorage.getItem('sb-test-auth-token')),'AUTH-KEEP');assert.equal(await page.evaluate(()=>localStorage.getItem('zbyzack-purchasing-request')),'RETRY-KEEP');
 assert.equal(await page.getByRole('status').count(),0,'successful migration displayed a warning');
 await page.evaluate(async()=>{const a=window.workspaceTest;a.put(a.keys[0],JSON.stringify({revision:8,salesOrders:[{id:'AFTER-SAVE'}]}));await a.flush();});
 await page.reload();await page.waitForFunction(()=>!!window.workspaceTest);await page.evaluate(()=>window.workspaceTest.init());assert.match(await page.evaluate(()=>window.workspaceTest.get(window.workspaceTest.keys[0])),/AFTER-SAVE/);
 const other=await open(context);await other.evaluate(()=>window.workspaceTest.init());
 await page.evaluate(async()=>{const a=window.workspaceTest;a.put(a.keys[0],JSON.stringify({revision:9,salesOrders:[{id:'OTHER-TAB-SAVE'}]}));await a.flush();});
 await other.waitForFunction(()=>window.workspaceTest.get(window.workspaceTest.keys[0]).includes('OTHER-TAB-SAVE'));
 await page.evaluate(async()=>{const a=window.workspaceTest;a.remove(a.keys[1]);await a.flush();});await other.waitForFunction(()=>window.workspaceTest.get(window.workspaceTest.keys[1])===null);await context.close();
 // Native database survives reload of the actual 18,000+ row workspace even
 // when writing any localStorage item throws the original quota exception.
 const fresh=await browser.newContext({viewport:{width:390,height:844}});
 await fresh.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('Full','QuotaExceededError');};});
 const cold=await open(fresh);await cold.evaluate(()=>window.workspaceTest.init());assert.ok(await cold.evaluate(()=>window.workspaceTest.domain())>10000);assert.equal(await cold.evaluate(()=>window.workspaceTest.flush()),true);assert.equal(await cold.evaluate(()=>window.workspaceTest.unavailable()),false);assert.equal(await cold.getByRole('status').count(),0);
 await cold.reload();await cold.waitForFunction(()=>!!window.workspaceTest);await cold.evaluate(()=>window.workspaceTest.init());assert.equal(await cold.evaluate(()=>window.workspaceTest.hasTeamOrder()),true);await cold.evaluate(()=>window.workspaceTest.flush());await fresh.close();
 // Denial is visible and exportable; sign-in/workspace rendering stays possible.
 const denied=await browser.newContext();await denied.addInitScript(()=>Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('Blocked','SecurityError');}}));
 const temporary=await open(denied);await temporary.evaluate(()=>window.workspaceTest.init());await temporary.getByRole('status').waitFor();await temporary.getByRole('button',{name:'Details',exact:true}).click();assert.ok(await temporary.getByRole('button',{name:'Download local backup'}).isVisible());
 await temporary.evaluate(()=>{const a=window.workspaceTest;a.put(a.keys[0],'UNSAVED-TEAM-DRAFT');});assert.equal(JSON.parse(await temporary.evaluate(()=>window.workspaceTest.backup())).values['zbyzack-erp-v1'],'UNSAVED-TEAM-DRAFT');await denied.close();
 assert.deepEqual(errors,[]);console.log('PASS: native IndexedDB commit, exact legacy backup, auth/retry retention, cleanup, reload, live cross-tab changes/deletion, real domain startup with denied localStorage writes, and IndexedDB denial/export notice. Chromium mobile viewport; not a physical iPhone.');
}finally{await browser?.close();server.kill();}
