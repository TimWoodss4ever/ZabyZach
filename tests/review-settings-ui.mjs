import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as React from 'react';
import * as runtime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import * as purchasing from '../src/sharedPurchasing.ts';
const snapshot={version:1,userId:'manager',today:'2026-11-17',suppliers:[],items:[],locations:[{id:'store',name:'Store'}],orders:[],lines:[],receipts:[],receiptLines:[],invoices:[],payments:[],reviews:[],inventoryReviews:[],audit:[],options:{order_cost:25,holding_rate:.25,safety_days:2,review_days:7,revision:3},stock:{},dailyUsage:{}};
let cursor=0;
const hooks={...React,useState(initial){const n=cursor++;return[n===0?snapshot:typeof initial==='function'?initial():initial,()=>{}];},useMemo(fn){return fn();},useEffect(){},useCallback(fn){return fn;},useRef(value){return{current:value};}};
const source=await readFile('src/SharedPurchasingScreens.tsx','utf8');
const js=ts.transpileModule(source.replaceAll('import.meta.env.VITE_SUPABASE_URL',"'https://test.invalid'"),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const require=name=>({'react':hooks,'react/jsx-runtime':runtime,'./supabase':{supabase:{}},'./domain':{fmt:n=>'$'+n},'./purchasing':{formatSupplierPercent:String,formatSupplierScore:String},'./sharedPurchasing':purchasing}[name]);
const exports={};
class TestFormData{constructor(form){return new Map(Object.entries(form.values));}}
new Function('require','exports','FormData',js)(require,exports,TestFormData);
function view(name){cursor=0;return exports.SharedPurchasingScreen({view:name,flash(){},onOpenSettings(){}});}
function find(node,predicate){if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
let tree=view('Inventory Review'),html=renderToStaticMarkup(tree);
assert.match(html,/Finish your inventory review/);assert.match(html,/Review notes/);assert.match(html,/optional/);assert.match(html,/No reviews saved yet/);assert.match(html,/does not create or issue purchase orders/);assert.doesNotMatch(html,/Shared ordering options|Annual holding fraction/);assert.match(html,/View ordering settings/);
snapshot.inventoryReviews=[{id:'review',notes:'Checked stock',created_at:'2026-11-10T19:00:00Z',created_by:'manager'}];
html=renderToStaticMarkup(view('Inventory Review'));assert.match(html,/Review due/);assert.match(html,/Checked stock/);assert.match(html,/Nov 17, 2026/);
snapshot.inventoryReviews[0].created_at='2026-11-17T19:00:00Z';html=renderToStaticMarkup(view('Inventory Review'));assert.match(html,/Up to date/);assert.match(html,/Nov 24, 2026/);
tree=view('Ordering options');const component=find(tree,n=>typeof n.type==='function'&&n.type.name==='SharedOrderingOptions');assert.ok(component);
const calls=[];cursor=100;const settings=component.type({...component.props,save:async(action,payload)=>{calls.push({action,payload});return true;}});
html=renderToStaticMarkup(settings);assert.match(html,/name="holdingPercent"[^>]*value="25"/);assert.match(html,/Saved for all managers/);
const form=find(settings,n=>n.type==='form');await form.props.onSubmit({preventDefault(){},currentTarget:{values:{orderCost:'30',holdingPercent:'12.5',safetyDays:'3',reviewDays:'14'}}});
assert.deepEqual(calls,[{action:'save_options',payload:{revision:3,orderCost:30,holdingRate:.125,safetyDays:3,reviewDays:14}}]);
cursor=100;const locked=component.type({...component.props,locked:true});assert.match(renderToStaticMarkup(locked),/<fieldset disabled=""/);
console.log('PASS: review empty/due/current schedules, recent notes, optional completion and order distinction; Settings renders shared fields, converts percentage to fraction, preserves revision and disables writes when locked. Mocked rendering, not live writes.');
