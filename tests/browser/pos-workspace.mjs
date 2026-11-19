// Render the actual POS component with synthetic transport. No production client.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const output='test-results/pos',root=output+'/fixture';await mkdir(root,{recursive:true});
const source=await readFile('src/App.tsx','utf8');
const imports="import {pizzaImages} from '../../../src/pizzaImages';\nimport {CameraScanner} from '../../../src/CameraScanner';\n"+source.split('\n').filter(l=>l.includes("from 'react'")||l.includes("from 'lucide-react'")||l.includes("from './domain'")||l.includes("from './paymentFormatting'")).map(l=>l.replaceAll("'./","'../../../src/")).join('\n');
const types=source.slice(source.indexOf('type RecordSaleResult='),source.indexOf('type ReturnSaleLine='));
const location=source.slice(source.indexOf('function LocationSelect('),source.indexOf('function StatCard('));
const pos=source.slice(source.indexOf('function POS('),source.indexOf('function Orders('));
const mock=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {createPosCheckout} from '../../../src/posCheckout';
import type {PosCustomer} from '../../../src/posCheckout';
import '../../../src/style.css';
const usd=fmt,itm=(sku:string)=>items.find(i=>i.sku===sku)!;
const api={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{id:'test-store'}})})})}),rpc:async(name:string,args:any)=>{
 if(name==='erp_pos_customer'){await new Promise(r=>setTimeout(r,200));return {data:args.p_phone==='+18015550123'?{id:'shared-member',name:'Andrew',phone:args.p_phone,enrolled:true,points:120}:null};}
 (window as any).checkoutPayload=args;return {data:{sale_id:'test-sale',receipt_no:'TEST-001',subtotal:15,discount:5,tax:.725,total:10.725,cogs:4,rewards_earned:10,rewards_redeemed:100,rewards_balance:30}};
}};
const {loadPosCustomer,postPosSale,readPendingPosSale,recoverPosSale}=createPosCheckout(api,sessionStorage);
function Preview(){const [location,setLocation]=useState<Location>('Provo Campus Store'),[message,setMessage]=useState('');const state={sales:[],settings:{tax:.0725}} as unknown as AppState;return <div className="app-shell"><aside className="sidebar collapsed"><div className="brand">Z</div></aside><main className="main-area"><header className="topbar">Za by Zack / POS</header><div className="page-wrap"><div className="page-top"><div><h1>POS</h1><p>Ring up an order, apply a discount, and keep inventory in sync.</p></div></div><POS state={state} location={location} setLocation={setLocation} onCommit={()=>{throw Error('Unexpected browser write')}} flash={setMessage}/><div role="status">{message}</div></div></main></div>};createRoot(document.getElementById('root')!).render(<Preview/>);`;
await writeFile(root+'/main.tsx',imports+'\n'+types+'\n'+location+'\n'+pos+'\n'+mock);
await writeFile(root+'/index.html','<div id="root"></div><script type="module" src="/main.tsx"></script>');
await writeFile(root+'/vite.config.ts',`import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';export default defineConfig({plugins:[react()],server:{host:'127.0.0.1',port:4179,strictPort:true,fs:{allow:[process.cwd()]}}});`);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js',root,'--config',root+'/vite.config.ts'],{stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',s=>logs+=s);server.stderr.on('data',s=>logs+=s);
let browser;const errors=[];
try{
 for(let n=0;n<100;n++){try{if((await fetch('http://127.0.0.1:4179')).ok)break;}catch{}if(n===99)throw Error(logs);await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}: {})});const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:4179');await page.getByRole('heading',{name:'Current order'}).waitFor();
 for(let n=0;n<15;n++)await page.locator('.product-tile').nth(n).click();
 await page.locator('.pos-menu-scroll').evaluate(el=>el.scrollTop=0);
 for(const [width,height] of [[1440,900],[1280,720],[1024,768]]){
  await page.setViewportSize({width,height});await page.waitForTimeout(200);
  const button=page.getByRole('button',{name:'Complete sale',exact:true});const before=await button.boundingBox();assert.ok(before.y+before.height<=height,`checkout below viewport ${width}x${height}: ${JSON.stringify(before)}`);
  await page.locator('.pos-menu-scroll').evaluate(el=>el.scrollTop=el.scrollHeight);const after=await button.boundingBox();assert.equal(before.y,after.y,'menu moved checkout');
  const dimensions=await page.locator('.cart-lines').evaluate(el=>({client:el.clientHeight,scroll:el.scrollHeight}));assert.ok(dimensions.scroll>dimensions.client,'order does not independently scroll');
  await page.screenshot({path:`${output}/pos-${width}.png`,fullPage:true});
 }
 await page.setViewportSize({width:1440,height:900});await page.locator('.pos-customer-details summary').click();await page.getByLabel('Rewards phone').fill('8015550123');await page.getByText('Customer found · name filled in below').waitFor();assert.equal(await page.getByLabel('Name to call').inputValue(),'Andrew');await page.getByRole('checkbox',{name:/Use 100 points/}).check();
 await page.screenshot({path:output+'/pos-rewards.png',fullPage:true});await page.getByRole('button',{name:'Complete sale',exact:true}).click();await page.getByText('TEST-001').first().waitFor();assert.match(await page.locator('.receipt-rewards').innerText(),/Earned 10 points · Balance 30/);assert.equal(await page.evaluate(()=>window.checkoutPayload.p_redeem),true);
 await page.getByRole('button',{name:'Close receipt'}).click();await page.setViewportSize({width:390,height:844});await page.screenshot({path:output+'/pos-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile horizontal overflow');
 assert.deepEqual(errors,[]);console.log('PASS: actual POS browser at 1440/1280/1024 and mobile; menu/order scroll independently, checkout stays visible, shared lookup autofills, redemption and points receipt work.');
}catch(error){
 await writeFile(output+'/diagnostic.json',JSON.stringify({error:String(error),pageError:errors.join(' | '),server:logs.slice(-4000)},null,2));
 throw error;
}finally{await browser?.close();server.kill();}

// Run native IndexedDB migration/reload checks with the browser tools already
// installed by this job. Existing POS assertions above remain unchanged.
await import('./workspace-storage.mjs');
