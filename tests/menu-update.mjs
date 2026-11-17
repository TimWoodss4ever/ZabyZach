import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {items} from '../src/domain.ts';
import {code128Svg} from '../src/barcode.ts';
import {code128Patterns} from '../src/barcodePatterns.ts';
import {barcodeLabelSheet} from '../src/barcodeLabels.ts';
import {purchaseOrderEmail,purchasingRule} from '../src/sharedPurchasing.ts';
// Decode every printed menu barcode rather than merely checking an SVG exists.
function decode(svg){const bars=[...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map(m=>({x:+m[1],w:+m[2]}));const runs=[];for(let n=0;n<bars.length;n++){runs.push(bars[n].w/2);if(n+1<bars.length)runs.push((bars[n+1].x-bars[n].x-bars[n].w)/2);}const values=[];while(runs.length){const pattern=runs.splice(0,runs.length===7?7:6).map((v,n)=>String.fromCharCode((n%2?96:64)+v)).join('');const match=Object.entries(code128Patterns).find(([,p])=>p===pattern);assert.ok(match);values.push(+match[0]);}assert.equal(values.at(-1),106);assert.equal(values.at(-2),values.slice(0,-2).reduce((s,v,n)=>s+v*(n||1),0)%103);return values.slice(1,-2).map(n=>String.fromCharCode(n+32)).join('');}
const menu=items.filter(i=>i.price>0);assert.ok(menu.some(i=>i.sku==='2007'));assert.equal(menu.filter(i=>i.category==='Pizza').length,6);
for(const i of menu){assert.equal(decode(code128Svg(i.barcode)),i.barcode);assert.ok(barcodeLabelSheet([i],1).includes(i.barcode));}
assert.equal(new Set(items.map(i=>i.barcode)).size,items.length);
const source=await readFile('src/BarcodeLabels.tsx','utf8');assert.ok(source.includes('!i.recipe||i.price>0'));assert.ok(source.includes('incomingItems.filter(i=>chosen.includes(i.sku))'));
// URI values remain encoded even when names/notes contain special characters.
const po={id:'po',po_no:'PO-123 & 456',supplier_id:'supplier',ship_to_location_id:'store',expected_at:'2026-11-20T19:00:00Z'};
const d={suppliers:[{id:'supplier',name:'A & B',contact_name:'Orders team',email:'orders@example.com'}],locations:[{id:'store',name:'Campus'}],items:[{sku:'1005',name:'Pepperoni'}],lines:[{purchase_order_id:'po',item_sku:'1005',quantity_purchase:2}],options:{order_cost:25,holding_rate:.25,safety_days:2,review_days:7},orders:[],stock:{},dailyUsage:{'1005':30}};
const url=purchaseOrderEmail(d,po);assert.match(url,/^mailto:/);const params=new URLSearchParams(url.split('?')[1]);assert.equal(params.get('subject'),'Za by Zack purchase order PO-123 & 456');assert.match(params.get('body'),/2 × Pepperoni/);assert.match(params.get('body'),/2026-11-20/);assert.match(params.get('body'),/Campus/);
assert.ok(purchaseOrderEmail({...d,suppliers:[]},po).startsWith('mailto:?'));assert.ok(!purchaseOrderEmail({...d,suppliers:[{...d.suppliers[0],email:'a@example.com\r\nBcc:other@example.com'}]},po).includes('\r'));
const rule=purchasingRule({...d,suppliers:[{id:'supplier',quoted_lead_days:5}]},{sku:'1005',supplier_id:'supplier',unit_cost:.3,conversion_factor:80,shelf_life_days:45});assert.equal(rule.daily,30);assert.equal(rule.rop,210);assert.ok(rule.eoq>0&&rule.eoq<=30*45);
// Exercise the actual keyboard shortcut handler with browser event objects.
const app=await readFile('src/App.tsx','utf8');const code=app.slice(app.indexOf('const shortcut=(event:KeyboardEvent)=>'),app.indexOf(';window.addEventListener(\'keydown\',shortcut)'));
const js=stripTypeScriptTypes(code);
for(const page of ['Dashboard','Inventory'])for(const key of ['metaKey','ctrlKey']){
 let prevented=0,focused=0,selected=0,collapsed,opened;const input={focus(){focused++;},select(){selected++;}};
 const fn=new Function('page','window','document','globalSearchRef','setCollapsed','setSearchOpen',js+';return shortcut;')(page,{setTimeout(fn){fn();}},{querySelector(){return input;}},{current:input},v=>collapsed=v,v=>opened=v);
 fn({[key]:true,altKey:false,key:'k',preventDefault(){prevented++;}});assert.equal(prevented,1);assert.equal(focused,1);assert.equal(selected,1);assert.equal(collapsed,true);assert.equal(opened,true);
 fn({key:'k',preventDefault(){throw Error('plain K was intercepted');}});
}
assert.ok(app.includes("else navigatePage('Inventory')"));
console.log('PASS: every menu barcode decodes with valid checksum; meal labels print; URI-safe supplier draft contents; nonzero shelf-life-capped EOQ/ROP; Command/Ctrl-K focuses and selects the correct search field, without intercepting plain K.');
