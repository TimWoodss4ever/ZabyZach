import {useState} from 'react';
import {CameraScanner} from './CameraScanner';
import {InventoryDialog} from './InventoryDialog';
export function ItemScanDialog({title,onResult,onClose}:{title:string;onResult:(code:string)=>void;onClose:()=>void}){
 const [camera,setCamera]=useState(false),[value,setValue]=useState('');
 return camera?<CameraScanner onClose={()=>setCamera(false)} onResult={code=>{setCamera(false);onResult(code);}}/>:<InventoryDialog title={title} id="item-scan-title" onClose={onClose}><p>Use your phone camera, or scan with a USB/Bluetooth scanner configured to send Enter. You can also type a barcode or SKU.</p><button type="button" className="button primary" onClick={()=>setCamera(true)}>Scan with phone camera</button><form className="p-form p-spaced" onSubmit={e=>{e.preventDefault();if(value.trim())onResult(value);}}><label>Barcode or SKU<input autoComplete="off" value={value} onChange={e=>setValue(e.target.value)} placeholder="ZBZ-1007 or SKU 1007" required/></label><button className="button secondary">Find item</button></form></InventoryDialog>;
}
