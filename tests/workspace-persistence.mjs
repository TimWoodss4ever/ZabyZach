import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createBrowserStorage, workspaceKeys} from '../src/browserStorage.ts';
import {mergeWorkspaceSnapshot} from '../src/workspaceDatabase.ts';
const [state,costs,backup,backupCosts] = workspaceKeys;
const copy = x => JSON.parse(JSON.stringify(x));
const value = (revision,id='TEAM-ORDER') => JSON.stringify({revision,salesOrders:[{id}],settings:{holding:.29}});
function fixture(initial={},native={}) {
  let snapshot={values:{...initial}}, rejectWrite=false, rejectRead=false, commitGate=null;
  const disk=new Map(Object.entries(native)), removed=[];
  const small={getItem:k=>disk.get(k)??null,setItem:(k,v)=>disk.set(k,v),removeItem:k=>{removed.push(k);disk.delete(k);}};
  const database={read:async()=>{if(rejectRead)throw Error('read denied');return copy(snapshot);},update:async(patch,original)=>{
    if(commitGate)await commitGate;
    if(rejectWrite)throw Error('write denied');
    const next=mergeWorkspaceSnapshot(snapshot,patch,original);
    snapshot=next;return copy(snapshot);
  },close(){}};
  let notices=0,peers=0;
  const options={localStorage:()=>small,openDatabase:async()=>database,notifyPeers:()=>peers++,onRemoteChange:()=>notices++};
  return {disk,removed,database,small,options,snapshot:()=>copy(snapshot),writeFails:v=>rejectWrite=v,readFails:v=>rejectRead=v,gate:v=>commitGate=v,notices:()=>notices,peers:()=>peers};
}
// Exact strings survive migration; only the four workspace keys are removed.
const originals={[state]:value(8),[costs]:'{"1001":0.45}',[backup]:value(2,'ORIGINAL'),[backupCosts]:'{"1001":0.4}'};
const f=fixture({}, {...originals,'sb-auth-token':'AUTH-KEEP','zbyzack-purchasing-request':'RETRY-KEEP'});
const w=createBrowserStorage(f.options);await w.initialize();
for(const [k,v]of Object.entries(originals)){assert.equal(w.storage.getItem(k),v);assert.equal(f.snapshot().legacyBackup[k],v);assert.equal(f.disk.has(k),false);}
assert.equal(f.disk.get('sb-auth-token'),'AUTH-KEEP');assert.equal(f.disk.get('zbyzack-purchasing-request'),'RETRY-KEEP');assert.equal(w.unavailable(),false);
w.storage.setItem(state,value(9));w.storage.setItem(costs,'{"1001":0.5}');assert.equal(w.hasPendingWrites(),true);assert.equal(await w.flush(),true);
assert.deepEqual(f.snapshot().legacyBackup,originals);assert.equal(f.peers(),1,'a single save/cost pair should commit together');
const reloaded=createBrowserStorage(f.options);await reloaded.initialize();assert.equal(reloaded.storage.getItem(state),value(9));assert.equal(reloaded.unavailable(),false);
// No large native-storage writes on a fresh browser, even when all writes fail.
const cold=fixture();let nativeWrites=0;cold.small.setItem=()=>{nativeWrites++;throw Error('quota');};
const fresh=createBrowserStorage(cold.options);await fresh.initialize();
const large='x'.repeat(4_000_000);fresh.storage.setItem(state,large);assert.equal(await fresh.flush(),true);assert.equal(nativeWrites,0);assert.equal(cold.snapshot().values[state],large);assert.equal(fresh.unavailable(),false);
// Delayed commit never removes originals early.
const delayed=fixture({},originals);let release;delayed.gate(new Promise(r=>release=r));
const migrating=createBrowserStorage(delayed.options),ready=migrating.initialize();await new Promise(r=>setImmediate(r));assert.equal(delayed.removed.length,0);release();await ready;assert.equal(delayed.removed.length,4);
// Failed commit or failed verification retains EVERY original key.
for(const verification of [false,true]){
 const x=fixture({},originals);if(!verification)x.writeFails(true);else{const write=x.database.update;x.database.update=async(...args)=>{const v=await write(...args);x.readFails(true);return v;};}
 const a=createBrowserStorage(x.options);await a.initialize();assert.equal(a.unavailable(),true);assert.equal(x.removed.length,0);assert.equal(a.storage.getItem(state),originals[state]);
}
// Another old tab changes localStorage while migration is committing.
const concurrent=fixture({},originals),realUpdate=concurrent.database.update;
concurrent.database.update=async(...args)=>{const v=await realUpdate(...args);concurrent.disk.set(state,value(50,'OTHER-TAB'));return v;};
await createBrowserStorage(concurrent.options).initialize();assert.equal(concurrent.disk.get(state),value(50,'OTHER-TAB'));
// Newer legacy revision is imported; stale legacy cannot overwrite newer IDB.
for(const [dbRev,oldRev,expected]of [[10,2,10],[2,10,10]]){
 const x=fixture({[state]:value(dbRev),[costs]:'DB-COSTS'},{[state]:value(oldRev),[costs]:'OLD-COSTS'});
 const a=createBrowserStorage(x.options);await a.initialize();assert.equal(a.storage.getItem(state),value(expected));assert.equal(a.storage.getItem(costs),oldRev>dbRev?'OLD-COSTS':'DB-COSTS');assert.equal(x.snapshot().legacyBackup[state],value(oldRev));
}
// Write failure keeps the latest in-memory data and export; retry clears notice.
const failed=fixture(),a=createBrowserStorage(failed.options);await a.initialize();failed.writeFails(true);a.storage.setItem(state,value(12));assert.equal(await a.flush(),false);assert.equal(a.unavailable(),true);assert.equal(a.hasPendingWrites(),true);assert.equal(JSON.parse(a.exportBackup()).values[state],value(12));failed.writeFails(false);assert.equal(await a.flush(),true);assert.equal(a.unavailable(),false);
// Writes arriving during a commit are not marked saved with the older value.
let releaseWrite;failed.gate(new Promise(r=>releaseWrite=r));a.storage.setItem(state,value(13));await Promise.resolve();a.storage.setItem(state,value(14));releaseWrite();assert.equal(await a.flush(),true);assert.equal(failed.snapshot().values[state],value(14));
// Refresh from another tab, including deletions, without replaying local writes.
await failed.database.update({[state]:value(15),[costs]:null});await a.refresh();assert.equal(a.storage.getItem(state),value(15));assert.equal(a.storage.getItem(costs),null);assert.equal(failed.notices(),1);
// A write made while a remote read is in flight must stay in memory.
const read=failed.database.read;let finishRead;failed.database.read=()=>new Promise(r=>finishRead=r);const refreshing=a.refresh();await Promise.resolve();a.storage.setItem(state,value(16));finishRead({values:{[state]:value(1)}});await refreshing;assert.equal(a.storage.getItem(state),value(16));failed.database.read=read;await a.flush();
// Complete IndexedDB failure never clears old records or blocks same-tab use.
const denied=fixture({},originals);const temp=createBrowserStorage({...denied.options,openDatabase:async()=>{throw Error('blocked');}});await temp.initialize();temp.storage.setItem(state,value(20));assert.equal(temp.storage.getItem(state),value(20));assert.equal(temp.unavailable(),true);assert.equal(temp.hasPendingWrites(),true);assert.equal(await temp.flush(),false);assert.equal(denied.disk.get(state),originals[state]);assert.equal(JSON.parse(temp.exportBackup()).values[state],value(20));
// Small localStorage access may be blocked while IndexedDB still works.
const blocked=createBrowserStorage({...fixture().options,localStorage:()=>{throw Error('security');}});await blocked.initialize();blocked.storage.setItem(state,value(22));assert.equal(await blocked.flush(),true);assert.equal(blocked.unavailable(),false);
const main=await readFile('src/main.tsx','utf8');assert.ok(main.indexOf('void initializeBrowserStorage().then(')<main.indexOf('<App/>'),'App rendered before storage hydration');
// Concurrent commit is rechecked inside the native transaction's merge step.
const latest={values:{[state]:value(60),[costs]:'NEW-COSTS'},legacyBackup:{[state]:value(1)}};
const guarded=mergeWorkspaceSnapshot(latest,{[state]:value(50),[costs]:'OLD-COSTS'},{[state]:value(50),[costs]:'OLD-COSTS'});
assert.equal(guarded.values[state],value(60));assert.equal(guarded.values[costs],'NEW-COSTS');assert.equal(guarded.legacyBackup[state],value(1));assert.deepEqual(guarded.legacyArchive[state],[value(50)]);
assert.deepEqual(mergeWorkspaceSnapshot(guarded,{}, {[state]:value(50)}).legacyArchive[state],[value(50)],'migration archives duplicated on repeat');
console.log('PASS: durable migration/verification ordering, exact backups, auth/retry preservation, 4MB cold start, reload, concurrent old/new writes, failed commit/verification, newer revision selection, atomic save queue, cross-tab refresh, export, recovery, and IndexedDB denial. Injected database; native IndexedDB runs in the browser suite.');
