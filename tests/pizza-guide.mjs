import assert from 'node:assert/strict';
import {guideAnswer,helpTopics} from '../src/helpContent.ts';
const state={purchaseOrders:[],supplierInvoices:[],supplierPayments:[]};
for(const [question,title] of [['How do I receive an order?','Receive a delivery'],['Where do I pay a supplier?','Pay a supplier or close a PO'],['Where are profits?','Find sales and profits'],['How do I change a supplier contact?','Add or edit a supplier'],['Where are reorder points and EOQ?','Review inventory and EOQ'],['Where are supplier scorecards?','Compare supplier performance']]){const answer=guideAnswer(question,state,'Manager');assert.equal(answer.links[0]?.title,title,question);}
assert.equal(guideAnswer('What is the weather?',state,'Manager').answer.includes('I can help you find'),true);
assert.equal(guideAnswer('Where are profits?',state,'Cashier').links.some(t=>t.page==='Financials'),false);
assert.equal(guideAnswer('What do we owe suppliers?',state,'Customer').links.length,0);
assert.ok(helpTopics.every(t=>t.steps.length>0&&t.answer&&t.page));
console.log('PASS: pizza guide navigation for receiving, supplier payments, profit, supplier contacts, EOQ, and scorecards; unknown-question fallback; role-limited links and customer help.');
