import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {printReceipt} from '../src/printReceipt.ts';

// Minimal fake browser: records what is on the page at the moment print() is called.
const listeners={},bodyClasses=new Set(),appended=[];
let printedHtml=null,printedClass=false,printCalls=0;
globalThis.document={
  querySelector:sel=>sel==='.receipt-modal .receipt-paper'?{outerHTML:'<div class="receipt-paper">Order 42 Bob (801) 555-0100 Visa ending 4242</div>'}:null,
  createElement:()=>({id:'',innerHTML:'',remove(){const i=appended.indexOf(this);if(i>=0)appended.splice(i,1);},get isConnected(){return appended.includes(this);}}),
  body:{appendChild:el=>appended.push(el),classList:{add:c=>bodyClasses.add(c),remove:c=>bodyClasses.delete(c)}},
};
globalThis.window={addEventListener:(n,f)=>{listeners[n]=f;},removeEventListener:n=>{delete listeners[n];},setTimeout:()=>1,print(){printCalls++;printedHtml=appended[0]?.innerHTML??null;printedClass=bodyClasses.has('printing-receipt');}};

printReceipt('.receipt-modal .receipt-paper');
assert.equal(printCalls,1);
assert.equal(appended.length,1,'a print-only copy exists while printing');
assert.equal(appended[0].id,'print-root');
assert.ok(printedHtml.includes('Order 42')&&printedHtml.includes('(801) 555-0100')&&printedHtml.includes('Visa ending 4242'),'the whole receipt is in the print area');
assert.ok(printedClass,'print styles are switched on while printing');
listeners.afterprint();
assert.equal(appended.length,0,'the copy is removed after printing');
assert.ok(!bodyClasses.has('printing-receipt'),'the page returns to normal');

// If the receipt is not on screen, fall back to a normal print instead of failing silently
printCalls=0;printReceipt('.nothing-here');assert.equal(printCalls,1);

// Styles: the modal is no longer what hides the receipt
const css=await readFile('src/style.css','utf8');
assert.ok(css.includes('body.printing-receipt>*:not(#print-root){display:none!important}'),'everything else is hidden so no blank pages');
assert.ok(css.includes('#print-root .receipt-paper'),'the copied receipt is laid out normally');
const app=await readFile('src/App.tsx','utf8'),hist=await readFile('src/OrderHistory.tsx','utf8');
assert.ok(app.includes("printReceipt('.receipt-modal .receipt-paper')")&&hist.includes("printReceipt('.receipt-modal .receipt-paper')"),'POS and order-history receipts use it');

console.log('PASS: printing copies the whole receipt into a print-only area, hides the rest of the page (no blank pages), cleans up afterwards, and POS, order-history and customer receipts all use it.');
