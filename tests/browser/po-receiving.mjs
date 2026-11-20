// Actual purchasing React screens. Transport and camera callback are mocked;
// transaction/stock assertions additionally run against PostgreSQL in CI.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const root='test-results/po-receiving/fixture';await mkdir(root,{recursive:true});
await writeFile(root+'/main.tsx',`import React from 'react';import {createRoot} from 'react-dom/client';import {SharedPurchasingScreen} from '../../../src/SharedPurchasingScreens';import '../../../src/style.css';createRoot(document.getElementById('root')!).render(<SharedPurchasingScreen view="Purchase Orders" flash={message=>{(window as any).poToast=message;}}/>);`);
await writeFile(root+'/index.html','<div id="root"></div><script type="module" src="/main.tsx"></script>');
await writeFile(root+'/vite.config.ts',`import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';export default defineConfig({plugins:[react()],resolve:{alias:[{find:'@supabase/supabase-js',replacement:process.cwd()+'/tests/browser/fixture/po-scan-mock.ts'},{find:'./CameraScanner',replacement:process.cwd()+'/tests/browser/fixture/po-camera-mock.tsx'}]},server:{host:'127.0.0.1',port:4183,strictPort:true,fs:{allow:[process.cwd()]}}});`);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js',root,'--config',root+'/vite.config.ts'],{stdio:['ignore','pipe','pipe']});let log='';server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);
let browser;const errors=[];
try{
 for(let n=0;n<100;n++){try{if((await fetch('http://127.0.0.1:4183')).ok)break;}catch{}if(n===99)throw Error(log);await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:4183');await page.getByRole('heading',{name:'Purchase orders',exact:true}).waitFor();
 const search=page.getByRole('textbox',{name:'Scan barcode or search orders'}),close=()=>page.getByRole('button',{name:'Close',exact:true}).click();
 await search.fill('cheese');assert.equal(await page.locator('.po-order-card').count(),1);await search.fill('mozz');assert.equal(await page.locator('.po-order-card').count(),1);await search.fill('SKU 1003');assert.equal(await page.locator('.po-order-card').count(),1);
 await search.press('Enter');await page.getByRole('button',{name:'Post delivery & create invoice'}).waitFor();assert.equal(await page.evaluate(()=>window.poReceiptPosts),0,'scan posted before confirmation');
 assert.equal(await page.locator('[name="qty-line1"]').evaluate(el=>document.activeElement===el),true);await close();
 await search.fill('ZBZ-1007');await search.press('Enter');await page.getByRole('dialog',{name:'Choose purchase order to receive'}).waitFor();assert.equal(await page.getByRole('button',{name:/^Receive PO-DEMO/}).count(),2);assert.equal(await page.getByRole('button',{name:'Receive PO-CLOSED'}).count(),0);await close();
 await page.evaluate(()=>window.scanTestCode='ZPO:a0186598-bf73-4d89-86d2-a43e41d9555a');await page.getByRole('button',{name:'Scan PO or item',exact:true}).click();await page.getByRole('button',{name:'Use simulated scan'}).click();await page.getByRole('button',{name:'Post delivery & create invoice'}).waitFor();
 await page.locator('[name="qty-line1"]').fill('2');await page.evaluate(()=>window.dropPoReply=true);await page.getByRole('button',{name:'Post delivery & create invoice'}).click();await page.getByText('Connection interrupted after posting.').first().waitFor();
 assert.equal(await page.evaluate(()=>window.poFixture.stock['1003']),160);assert.equal(await page.evaluate(()=>window.poReceiptPosts),1);
 assert.equal(await page.getByRole('button',{name:'Retry pending save',exact:true}).count(),1,'retry must not be duplicated behind the modal');await page.getByRole('dialog').getByRole('button',{name:'Retry pending save',exact:true}).click();await page.waitForFunction(()=>window.poToast==='Pending save confirmed without posting it twice.');assert.equal(await page.getByRole('button',{name:'Post delivery & create invoice'}).count(),0);
 assert.equal(await page.evaluate(()=>window.poReceiptPosts),1);assert.equal(await page.evaluate(()=>window.poFixture.invoices.length),1);assert.equal(await page.evaluate(()=>window.poFixture.stock['1003']),160);
 const requests=await page.evaluate(()=>window.poCalls.filter(c=>c.name==='erp_purchasing_write'));assert.equal(requests[0].args.p_request,requests[1].args.p_request);assert.deepEqual(requests[0].args.p_payload,requests[1].args.p_payload);
 await search.fill('PO-DEMO-001');await page.getByRole('button',{name:'PO barcode',exact:true}).click();await page.getByRole('button',{name:'Print PO barcode',exact:true}).waitFor();assert.equal(await page.locator('[aria-label="PO barcode PO-DEMO-001"] svg').count(),1);
 const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download PO label'}).click();const download=await downloaded;const html=await readFile(await download.path(),'utf8');assert.ok(html.includes('ZPO:a0186598-bf73-4d89-86d2-a43e41d9555a'));assert.ok(html.includes('PO-DEMO-001'));assert.ok(html.includes('100% / Actual size'));await close();
 await search.fill('ZPO:c0186598-bf73-4d89-86d2-a43e41d9555a');await search.press('Enter');await page.getByText('This PO has no outstanding delivery to receive. Its record is shown below.').waitFor();assert.equal(await page.getByRole('button',{name:'Post delivery & create invoice'}).count(),0);await close();
 assert.deepEqual(errors,[]);console.log('PASS: mobile purchasing UI, SKU prefix, keyboard PO/item routing, multiple outstanding POs, simulated camera callback, confirmation-before-post, purchase-unit conversion, lost-response retry without duplicate invoice/stock, barcode preview/download and closed-order guard. Mock transport/camera; native SQL tested separately.');
}finally{await browser?.close();server.kill();}
