import assert from 'node:assert/strict';
import {pickupSchedule} from '../src/pickup.ts';
import {businessDate,cartStockIssue,loadState} from '../src/domain.ts';
const memory=new Map();globalThis.localStorage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
const now=new Date('2026-11-15T00:07:00Z'); // Nov 14, 5:07 PM at the restaurant.
assert.equal(businessDate(now),'2026-11-14');
const tomorrow=pickupSchedule('2026-11-15',now);assert.equal(tomorrow.minDate,'2026-11-14');assert.ok(tomorrow.options.includes('17:30'));assert.ok(tomorrow.options.includes('17:00'));
const sameDay=pickupSchedule('2026-11-14',now);assert.equal(sameDay.options[0],'17:30');assert.ok(!sameDay.options.includes('17:00'));
const closed=pickupSchedule('2026-11-14',new Date('2026-11-15T05:00:00Z'));assert.equal(closed.minDate,'2026-11-15');assert.equal(closed.options.length,0);
// Checkout's screenshot basket is valid against the recorded sample inventory.
const state=loadState(),cart=[{sku:'2001',qty:1},{sku:'2005',qty:1},{sku:'1041',qty:1},{sku:'2007',qty:1},{sku:'1018',qty:1}];
assert.equal(cartStockIssue(state,'Provo Campus Store',cart),null);
console.log('PASS: screenshot basket availability, 5:30 PM tomorrow checkout, same-day selection normalization, restaurant timezone, closed-day handling.');
