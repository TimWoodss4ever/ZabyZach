import assert from 'node:assert/strict';
import {reportDate,shiftReportDate,validateReport,reportTotals,replenish} from '../src/reporting.ts';
assert.equal(reportDate(new Date('2026-11-16T00:30:00Z')),'2026-11-15');
assert.equal(reportDate(new Date('2026-07-02T05:30:00Z')),'2026-07-01');
assert.equal(shiftReportDate('2026-03-09',-1),'2026-03-08');
assert.equal(shiftReportDate('2026-01-01',-1),'2025-12-31');
const r={version:1,today:'2026-11-15',generatedAt:'2026-11-16T00:00:00Z',from:'2026-11-01',to:'2026-11-15',locations:[],
 pnl:{gross:120,discounts:10,refunds:18,tax:6.67,cogs:48,waste:4,adjustments:-2,expenses:12,zeroCostSales:0},
 inventory:[{opening_quantity:10,opening_cost:2,quantity:20,average_cost:3,negative_history:false}],daily:[],weekly:[],topItems:[],lowStock:[],suppliers:[],expenses:[]};
assert.equal(validateReport(r),r);let t=reportTotals(r);
assert.deepEqual(t,{net:92,grossProfit:44,result:26,opening:20,closing:60,average:40,turnover:1.2});
r.inventory[0].negative_history=true;assert.equal(reportTotals(r).turnover,null);r.inventory=[];assert.equal(reportTotals(r).turnover,null);
assert.throws(()=>validateReport({...r,pnl:{...r.pnl,cogs:NaN}}),/incomplete/);assert.throws(()=>validateReport(null),/no report/);assert.throws(()=>validateReport({...r,version:2}),/unsupported/);
const row={quantity:12,on_order:0,daily_usage:4,lead:3,safety:2,review:7,conversion_factor:10,shelf_life_days:null};
assert.deepEqual(replenish(row,'2026-11-15'),{position:12,packages:4,base:40,exceedsShelfLife:false,orderBy:'2026-11-13'});
assert.equal(replenish({...row,on_order:100},'2026-11-15').packages,0);
assert.equal(replenish({...row,daily_usage:0},'2026-11-15').orderBy,null);
const capped=replenish({...row,shelf_life_days:4},'2026-11-15');assert.equal(capped.packages,1);assert.equal(capped.exceedsShelfLife,true);
console.log('PASS: shared-report financial arithmetic, period turnover, negative-stock guard, Denver date boundaries, DST-safe date arithmetic, malformed-response rejection, replenishment pack rounding, open-order netting and shelf-life cap. Pure calculations, not live Supabase.');
