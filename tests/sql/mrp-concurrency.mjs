// DISPOSABLE DATABASE ONLY: independent native PostgreSQL sessions, no mocks.
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
if (process.env.PGDATABASE !== 'erp_test' || !['127.0.0.1', 'localhost'].includes(process.env.PGHOST)) throw Error('MRP concurrency tests require the isolated local erp_test database.');
const auth = "set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';set statement_timeout='20s';";
const args = sql => ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', auth + sql];
const sync = sql => execFileSync('psql', args(sql), {encoding: 'utf8'}).trim().split('\n').at(-1);
const send = sql => new Promise(resolve => execFile('psql', args(sql), {encoding: 'utf8'}, (error, stdout, stderr) => resolve({error, stdout, stderr})));
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const store = randomUUID(), first = randomUUID();
sync(`insert into public.locations(id,name,can_sell) values('${store}','MRP concurrency fixture',true);
insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,unit_cost,selling_price) values
('MRP-RACE-C','MRP race component','Ingredient','MRP-RACE-C','oz','bag',1,0),
('MRP-RACE-P','MRP race parent','Pizza','MRP-RACE-P','each','each',0,10);
insert into public.bom_lines(parent_sku,component_sku,quantity) values('MRP-RACE-P','MRP-RACE-C',1);
insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type) values('MRP-RACE-C','${store}',1,1,'Receipt');`);
const payload = {name: 'Concurrency fixture', location: 'MRP concurrency fixture', pickup: new Date(Date.now() + 14 * 86400000).toISOString(), lines: [{sku: 'MRP-RACE-P', qty: 1}]};
const create = id => `select public.erp_create_pickup_order('${id}',${quote(JSON.stringify(payload))}::jsonb);`;
let results = await Promise.all([send(create(first)), send(create(first))]);
assert.ok(results.every(r => !r.error), JSON.stringify(results));
assert.equal(sync(`select count(*) from public.sales_order_lines where order_id='${first}';`), '1');
assert.equal(sync(`select sum(quantity) from public.inventory_transactions where item_sku='MRP-RACE-C' and location_id='${store}';`), '1');
results = await Promise.all([
  send(`select public.erp_pickup_action('${first}','prepare');`),
  send(`select public.erp_pickup_progress('${first}','fulfill');`)
]);
assert.ok(results.every(r => !r.error), JSON.stringify(results));
assert.equal(sync(`select count(*) from public.inventory_transactions where item_sku='MRP-RACE-C' and location_id='${store}' and transaction_type='Sale';`), '1');
assert.equal(sync(`select status from public.sales_orders where id='${first}';`), 'Fulfilled');
// Two distinct confirmed orders compete for one remaining component. Both may
// confirm; exactly one may prepare, leaving the other as actionable MRP demand.
sync(`insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type) values('MRP-RACE-C','${store}',1,1,'Receipt');`);
const second = randomUUID(), third = randomUUID();
sync(create(second)); sync(create(third));
results = await Promise.all([second, third].map(id => send(`select public.erp_pickup_progress('${id}','prepare');`)));
assert.equal(results.filter(r => !r.error).length, 1, JSON.stringify(results));
assert.equal(sync(`select sum(quantity) from public.inventory_transactions where item_sku='MRP-RACE-C' and location_id='${store}';`), '0');
assert.equal(sync(`select count(*) from public.sales_orders where id in ('${second}','${third}') and status='Order Placed' and erp_sale_id is null and erp_prepared_at is null;`), '1');
console.log('PASS: concurrent confirmation creates one demand; prepare/fulfill across both endpoints consumes once; competing preparations cannot overdraw and preserve the losing order as MRP demand.');
