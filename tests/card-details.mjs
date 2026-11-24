import assert from 'node:assert/strict';
import {cardError,cardSummary,detectCardBrand} from '../src/cardValidation.ts';
import {createPosCheckout} from '../src/posCheckout.ts';

// --- card format rules (brand + last 4 are the only things ever kept) ---
assert.equal(detectCardBrand('4242 4242 4242 4242'),'Visa');
assert.equal(detectCardBrand('5454 5454 5454 5454'),'Mastercard');
assert.equal(detectCardBrand('3782 822463 10005'),'American Express');
assert.equal(detectCardBrand('6011 1111 1111 1117'),'Discover');
assert.equal(detectCardBrand('9999 0000 1111 2222'),'Other');
assert.deepEqual(cardSummary('4242 4242 4242 1234'),{brand:'Visa',last4:'1234'});
const good={name:'Alex',number:'4242 4242 4242 4242',expiry:'12/30',cvc:'123',zip:'84601'};
assert.equal(cardError(good),'');
assert.match(cardError({...good,name:' '}),/name/i);
assert.match(cardError({...good,number:'4242'}),/card number/i);
assert.match(cardError({...good,expiry:'13/30'}),/MM\/YY/);
assert.match(cardError({...good,cvc:'12'}),/3 digits/);
assert.match(cardError({...good,zip:'8460'}),/5 digits/);
assert.match(cardError({...good,zip:'846011'}),/5 digits/);
assert.equal(cardError({...good,number:'3782 822463 10005',cvc:'1234'}),'');
assert.match(cardError({...good,number:'3782 822463 10005',cvc:'123'}),/4 digits/);

// --- POS: card type + last 4 are saved FIRST, under the same request id as the sale ---
const calls=[];
const store=new Map();
const storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
const result={sale_id:'s1',receipt_no:'Order 1',subtotal:10,discount:0,tax:.73,total:10.73,cogs:3,rewards_earned:0,rewards_redeemed:0,rewards_balance:null};
const api={
  from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{id:'loc1'},error:null})})})}),
  rpc:async(name,args)=>{calls.push({name,args});return name==='erp_pos_sale'?{data:result,error:null}:{data:{saved:true},error:null};},
};
const pos=createPosCheckout(api,storage);
const ticket={location:'Provo Store',lines:[{sku:'x',qty:1}],discount:0,phone:'',name:'Alex',redeem:false,paymentMethod:'Card (simulated)',cardBrand:'Visa',cardLast4:'4242'};
await pos.postPosSale(ticket);
assert.deepEqual(calls.map(c=>c.name),['erp_save_order_card','erp_pos_sale']);
assert.equal(calls[0].args.p_order,calls[1].args.p_request);
assert.deepEqual([calls[0].args.p_brand,calls[0].args.p_last4],['Visa','4242']);
const sentText=JSON.stringify(calls);
assert.ok(!/4242 4242|"cvc"|"expiry"|cardNumber/.test(sentText),'full card details must never be sent');

// Cash sales never touch card storage
calls.length=0;
await pos.postPosSale({...ticket,paymentMethod:'Cash',cardBrand:undefined,cardLast4:undefined});
assert.deepEqual(calls.map(c=>c.name),['erp_pos_sale']);

// If the card cannot be saved, no sale is sent and checkout is not left pending
calls.length=0;
const failing=createPosCheckout({...api,rpc:async(name,args)=>{calls.push({name,args});return name==='erp_save_order_card'?{data:null,error:{code:'P0001',message:'Unknown card brand'}}:{data:result,error:null};}},storage);
await assert.rejects(()=>failing.postPosSale(ticket),/Card details could not be saved/);
assert.deepEqual(calls.map(c=>c.name),['erp_save_order_card']);
assert.equal(failing.readPendingPosSale(),null);

// Manager POS: a valid card alone is enough; the order name falls back to the name on the card
import {readFile} from 'node:fs/promises';
const appSrc=await readFile('src/App.tsx','utf8');
assert.ok(appSrc.includes("const orderName=pickupName.trim()||(paymentMethod==='Card (simulated)'?cardName.trim():'');"),'blank order name uses the card name');
assert.ok(appSrc.includes("||paymentMethod==='Card (simulated)'&&!!cardError({name:cardName,number:cardNumber,expiry:cardExpiry,cvc:cardCvc,zip:cardZip})} onClick={()=>void finish()}"),'Complete sale only waits on card details, not on a hidden name box');
assert.equal(cardError({name:'Bob',number:'2859 0385 8230 5802',expiry:'04/28',cvc:'123',zip:'23423'}),'','the card from the bug report is valid');

console.log('PASS: card brand/last-4 rules, ZIP and expiry formats, card saved before the POS sale under the same request id, cash sales and failures handled, full card data never sent.');
