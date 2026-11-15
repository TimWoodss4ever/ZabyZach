import assert from 'node:assert/strict';
import {loadState,saveState} from '../src/domain.ts';
const memory=new Map();globalThis.localStorage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};globalThis.window={dispatchEvent(){}};globalThis.CustomEvent=class{};
const initial=loadState();initial.salesOrders.push({id:'TEAM-ORDER-KEEP',customer:'Team',location:'Provo Campus Store',pickup:'2027-01-01',status:'Order Placed',lines:[{sku:'2001',qty:2}]});saveState(initial);const original=memory.get('zbyzack-erp-v1'),costs=memory.get('zbyzack-erp-v1-costs');
loadState();assert.equal(memory.get('zbyzack-erp-v1-before-erp-updates'),original);assert.equal(memory.get('zbyzack-erp-v1-costs-before-erp-updates'),costs);const next=loadState();saveState(next);loadState();assert.equal(memory.get('zbyzack-erp-v1-before-erp-updates'),original);assert.ok(next.salesOrders.some(o=>o.id==='TEAM-ORDER-KEEP'));
console.log('PASS: exact original browser state and costs backed up once; existing team order retained; refresh does not overwrite backup.');
