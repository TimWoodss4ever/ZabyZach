import {useState} from 'react';
import {purchaseOrderBarcode,purchaseOrderLabelMarkup,purchaseOrderLabelSheet} from './purchaseOrderScanning';
import type {SharedPO} from './sharedPurchasing';
export function PurchaseOrderBarcode({po,supplier,location}:{po:SharedPO;supplier:string;location:string}){
 const [copyStatus,setCopyStatus]=useState('');
 const sheet=()=>purchaseOrderLabelSheet(po,supplier,location);
 const print=()=>{
  const frame=document.createElement('iframe');frame.title='Printable PO barcode';frame.style.cssText='position:fixed;width:1px;height:1px;bottom:0;left:0;border:0';
  frame.onload=()=>{frame.contentWindow?.focus();frame.contentWindow?.print();};frame.srcdoc=sheet();document.body.appendChild(frame);setTimeout(()=>frame.remove(),120000);
 };
 const download=()=>{const url=URL.createObjectURL(new Blob([sheet()],{type:'text/html'}));const a=document.createElement('a');a.href=url;a.download=po.po_no+'-barcode.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 const copy=async()=>{try{if(!navigator.clipboard)throw Error('Clipboard unavailable');await navigator.clipboard.writeText(purchaseOrderBarcode(po));setCopyStatus('PO barcode value copied.');}catch{setCopyStatus('Copy is unavailable here. Select the barcode value above or download the label.');}};
 return <div><div aria-label={'PO barcode '+po.po_no} dangerouslySetInnerHTML={{__html:purchaseOrderLabelMarkup(po,supplier,location)}}/>
 <p>This barcode opens this specific PO. Scanning alone does not receive or pay for it.</p><div className="p-row-actions"><button type="button" className="button primary" onClick={print}>Print PO barcode</button><button type="button" className="button secondary" onClick={download}>Download PO label</button><button type="button" className="button secondary" onClick={()=>void copy()}>Copy PO barcode value</button></div>{copyStatus&&<p role="status">{copyStatus}</p>}</div>;
}
