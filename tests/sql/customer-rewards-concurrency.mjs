// Native disposable PostgreSQL only. Never accepts a production host/database.
import assert from 'node:assert/strict';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
if(process.env.PGDATABASE!=='erp_test'||!['127.0.0.1','localhost'].includes(process.env.PGHOST))throw Error('Use the isolated local erp_test database.');
const manager='00000000-0000-0000-0000-000000000001';
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
const args=(user,sql)=>['-X','-qAt','-v','ON_ERROR_STOP=1','-c',`set request.jwt.claim.sub=${q(user)};set statement_timeout='20s';${sql}`];
const sync=(user,sql)=>execFileSync('psql',args(user,sql),{encoding:'utf8'}).trim().split('\n').at(-1);
const send=(user,sql)=>new Promise(resolve=>execFile('psql',args(user,sql),{encoding:'utf8'},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
const loc=randomUUID();
sync(manager,`insert into public.locations(id,name,can_sell)values('${loc}','Rewards concurrency',true);
insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,unit_cost,selling_price)values('RW-CONCURRENCY','Rewards concurrency drink','Beverage','RW-CONCURRENCY','each','case',1,10);
insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type)values('RW-CONCURRENCY','${loc}',1000,1,'Receipt');`);
const fixture=n=>{
 const user=randomUUID(),customer=randomUUID(),phone='80155503'+String(n).padStart(2,'0');
 sync(manager,`insert into auth.users(id)values('${user}');insert into public.customers(id,name,phone)values('${customer}','Rewards concurrency',${q(phone)});
 insert into public.profiles(user_id,role,customer_id)values('${user}','Customer','${customer}');
 select public.erp_pos_customer(${q(phone)},'Rewards concurrency');
 select public.erp_pos_sale('${randomUUID()}','${loc}','[{"sku":"RW-CONCURRENCY","qty":10}]',0,${q(phone)},'Rewards concurrency',false,'Cash');`);
 const payload={rewardsVersion:1,redeemRewards:true,name:'Concurrent pickup',phone,location:'Rewards concurrency',pickup:new Date(Date.now()+86400000).toISOString(),lines:[{sku:'RW-CONCURRENCY',qty:1}],discountPct:0,discountAmount:0};
 return {user,customer,phone,payload};
};
const checkout=(id,f)=>`select public.erp_customer_rewards_checkout('${id}',${q(JSON.stringify(f.payload))}::jsonb);`;
const balance=f=>Number(sync(manager,`select public.erp_rewards_balance('${f.customer}');`));

let f=fixture(1),request=randomUUID();
let results=await Promise.all([send(f.user,checkout(request,f)),send(f.user,checkout(request,f))]);
assert.ok(results.every(r=>!r.error),JSON.stringify(results));
assert.equal(sync(manager,`select count(*) from public.erp_customer_rewards_orders where customer_id='${f.customer}';`),'1');
assert.equal(balance(f),0);

f=fixture(2);
results=await Promise.all([send(f.user,checkout(randomUUID(),f)),send(f.user,checkout(randomUUID(),f))]);
assert.equal(results.filter(r=>!r.error).length,1,JSON.stringify(results));
assert.match(results.find(r=>r.error).stderr,/100 available points/);
assert.equal(balance(f),0);

f=fixture(3);
results=await Promise.all([
 send(f.user,checkout(randomUUID(),f)),
 send(manager,`select public.erp_pos_sale('${randomUUID()}','${loc}','[{"sku":"RW-CONCURRENCY","qty":1}]',0,${q(f.phone)},'Rewards concurrency',true,'Cash');`),
]);
assert.equal(results.filter(r=>!r.error).length,1,JSON.stringify(results));
assert.match(results.find(r=>r.error).stderr,/100 (available )?points/);
assert.ok([0,5].includes(balance(f)),'one reservation OR one POS redemption and its five earned points');

// Prepare and cancel contend on one order row. Exactly one legal outcome:
// a completed five-point sale, or cancellation with the original 100 restored.
f=fixture(4);request=randomUUID();sync(f.user,checkout(request,f));
results=await Promise.all([
 send(manager,`select public.erp_pickup_progress('${request}','prepare');`),
 send(manager,`select public.erp_pickup_progress('${request}','cancel');`),
]);
assert.equal(results.filter(r=>!r.error).length,1,JSON.stringify(results));
assert.ok([5,100].includes(balance(f)));
const state=sync(manager,`select state from public.erp_customer_rewards_orders where order_id='${request}';`);
assert.ok(['Posted','Cancelled'].includes(state));
// Always exercise concurrent fulfillment, regardless of the race winner above.
f=fixture(5);request=randomUUID();sync(f.user,checkout(request,f));
sync(manager,`select public.erp_pickup_progress('${request}','prepare');`);
const initial=balance(f);assert.equal(initial,5);
results=await Promise.all([send(manager,`select public.erp_pickup_progress('${request}','fulfill');`),send(manager,`select public.erp_pickup_action('${request}','fulfill');`)]);
assert.ok(results.every(r=>!r.error),JSON.stringify(results));assert.equal(balance(f),initial);
assert.equal(sync(manager,`select count(*) from public.sales where customer_id='${f.customer}';`),'2','one original earning sale plus one rewarded online sale');
// Deterministic regression for recovery vs preparation: hold the order row,
// wait until recovery is blocked on it, then allow preparation to finish. The
// old candidate locked the manifest first and could deadlock in the trigger.
f=fixture(6);request=randomUUID();sync(f.user,checkout(request,f));
const actor=spawn('psql',['-X','-qAt','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
let actorOut='',actorError='';actor.stdout.on('data',v=>actorOut+=v);actor.stderr.on('data',v=>actorError+=v);
const actorExit=new Promise(resolve=>actor.on('close',code=>resolve(code)));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let recovery;
try{
 actor.stdin.write(`set request.jwt.claim.sub='${manager}';set statement_timeout='20s';begin;select id from public.sales_orders where id='${request}' for update;select 'ORDER_LOCK_READY';\n`);
 for(let i=0;!actorOut.includes('ORDER_LOCK_READY');i++){
  if(i>=150)throw Error('Preparation lock barrier failed: '+actorError);await pause(20);
 }
 const app='rw-recovery-'+randomUUID();
 recovery=send(f.user,`set application_name=${q(app)};`+checkout(request,f));
 let waiting=false;
 for(let i=0;i<100;i++){
  waiting=sync(manager,`select exists(select 1 from pg_stat_activity where application_name=${q(app)} and wait_event_type='Lock');`)==='t';
  if(waiting)break;await pause(20);
 }
 assert.ok(waiting,'recovery must contend on the locked order');
 actor.stdin.end(`select public.erp_pickup_progress('${request}','prepare');commit;\n`);
 const [code,recovered]=await Promise.all([actorExit,recovery]);
 assert.equal(code,0,actorError);assert.ok(!recovered.error,JSON.stringify(recovered));
 assert.equal(balance(f),5,'recovery vs preparation must spend/earn exactly once');
}finally{
 if(!actor.stdin.writableEnded)actor.stdin.end('rollback;\n');
}
console.log('PASS: concurrent identical retries reserve once; distinct online requests and POS/online spending have one winner; prepare/cancel is atomic; repeated fulfillment cannot earn twice; recovery/preparation has a forced lock-contention regression. Native isolated PostgreSQL.');
