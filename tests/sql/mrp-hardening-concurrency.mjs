// Disposable native PostgreSQL CI only. No production connection is accepted.
import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
if(process.env.PGDATABASE!=='erp_test'||!['127.0.0.1','localhost'].includes(process.env.PGHOST))throw Error('Use the isolated local erp_test database.');
const auth="set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';set statement_timeout='20s';";
const args=s=>['-X','-qAt','-v','ON_ERROR_STOP=1','-c',auth+s];
const sync=s=>execFileSync('psql',args(s),{encoding:'utf8'}).trim().split('\n').at(-1);
const send=s=>new Promise(resolve=>execFile('psql',args(s),{encoding:'utf8'},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
const q=s=>"'"+String(s).replaceAll("'","''")+"'";
const loc=randomUUID(),supplier=randomUUID();
sync(`insert into public.locations(id,name,can_sell)values('${loc}','MRP hardening concurrency',true);
insert into public.suppliers(id,name,quoted_lead_days,payment_terms_days)values('${supplier}','MRP hardening concurrency supplier',3,30);
insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,supplier_id,lead_days)
values('MRP-HC1','MRP concurrency 1','Beverage','MRP-HC1','each','case',10,1,10,'${supplier}',3),('MRP-HC2','MRP concurrency 2','Beverage','MRP-HC2','each','case',10,1,10,'${supplier}',3);`);
function prepare(sku){
 const order={name:'Concurrency fixture',location:'MRP hardening concurrency',pickup:new Date(Date.now()+7*86400000).toISOString(),lines:[{sku,qty:10}]};
 sync(`select public.erp_create_pickup_order('${randomUUID()}',${q(JSON.stringify(order))}::jsonb);`);
 return JSON.parse(sync(`select jsonb_build_object('revision',public.erp_read_revision(),'orders',jsonb_build_array(jsonb_build_object('supplierId','${supplier}','locationId','${loc}','date',(now() at time zone 'America/Denver')::date,'requiredOn',(now() at time zone 'America/Denver')::date+7,'orderBy',(now() at time zone 'America/Denver')::date+4,'send',false,'notes','MRP confirmed requirements concurrency','lines',jsonb_build_array(jsonb_build_object('sku','${sku}','qty',1,'price',10)))));`));
}
const save=(id,payload)=>`select public.erp_mrp_purchase_drafts('${id}','create_orders',${q(JSON.stringify(payload))}::jsonb);`;
let payload=prepare('MRP-HC1'),id=randomUUID();
let results=await Promise.all([send(save(id,payload)),send(save(id,payload))]);
assert.ok(results.every(r=>!r.error),JSON.stringify(results));
const parsed=r=>JSON.parse(r.stdout.trim().split('\n').at(-1));assert.deepEqual(parsed(results[0]),parsed(results[1]));
payload=prepare('MRP-HC2');
results=await Promise.all([send(save(randomUUID(),payload)),send(save(randomUUID(),payload))]);
assert.equal(results.filter(r=>!r.error).length,1,JSON.stringify(results));
assert.match(results.find(r=>r.error).stderr,/Planning data changed|MRP draft already exists/);
assert.equal(sync(`select count(*) from public.purchase_orders p join public.purchase_order_lines l on l.purchase_order_id=p.id where l.item_sku='MRP-HC2';`),'1');
console.log('PASS: concurrent identical MRP saves recover one dated draft; competing stale saves create exactly one draft and require the loser to refresh.');
