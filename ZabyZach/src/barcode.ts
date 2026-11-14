import { code128Patterns } from './barcodePatterns';

// Code 128 subset B renderer for the printable ZBZ SKU labels.
export function renderCode128(target:SVGSVGElement, value:string){
  const codes=[104,...Array.from(value).map(c=>c.charCodeAt(0)-32)];
  if(codes.slice(1).some(c=>c<0||c>95))throw new Error('Label contains a character not supported by Code 128 B.');
  codes.push(codes.reduce((sum,code,index)=>sum+code*(index||1),0)%103,106);
  const unit=2.2,height=35,quiet=8;let x=quiet;const pieces:string[]=[];
  for(const code of codes){const p=code128Patterns[code];for(let n=0;n<p.length;n++){const width=(p.charCodeAt(n)&31)*unit;if(p[n]===p[n].toUpperCase())pieces.push(`<rect x="${x}" y="0" width="${width}" height="${height}"/>`);x+=width;}}
  target.setAttribute('viewBox',`0 0 ${x+quiet} ${height}`);target.setAttribute('preserveAspectRatio','none');target.innerHTML=`<rect width="100%" height="100%" fill="#fff"/>${pieces.join('')}`;
}
