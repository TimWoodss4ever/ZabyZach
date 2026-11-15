import assert from 'node:assert/strict';
import {items} from '../src/domain.ts';
import {code128Svg} from '../src/barcode.ts';
import {code128Patterns} from '../src/barcodePatterns.ts';
import {barcodeLabelSheet} from '../src/barcodeLabels.ts';
const incoming=items.filter(i=>!i.recipe);assert.ok(incoming.length>25);assert.equal(new Set(incoming.map(i=>i.barcode)).size,incoming.length);
// Decode printed bars and spaces back into Code 128 symbols, then verify the checksum.
function decode(svg){const width=Number(svg.match(/viewBox="0 0 (\d+)/)[1]);const bars=[...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map(m=>({x:+m[1],width:+m[2]}));assert.equal(bars[0].x,20);assert.equal(width-bars.at(-1).x-bars.at(-1).width,20);let runs=[];for(let n=0;n<bars.length;n++){runs.push(bars[n].width/2);if(n+1<bars.length)runs.push((bars[n+1].x-bars[n].x-bars[n].width)/2);}const values=[];while(runs.length){const size=runs.length===7?7:6;const chunk=runs.splice(0,size).map((w,n)=>String.fromCharCode((n%2?96:64)+w)).join('');const entry=Object.entries(code128Patterns).find(([,p])=>p===chunk);assert.ok(entry,'Unknown barcode symbol '+chunk);values.push(+entry[0]);}return values;}
assert.deepEqual(decode(code128Svg('ZBZ-1005')),[104,58,34,58,13,17,16,16,21,93,106]);
for(const i of incoming){const values=decode(code128Svg(i.barcode));assert.equal(values[0],104);assert.equal(values.at(-1),106);const data=values.slice(1,-2).map(c=>String.fromCharCode(c+32)).join('');assert.equal(data,i.barcode);assert.equal(values.at(-2),values.slice(0,-2).reduce((n,c,index)=>n+c*(index||1),0)%103);}
const pepperoni=incoming.find(i=>i.sku==='1005');const sheet=barcodeLabelSheet([pepperoni],3);assert.equal((sheet.match(/class="label"/g)||[]).length,3);assert.ok(sheet.includes('SKU 1005'));assert.ok(sheet.includes('80 oz'));assert.ok(sheet.includes('5 lb box'));assert.ok(sheet.includes('ZBZ-1005'));assert.ok(sheet.includes('@page{size:letter'));assert.ok(sheet.includes('Actual size'));assert.ok(!sheet.includes('<script'));
assert.throws(()=>code128Svg(''),/Enter/);assert.throws(()=>code128Svg('🍕'),/not supported/);const escaped=barcodeLabelSheet([{...pepperoni,name:'<script>alert("x")</script>'}],1);assert.ok(!escaped.includes('<script>'));assert.ok(escaped.includes('&lt;script&gt;'));
console.log('PASS: every incoming barcode decodes to its catalog value; known Code 128 vector/checksum; quiet zones; printable copy counts, item/SKU/pack mapping, paper dimensions, escaped content, invalid-value guards.');
