import { code128Patterns } from './barcodePatterns.ts';

// Code 128 subset B, with a checksum and ten-module quiet zones on both sides.
export function code128Svg(value:string){
 if(!value.length)throw new Error('Enter a barcode value.');
 const codes=[104,...Array.from(value).map(c=>c.charCodeAt(0)-32)];
 if(codes.slice(1).some(c=>c<0||c>95))throw new Error('Label contains a character not supported by Code 128 B.');
 codes.push(codes.reduce((sum,code,index)=>sum+code*(index||1),0)%103,106);
 const unit=2,height=72,quiet=10*unit;let x=quiet;const pieces:string[]=[];
 for(const code of codes){const pattern=code128Patterns[code];for(let n=0;n<pattern.length;n++){const width=(pattern.charCodeAt(n)&31)*unit;if(pattern[n]===pattern[n].toUpperCase())pieces.push(`<rect x="${x}" y="0" width="${width}" height="${height}"/>`);x+=width;}}
 const width=x+quiet;
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Code 128 barcode"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${pieces.join('')}</g></svg>`;
}
export function renderCode128(target:SVGSVGElement,value:string){
 const svg=code128Svg(value);target.setAttribute('viewBox',svg.match(/viewBox="([^"]+)"/)![1]);target.setAttribute('preserveAspectRatio','xMidYMid meet');target.innerHTML=svg.slice(svg.indexOf('>')+1,-6);
}
