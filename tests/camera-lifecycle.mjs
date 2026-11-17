import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {setImmediate} from 'node:timers/promises';
import {code128Svg} from '../src/barcode.ts';
import {decodeCode128Image} from '../src/scanCode128.ts';
const text=await readFile('src/CameraScanner.tsx','utf8');
const code=text.slice(text.indexOf('export function CameraScanner'),text.indexOf(' return <div')).replace('export function','function')+'\n}';
const settle=async()=>{for(let n=0;n<5;n++)await setImmediate();};
function fixture({permission,native,videoReady=true}={}){
 let effect,cleanup,stopped=0,request,ref=0,scheduled=0;const results=[],messages=[],timers=[];
 const svg=code128Svg('ZBZ-1005'),width=Number(svg.match(/viewBox="0 0 (\d+)/)[1]),height=90;
 const bars=[...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map(m=>({x:+m[1],w:+m[2]}));const data=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,v=bars.some(b=>x>=b.x&&x<b.x+b.w)?0:255;data[i]=data[i+1]=data[i+2]=v;data[i+3]=255;}
 const video={play:async()=>{},readyState:videoReady?2:0,videoWidth:width,videoHeight:height};
 const stream={getTracks:()=>[{stop(){stopped++;}}]};const navigator={mediaDevices:{getUserMedia(args){request=args;return permission?permission(stream):Promise.resolve(stream);}}};
 const canvas={getContext:()=>({drawImage(){},getImageData:()=>({width,height,data})})};
 const Component=new Function('useRef','useState','useEffect','navigator','window','document','decodeCode128Image','setTimeout','clearTimeout',stripTypeScriptTypes(code)+';return CameraScanner;')(
  value=>({current:ref++===0?video:value}),value=>[value,v=>messages.push(v)],fn=>{effect=fn;},navigator,{BarcodeDetector:native},{createElement:()=>canvas},decodeCode128Image,fn=>{scheduled++;timers.push(fn);return scheduled;},()=>{});
 Component({onClose(){},onResult:v=>results.push(v)});cleanup=effect();
 return{results,messages,cleanup,stops:()=>stopped,request:()=>request,timers};
}
const fallback=fixture();await settle();assert.deepEqual(fallback.results,['ZBZ-1005']);assert.equal(fallback.stops(),1);assert.equal(fallback.request().video.facingMode.ideal,'environment');fallback.cleanup();
const brokenNative=fixture({native:class{async detect(){throw Error('not supported');}}});await settle();assert.deepEqual(brokenNative.results,['ZBZ-1005'],'broken native detector must fall back');brokenNative.cleanup();
const native=fixture({native:class{async detect(){return[{rawValue:'ZBZ-2007'}];}}});await settle();assert.deepEqual(native.results,['ZBZ-2007']);native.cleanup();
let grant;const late=fixture({permission:stream=>new Promise(resolve=>{grant=()=>resolve(stream);})});late.cleanup();grant();await settle();assert.equal(late.stops(),1,'closing before camera permission resolves must stop the late stream');assert.deepEqual(late.results,[]);
const denied=fixture({permission:()=>Promise.reject(Object.assign(Error('denied'),{name:'NotAllowedError'}))});await settle();assert.ok(denied.messages.some(s=>s.includes('permission was denied')));assert.deepEqual(denied.results,[]);denied.cleanup();
const waiting=fixture({videoReady:false});await settle();assert.equal(waiting.timers.length,1);waiting.cleanup();await waiting.timers[0]();assert.equal(waiting.timers.length,1,'scanner scheduled frames after unmount');assert.equal(waiting.stops(),1);
console.log('PASS: camera fallback without native support; failing native support; native success; rear-camera request; late permission cleanup; permission denial; stopped frame loop. Mock camera/video, not a physical device.');
