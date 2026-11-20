// DISPOSABLE DATABASE ONLY. Force an earlier transaction to check stock AFTER
// a later transaction commits its sale. This exposes the now() cutoff reliably.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
if(process.env.PGDATABASE!=='erp_test'||!['127.0.0.1','localhost'].includes(process.env.PGHOST))throw Error('Stock visibility test requires isolated local erp_test.');
const auth="set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';set statement_timeout='20s';";
const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
const run=sql=>execFileSync('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-c',auth+sql],{encoding:'utf8'}).trim().split('\n').at(-1);
const store=randomUUID(),earlier=randomUUID(),later=randomUUID(),tag=randomUUID().slice(0,8),component='TIME-C-'+tag,parent='TIME-P-'+tag;
run(`insert into public.locations(id,name,can_sell) values('${store}','${tag}',true);
insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,unit_cost,selling_price) values
('${component}','Time cutoff ingredient','Ingredient','${component}','oz','bag',1,0),('${parent}','Time cutoff parent','Pizza','${parent}','each','each',0,10);
insert into public.bom_lines(parent_sku,component_sku,quantity)values('${parent}','${component}',1);
insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,occurred_at)values('${component}','${store}',1,1,'Receipt',clock_timestamp()-interval '1 minute');`);
const payload=JSON.stringify({name:'Time cutoff fixture',location:tag,pickup:new Date(Date.now()+14*86400000).toISOString(),lines:[{sku:parent,qty:1}]});
for(const id of [earlier,later])run(`select public.erp_create_pickup_order('${id}',${quote(payload)}::jsonb);`);
const child=spawn('psql',['-X','-qAt','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});
let readyTimer;
try{
 const ready=new Promise((resolve,reject)=>{readyTimer=setTimeout(()=>reject(Error('Early transaction did not become ready: '+stderr)),10000);child.stdout.on('data',()=>{if(stdout.includes('EARLY_READY'))resolve();});child.once('error',reject);});
 child.stdin.write('begin;\n'+auth+"select 'EARLY_READY';\n");await ready;clearTimeout(readyTimer);
 // This winner starts AFTER the early transaction but commits BEFORE its stock check.
 run(`select public.erp_pickup_progress('${later}','prepare');`);
 child.stdin.end(`select public.erp_pickup_progress('${earlier}','prepare');\ncommit;\n\\q\n`);
 const status=await ended;
 assert.notEqual(status,0,'older request accepted stock already used by the later winner: '+stdout);
 assert.match(stderr,/Insufficient (?:stock|component)/,'expected a stock rejection, got '+stderr);
 assert.equal(run(`select sum(quantity) from public.inventory_transactions where item_sku='${component}' and location_id='${store}';`),'0');
 assert.equal(run(`select count(*) from public.inventory_transactions where item_sku='${component}' and location_id='${store}' and transaction_type='Sale';`),'1');
 assert.equal(run(`select count(*) from public.sales_orders where id='${earlier}' and erp_sale_id is null and erp_prepared_at is null and status='Order Placed';`),'1');
 console.log('PASS: an older transaction sees a later committed stock deduction; shortage rolls back without duplicate sale or negative inventory, and keeps the losing order as demand.');
}finally{clearTimeout(readyTimer);if(child.exitCode===null)child.kill();}
