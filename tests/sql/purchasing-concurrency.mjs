// Disposable CI database only: two actual PostgreSQL sessions, no mocked transport.
import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
if(process.env.PGDATABASE!=='erp_test'||!['127.0.0.1','localhost'].includes(process.env.PGHOST))throw Error('Concurrency tests require the isolated local erp_test database.');
const auth="set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';";
const args=sql=>['-X','-v','ON_ERROR_STOP=1','-At','-c',auth+sql];
const json=output=>JSON.parse(output.trim().split('\n').findLast(line=>line.startsWith('{')));
const sync=sql=>json(execFileSync('psql',args(sql),{encoding:'utf8'}));
const send=sql=>new Promise(resolve=>execFile('psql',args(sql),{encoding:'utf8'},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
const created=sync("select public.erp_purchasing_write('"+randomUUID()+"','create_orders',jsonb_build_object('orders',jsonb_build_array(jsonb_build_object('supplierId','00000000-0000-0000-0000-000000000010','locationId',(select id from public.locations limit 1),'date',(now() at time zone 'America/Denver')::date,'send',true,'lines',jsonb_build_array(jsonb_build_object('sku','CI-ITEM','qty',10,'price',80))))));");
const po=created.ids[0];
function receive(id,revision,qty){return "select public.erp_purchasing_write('"+id+"','receive_order',jsonb_build_object('id','"+po+"','revision',"+revision+",'date',(now() at time zone 'America/Denver')::date,'locationId',(select ship_to_location_id from public.purchase_orders where id='"+po+"'),'final',false,'tax',0,'lines',jsonb_build_array(jsonb_build_object('id',(select id from public.purchase_order_lines where purchase_order_id='"+po+"'),'qty',"+qty+",'price',80))));";}
const request=randomUUID(),same=receive(request,0,7);
let responses=await Promise.all([send(same),send(same)]);
assert.ok(responses.every(r=>!r.error),JSON.stringify(responses));assert.deepEqual(json(responses[0].stdout),json(responses[1].stdout));
let state=sync("select jsonb_build_object('qty',(select quantity_received_purchase from public.purchase_order_lines where purchase_order_id='"+po+"'),'receipts',(select count(*) from public.erp_purchase_receipts where purchase_order_id='"+po+"'));");
assert.equal(state.qty,7);assert.equal(state.receipts,1);
responses=await Promise.all([send(receive(randomUUID(),1,2)),send(receive(randomUUID(),1,2))]);
assert.equal(responses.filter(r=>!r.error).length,1);assert.ok(responses.find(r=>r.error).stderr.includes('Purchase order changed'));
state=sync("select jsonb_build_object('qty',(select quantity_received_purchase from public.purchase_order_lines where purchase_order_id='"+po+"'),'receipts',(select count(*) from public.erp_purchase_receipts where purchase_order_id='"+po+"'));");
assert.equal(state.qty,9);assert.equal(state.receipts,2);
console.log('PASS: concurrent same-request deliveries post once; distinct stale requests allow one winner and preserve remaining stock/quantity.');
