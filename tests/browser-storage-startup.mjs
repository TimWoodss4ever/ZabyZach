import assert from 'node:assert/strict';
import {loadState, saveState} from '../src/domain.ts';
import {browserStorage, isBrowserStorageUnavailable, observeBrowserStorage} from '../src/browserStorage.ts';
const disk = new Map();
globalThis.window = {dispatchEvent(){}};
globalThis.CustomEvent = class {};
globalThis.localStorage = {getItem:k=>disk.get(k)??null,setItem:(k,v)=>disk.set(k,v),removeItem:k=>disk.delete(k)};
const original = loadState();
original.salesOrders.push({id:'TEAM-STORAGE-KEEP',customer:'Team',location:'Provo Campus Store',pickup:'2027-01-01',status:'Order Placed',lines:[{sku:'2001',qty:2}]});
saveState(original);
const saved = disk.get('zbyzack-erp-v1');
let notices = 0; const stop = observeBrowserStorage(()=>notices++);
// A failed backup write must not discard an existing browser workspace.
globalThis.localStorage.setItem = ()=>{throw new DOMException('Full','QuotaExceededError');};
assert.ok(loadState().salesOrders.some(x=>x.id==='TEAM-STORAGE-KEEP'));
assert.equal(disk.get('zbyzack-erp-v1'),saved);
assert.equal(isBrowserStorageUnavailable(),true);
assert.equal(notices,1);
// Completely blocked browser storage: cold start, then same-tab read/write.
Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new DOMException('Blocked','SecurityError');}});
// Remove the adapter's backup values without touching the original disk map.
const fresh = loadState();
fresh.salesOrders.push({id:'MEMORY-ONLY-KEEP',customer:'Team',location:'Orem Store',pickup:'2027-01-01',status:'Order Placed',lines:[{sku:'2001',qty:1}]});
saveState(fresh);
assert.ok(loadState().salesOrders.some(x=>x.id==='MEMORY-ONLY-KEEP'));
browserStorage.setItem('temporary','value');
assert.equal(browserStorage.getItem('temporary'),'value');
browserStorage.removeItem('temporary');
assert.equal(browserStorage.getItem('temporary'),null);
assert.equal(disk.get('zbyzack-erp-v1'),saved);
assert.equal(notices,1); stop();
console.log('PASS: blocked reads and quota failures do not crash startup; backup failures preserve team records; same-tab fallback and removal work; original persistent data is untouched.');
