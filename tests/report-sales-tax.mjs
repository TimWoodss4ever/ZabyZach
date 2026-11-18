import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {salesByPeriod,reportTotals,validateReport} from '../src/reporting.ts';

// Test fixtures only: different historical taxes, discounts, refund-only day,
// partial Monday weeks across year-end, zero activity, and a DST boundary.
const data={daily:[
 {day:'2026-12-31',net:90,tax:6.53},
 {day:'2027-01-01',net:-20,tax:-1.45},
 {day:'2027-01-03',net:10,tax:.8},
 {day:'2027-01-04',net:0,tax:0},
],weekly:[{week:'2026-12-28',net:80},{week:'2027-01-04',net:0}]};
const original=structuredClone(data);
assert.deepEqual(salesByPeriod(data,'daily'),[
 {date:'2026-12-31',net:90,tax:6.53,total:96.53},
 {date:'2027-01-01',net:-20,tax:-1.45,total:-21.45},
 {date:'2027-01-03',net:10,tax:.8,total:10.8},
 {date:'2027-01-04',net:0,tax:0,total:0},
]);
assert.deepEqual(salesByPeriod(data,'weekly'),[
 {date:'2026-12-28',net:80,tax:5.88,total:85.88},
 {date:'2027-01-04',net:0,tax:0,total:0},
]);
assert.equal(salesByPeriod(data,'weekly')[0].total,96.53-21.45+10.8);
assert.deepEqual(data,original,'report data must remain unchanged');
assert.deepEqual(salesByPeriod({daily:[],weekly:[]},'weekly'),[]);
assert.equal(salesByPeriod({daily:[{day:'2026-03-08',net:1,tax:.1},{day:'2026-03-09',net:2,tax:.2}],weekly:[{week:'2026-03-02',net:1},{week:'2026-03-09',net:2}]},'weekly')[1].tax,.2);
assert.equal(salesByPeriod({daily:[{day:'2026-11-18',net:.1,tax:.2}],weekly:[]},'daily')[0].total,.3);
for(const tax of [undefined,null,NaN,'1.25'])assert.throws(()=>salesByPeriod({daily:[{day:'2026-11-18',net:10,tax}],weekly:[]},'daily'),/incomplete sales tax/);
assert.throws(()=>salesByPeriod({daily:[],weekly:[{week:'2026-11-16',net:10}]},'weekly'),/incomplete sales tax/);

const snapshot={version:1,generatedAt:'2026-11-18T12:00:00Z',locations:[],pnl:{gross:100,discounts:10,refunds:10,tax:5.88,cogs:40,waste:1,adjustments:0,expenses:2,zeroCostSales:0},inventory:[],topItems:[],lowStock:[],suppliers:[],expenses:[],...data};
const profits=reportTotals(snapshot);
salesByPeriod(snapshot,'daily');salesByPeriod(snapshot,'weekly');
assert.deepEqual(reportTotals(snapshot),profits);
assert.equal(profits.net,80);assert.equal(profits.grossProfit,40);assert.equal(profits.result,37);
assert.equal(validateReport(snapshot),snapshot);
assert.throws(()=>validateReport({...snapshot,daily:[{day:'2026-11-18',net:10}]}),/incomplete numeric/);

// Render the actual table JSX with both groupings; no separate test-only table.
const source=await readFile('src/SharedReporting.tsx','utf8');
const start=source.indexOf('<section className="panel"><div className="panel-head"><div><h2>Sales by ');
assert.ok(start>=0);
const end=source.indexOf('</ReportTable></section>',start)+'</ReportTable></section>'.length;
const jsx=source.slice(start,end);
const compiled=ts.transpileModule('return ('+jsx+');',{compilerOptions:{jsx:ts.JsxEmit.React}}).outputText;
const render=new Function('React','data','grouping','setGrouping','ReportTable','salesByPeriod','shortDate','money',compiled);
for(const grouping of ['daily','weekly']){
 const html=renderToStaticMarkup(render(React,data,grouping,()=>{},({children})=>React.createElement('table',null,children),salesByPeriod,x=>x,n=>n.toLocaleString('en-US',{style:'currency',currency:'USD'})));
 for(const heading of ['NET SALES','SALES TAX','TOTAL INCLUDING TAX'])assert.ok(html.includes(heading));
 for(const row of salesByPeriod(data,grouping))for(const amount of [row.net,row.tax,row.total])assert.ok(html.includes(amount.toLocaleString('en-US',{style:'currency',currency:'USD'})));
}
console.log('PASS: daily/weekly stored tax, negative refund tax, distinct historical taxes, partial/year-boundary weeks, DST, cent arithmetic, incomplete-tax rejection, unchanged profits/data, and actual table server rendering. Fixtures only; not live receipt verification.');
