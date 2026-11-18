import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const output='test-results/navigation';await mkdir(output,{recursive:true});
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','tests/browser/fixture','--config','tests/browser/fixture/vite.config.ts'],{stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',value=>logs+=value);server.stderr.on('data',value=>logs+=value);
let browser,page;const errors=[];
const clickNav=label=>page.getByRole('button',{name:label,exact:true}).click({position:{x:30,y:14}});
try{
 for(let attempt=0;attempt<100;attempt++){try{if((await fetch('http://127.0.0.1:4178/app.html')).ok)break;}catch{}if(attempt===99)throw Error(logs);await new Promise(resolve=>setTimeout(resolve,200));}
 browser=await chromium.launch({headless:true});
 page=await browser.newPage({viewport:{width:1366,height:720}});
 await page.addInitScript(()=>localStorage.clear());
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:4178/app.html');
 // The fixture signs in manager@example.test; the dashboard personalizes its greeting.
 await page.getByRole('heading',{name:'Good morning, Manager',exact:true}).waitFor();

 const nav=page.locator('.sidebar nav');
 const fit=await nav.evaluate(element=>({scroll:element.scrollHeight,client:element.clientHeight,links:[...element.querySelectorAll('.nav-link')].map(link=>{const box=link.getBoundingClientRect();return{top:box.top,bottom:box.bottom};})}));
 assert.ok(fit.scroll<=fit.client+1,'all desktop navigation icons fit without vertical scrolling at 1366×720');
 assert.ok(fit.links.every(link=>link.top>=0&&link.bottom<=720),'all desktop navigation icons remain within the laptop viewport');
 const mainBefore=await page.locator('.main-area').boundingBox();
 await page.mouse.move(30,120);
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.sidebar .nav-link-text')).opacity==='1');
 const mainAfter=await page.locator('.main-area').boundingBox();
 assert.equal(mainAfter.x,mainBefore.x,'hover expansion does not shift workspace content');
 assert.equal(mainAfter.width,mainBefore.width,'hover expansion does not resize workspace content');
 assert.equal(await page.locator('.sidebar .nav-link-text').first().evaluate(element=>getComputedStyle(element).visibility),'visible');
 await page.screenshot({path:output+'/navigation-hover-desktop.png',fullPage:true});

 await page.locator('.sidebar .nav-link').first().focus();
 await page.waitForFunction(()=>!document.querySelector('.sidebar').classList.contains('collapsed'));
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.querySelector('.sidebar').classList.contains('collapsed'));
 assert.equal(await page.getByRole('button',{name:'Open navigation menu'}).evaluate(element=>document.activeElement===element),true,'Escape restores focus to the navigation control');

 const select=page.getByLabel('Store location').first();
 await select.evaluate(element=>{(window).storeClickCount=0;element.addEventListener('click',()=>window.storeClickCount++);});
 const bounds=await select.boundingBox();
 for(const x of [2,14,bounds.width/2,bounds.width-14,bounds.width-2])await page.mouse.click(bounds.x+x,bounds.y+bounds.height/2);
 assert.equal(await page.evaluate(()=>window.storeClickCount),5,'icons, arrow and outer padding all hit the native store selector');
 await select.selectOption('Orem Store');
 await clickNav('POS');
 await page.getByRole('heading',{name:'POS'}).waitFor();
 assert.equal(await page.getByLabel('Store location').inputValue(),'Orem Store','store context is shared from Dashboard to POS');
 await page.screenshot({path:output+'/pos-desktop.png',fullPage:true});

 await clickNav('Settings');
 await page.getByRole('heading',{name:'Ordering options'}).waitFor();
 await page.getByLabel('Annual holding cost').fill('12.5');
 await page.getByRole('button',{name:'Save ordering options'}).click();
 await page.getByText('Ordering options saved. Shared Inventory Review will use these values.').waitFor();
 let writes=await page.evaluate(()=>window.qaCalls.filter(call=>call.name==='erp_purchasing_write'));
 assert.deepEqual(writes.at(-1).args.p_payload,{revision:1,orderCost:25,holdingRate:.125,safetyDays:2,reviewDays:7});
 await page.getByRole('button',{name:'Go to dashboard'}).click();
 await page.getByRole('heading',{name:'Good morning, Manager',exact:true}).waitFor();

 await clickNav('Inventory Review');
 await page.getByRole('heading',{name:'Shared inventory review'}).waitFor();
 await page.getByRole('button',{name:'Select reorder suggestions'}).click();
 const item=page.getByRole('checkbox',{name:'Select Synthetic flour'});
 assert.equal(await item.isChecked(),true,'reorder shortcut selects eligible synthetic stock');
 await page.getByRole('button',{name:/Create draft POs/}).click();
 await page.getByText('Saved to Supabase. Shared purchasing measures refreshed.').waitFor();
 writes=await page.evaluate(()=>window.qaCalls.filter(call=>call.name==='erp_purchasing_write'));
 const draftWrite=writes.find(call=>call.args.p_action==='create_orders');
 assert.ok(draftWrite,'selected review item creates a draft purchase order');
 assert.equal(draftWrite.args.p_payload.orders[0].locationId,'store');
 assert.equal(draftWrite.args.p_payload.orders[0].send,false,'review creates a draft, not an issued order');

 await page.getByLabel('Review notes').fill('Synthetic review only');
 await page.getByRole('button',{name:'Save completed review'}).click();
 await page.getByText('Review saved. The schedule above reflects the latest shared record when refresh succeeds.').waitFor();
 writes=await page.evaluate(()=>window.qaCalls.filter(call=>call.name==='erp_purchasing_write'));
 assert.deepEqual(writes.map(call=>call.args.p_action),['save_options','create_orders','inventory_review']);
 assert.equal(await page.evaluate(()=>window.qaCalls.filter(call=>call.args.p_action==='inventory_review').length),1);
 assert.equal(await page.getByText('Nov 24, 2026').count(),1,'completion updates the next review date');
 assert.equal(await page.evaluate(()=>window.qaSnapshot.orders.length),1,'completing review does not add another purchase order');
 assert.equal(await page.evaluate(()=>window.qaSnapshot.orders[0].status),'Draft','inventory review leaves the separate draft unissued');
 assert.equal(await page.evaluate(()=>window.qaSnapshot.stock['test-item']),0,'review and draft creation do not create inventory transactions');
 assert.equal(await page.locator('.review-recent').innerText().then(text=>text.includes('Synthetic review only')),false,'history disclosure remains collapsed until opened');
 await page.locator('.review-recent summary').click();
 await page.getByText('Synthetic review only').waitFor();
 assert.equal(await page.evaluate(()=>document.querySelector('.sidebar').classList.contains('collapsed')),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no desktop horizontal overflow');

 for(const width of [1440,1024,768,390]){
  await page.setViewportSize({width,height:width<500?844:720});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal overflow at '+width+'px');
  await page.screenshot({path:output+'/workspace-'+width+'.png',fullPage:true});
 }

 const touch=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 touch.on('pageerror',error=>errors.push(error.message));
 await touch.addInitScript(()=>localStorage.clear());
 await touch.goto('http://127.0.0.1:4178/app.html');
 await touch.getByRole('heading',{name:'Good morning, Manager',exact:true}).waitFor();
 await touch.getByRole('button',{name:'Open navigation menu'}).tap();
 await touch.getByRole('button',{name:'Close navigation menu'}).waitFor();
 await touch.getByRole('button',{name:'POS',exact:true}).tap();
 await touch.getByRole('heading',{name:'POS'}).waitFor();
 assert.equal(await touch.getByLabel('Store location').inputValue(),'Provo Campus Store');
 assert.equal(await touch.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'touch POS fits the mobile viewport');
 await touch.screenshot({path:output+'/pos-touch-mobile.png',fullPage:true});
 await touch.close();
 assert.deepEqual(errors,[],'no browser runtime errors');
 console.log('PASS: navigation fits 1366×720 without scrolling; hover/focus reveal labels without shifting content; Escape restores focus; logo and touch navigation work; selector icons/arrow/padding hit the control; Dashboard/POS store context is retained; shared settings persist as a shared RPC payload; review draft is not issued; review history saves without inventory writes. All data is synthetic.');
}catch(error){
 let body='';try{body=await page.locator('body').innerText();await page.screenshot({path:output+'/failure.png',fullPage:true});}catch{}
 await writeFile(output+'/diagnostic.json',JSON.stringify({error:String(error),pageError:errors.join(' | '),server:logs.slice(-4000),body:body.slice(0,6000)},null,2));
 throw error;
}finally{if(browser)await browser.close();server.kill('SIGTERM');}
