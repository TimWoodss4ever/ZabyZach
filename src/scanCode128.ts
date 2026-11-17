import {code128Patterns} from './barcodePatterns.ts';
const patterns=Object.entries(code128Patterns).map(([value,p])=>({value:Number(value),runs:[...p].map(c=>c.toUpperCase().charCodeAt(0)-64)}));
function match(runs:number[],offset:number,size:number){const chunk=runs.slice(offset,offset+size);if(chunk.length!==size)return null;const width=chunk.reduce((a,b)=>a+b,0);let best:{value:number;error:number}|null=null;for(const p of patterns){if(p.runs.length!==size)continue;const modules=p.runs.reduce((a,b)=>a+b,0),scale=width/modules;if(scale<.8)continue;const error=chunk.reduce((a,b,i)=>a+Math.abs(b/scale-p.runs[i]),0)/modules;if(!best||error<best.error)best={value:p.value,error};}return best&&best.error<.24?best:null;}
export function decodeCode128Line(gray:number[]):string|null{
 if(gray.length<60)return null;let lo=255,hi=0;for(const v of gray){lo=Math.min(lo,v);hi=Math.max(hi,v);}if(hi-lo<55)return null;
 const cut=(lo+hi)/2,bits=gray.map(v=>v<cut),runs:number[]=[],starts:number[]=[];let begin=0;for(let i=1;i<=bits.length;i++)if(i===bits.length||bits[i]!==bits[begin]){starts.push(begin);runs.push(i-begin);begin=i;}
 for(let n=0;n<runs.length-18;n++){
  if(!bits[starts[n]])continue;const start=match(runs,n,6);if(start?.value!==104)continue;
  const symbols=[104];let offset=n+6;
  for(let count=0;count<100&&offset<runs.length;count++){
   const stop=match(runs,offset,7);
   if(stop?.value===106&&symbols.length>=3){const checksum=symbols[symbols.length-1];const expected=symbols.slice(0,-1).reduce((s,v,i)=>s+v*(i||1),0)%103;const module=runs.slice(n,n+6).reduce((a,b)=>a+b,0)/11;const quietBefore=n>0?runs[n-1]:starts[n];const quietAfter=runs[offset+7]??0;
    if(checksum===expected&&quietBefore>=module*5&&quietAfter>=module*5&&symbols.slice(1,-1).every(v=>v<95))return symbols.slice(1,-1).map(v=>String.fromCharCode(v+32)).join('');}
   const next=match(runs,offset,6);if(!next||next.value>102)break;symbols.push(next.value);offset+=6;
  }
 }return null;
}
export function decodeCode128Image(image:{width:number;height:number;data:Uint8ClampedArray}):string|null{
 const {width:w,height:h,data}=image;for(const vertical of [false,true])for(const fraction of [.5,.4,.6,.3,.7,.2,.8]){
  const length=vertical?h:w,fixed=Math.floor((vertical?w:h)*fraction),gray:number[]=[];
  for(let n=0;n<length;n++){const i=((vertical?n:fixed)*w+(vertical?fixed:n))*4;gray.push(data[i]*.299+data[i+1]*.587+data[i+2]*.114);}
  const code=decodeCode128Line(gray)??decodeCode128Line(gray.reverse());if(code)return code;
 }return null;
}
