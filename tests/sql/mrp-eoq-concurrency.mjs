// Two different workflow requests cannot create duplicate drafts concurrently.
import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
if(process.env.PGDATABASE!=='erp_test'||!['127.0.0.1','localhost'].includes(process.env.PGHOST))throw Error('Use isolated local erp_test only.');
const auth="set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';set statement_timeout='20s';";
const args=s=>['-X','-qAt','-v','ON_ERROR_STOP=1','-c',auth+s];
const sync=s=>execFileSync('psql',args(s),{encoding:'utf8'}).trim().split('\n').at(-1);
const send=s=>new Promise(resolve=>execFile('psql',args(s),{encoding:'utf8'},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
const loc=randomUUID(),supplier=randomUUID();
sync(`insert into public.locations(id,name,can_sell)values('${loc}','EOQ concurrency',true);insert into public.suppliers(id,name,quoted_lead_days,payment_terms_days)values('${supplier}','EOQ concurrency',3,30);insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,supplier_id,lead_days)values('EOQ-CC','EOQ concurrent component','Ingredient','EOQ-CC','oz','bag',64,1,0,'${supplier}',3);`);
const payload={orders:[{supplierId:supplier,locationId:loc,date:sync("select (now() at time zone 'America/Denver')::date"),send:false,notes:'Created during shared inventory review',lines:[{sku:'EOQ-CC',qty:2,price:64}]}]};
const sql=id=>`select public.erp_purchasing_write('${id}','create_orders','${JSON.stringify(payload)}'::jsonb);`;
const id=randomUUID();let results=await Promise.all([send(sql(id)),send(sql(randomUUID()))]);
assert.equal(results.filter(r=>!r.error).length,1,JSON.stringify(results));assert.match(results.find(r=>r.error).stderr,/purchase draft already exists/);
assert.equal(sync("select count(*) from public.purchase_orders p join public.purchase_order_lines l on l.purchase_order_id=p.id where l.item_sku='EOQ-CC'"),'1');
console.log('PASS: competing workflow saves serialize and create one purchase draft only.');
