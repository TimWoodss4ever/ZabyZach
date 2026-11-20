// Real browser interaction with synthetic data. No Supabase client is imported.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const output='test-results/mrp';await mkdir(output,{recursive:true});
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','tests/browser/fixture','--config','tests/browser/fixture/vite.config.ts'],{stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',s=>logs+=s);server.stderr.on('data',s=>logs+=s);
let browser,page;const errors=[];
try {
 for(let n=0;n<100;n++){try{if((await fetch('http://127.0.0.1:4178/')).ok)break;}catch{}if(n===99)throw Error(logs);await new Promise(resolve=>setTimeout(resolve,200));}
 browser=await chromium.launch({headless:true});
 page=await browser.newPage({viewport:{width:1440,height:1050}});
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:4178/');
 await page.getByRole('heading',{name:'Four-week material plan'}).waitFor();
 assert.equal(await page.locator('.mrpw-table tbody tr').count()>5,true);
 assert.equal(await page.locator('.mrpw-banner-symbol').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(9, 46, 83)','matches app navy');
 await page.screenshot({path:output+'/requirements-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Daily',exact:true}).click();await page.getByRole('button',{name:'Next week',exact:true}).click();assert.match(await page.locator('.mrpw-period-controls').innerText(),/Week 2/);assert.equal(await page.locator('.mrpw-table thead th').count(),13);await page.getByRole('button',{name:'Weekly',exact:true}).click();
 const sauce=page.getByRole('checkbox',{name:'Select Pizza sauce for PO draft',exact:true});
 assert.equal(await sauce.isEnabled(),true);await sauce.check();
 await page.getByRole('button',{name:'View plan for Pizza sauce',exact:true}).click();
 let dialog=page.getByRole('dialog');await dialog.waitFor();
 assert.match(await dialog.innerText(),/Dated requirement calculation/);assert.match(await dialog.innerText(),/1 #10 can = 106 oz/);assert.match(await dialog.innerText(),/Order 4182/);
 await page.screenshot({path:output+'/component-calculation.png',fullPage:true});
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
 assert.equal(await page.getByRole('button',{name:'View plan for Pizza sauce',exact:true}).evaluate(el=>document.activeElement===el),true,'dialog restores focus');
 await page.getByRole('button',{name:/Review PO drafts/}).click();dialog=page.getByRole('dialog');await dialog.waitFor();assert.match(await dialog.innerText(),/Review ingredient PO drafts/);
 await page.getByRole('button',{name:'Create 2 supplier drafts',exact:true}).click();
 await page.waitForFunction(()=>window.qaLog.some(value=>Array.isArray(value)&&value.includes('1002')));
 assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await sauce.isDisabled(),true,'existing draft cannot be selected twice');
 await page.getByRole('tab',{name:'Recipes & BOMs',exact:true}).click();
 await page.locator('.mrpw-parent-list button').filter({hasText:'Large Pepperoni Pizza'}).click();
 assert.match(await page.locator('.mrpw-recipe-detail').innerText(),/House-made dough ball/);
 assert.equal(await page.locator('.mrpw-recipe-detail tbody tr').count(),5);
 await page.screenshot({path:output+'/recipes-desktop.png',fullPage:true});
 await page.getByRole('tab',{name:/Planning alerts/}).click();
 assert.match(await page.locator('.mrpw-alert-list').innerText(),/Overdue purchase/);
 await page.getByLabel('MRP planning location').selectOption('orem');
 await page.getByRole('heading',{name:'No planning alerts here'}).waitFor();
 await page.getByRole('tab',{name:/Planning alerts/}).focus();await page.keyboard.press('Home');
 assert.equal(await page.getByRole('tab',{name:'Requirements',exact:true}).getAttribute('aria-selected'),'true');
 await page.getByLabel('MRP planning location').selectOption('commissary');
 await page.getByRole('heading',{name:'No confirmed demand at this location'}).waitFor();
 await page.getByLabel('MRP planning location').selectOption('provo');
 await page.getByLabel('Search MRP components').fill('pepperoni');
 for(const text of await page.locator('.mrpw-item').allInnerTexts())assert.match(text.toLowerCase(),/pepperoni/);
 await page.getByRole('button',{name:'Clear MRP search'}).click();
 await page.getByLabel('Filter MRP requirements').selectOption('buy');
 assert.equal(await page.locator('.mrpw-item-icon.made').count(),0);
 await page.evaluate(()=>window.fixtureState.setError('Simulated refresh failure'));
 await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('checkbox',{name:'Select all eligible visible purchase suggestions'}).isDisabled(),true);
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[role="alert"]'));
 for(const width of [1440,960,768,390,360]){
  await page.setViewportSize({width,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no page overflow at '+width);
  await page.screenshot({path:output+'/requirements-'+width+'.png',fullPage:true});
 }
 await page.locator('.mrpw-item').filter({hasText:'Shredded mozzarella'}).click();
 await page.getByRole('dialog').waitFor();
 assert.equal(await page.getByRole('dialog').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;}),true,'mobile dialog fits viewport');
 await page.screenshot({path:output+'/detail-mobile.png',fullPage:true});
 await page.keyboard.press('Escape');
 assert.deepEqual(errors,[],'no client-side runtime errors');
 assert.equal(await page.evaluate(()=>window.qaLog.filter(Array.isArray).length),1,'one deliberate draft save, no automatic writes');
 console.log('PASS: browser tabs/keyboard, location and search filters, exact recipe rows, dated detail, selected draft review, duplicate guard, focus restoration, stale state, navy theme, desktop/mobile overflow and dialog bounds. Synthetic data only.');
} catch(error) {
 let body='';try{body=await page.locator('body').innerText();await page.screenshot({path:output+'/failure.png',fullPage:true});}catch{}
 await writeFile(output+'/diagnostic.json',JSON.stringify({error:String(error),pageError:errors.join(' | '),server:logs.slice(-4000),body:body.slice(0,6000)},null,2));
 throw error;
} finally {if(browser)await browser.close();server.kill('SIGTERM');}
