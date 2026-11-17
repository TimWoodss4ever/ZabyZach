import {useEffect,useRef} from 'react';
import type {ReactNode} from 'react';
import {X} from 'lucide-react';
export function InventoryDialog({title,id,onClose,busy=false,wide=false,children}:{title:string;id:string;onClose:()=>void;busy?:boolean;wide?:boolean;children:ReactNode}){
 const ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{const before=document.activeElement as HTMLElement|null;const el=ref.current;const target=el?.querySelector<HTMLElement>('input,select,textarea,button');(target??el)?.focus();return()=>before?.focus();},[]);
 return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}><div ref={ref} className={'modal inventory-dialog'+(wide?' inventory-dialog-wide':'')} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} onKeyDown={e=>{
  if(e.key==='Escape'&&!busy){e.stopPropagation();onClose();}
  if(e.key==='Tab'){const targets=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')??[]).filter(el=>el.getClientRects().length);const first=targets[0],last=targets[targets.length-1];if(!first){e.preventDefault();ref.current?.focus();}else if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
 }}><div className="inventory-dialog-heading"><h2 id={id}>{title}</h2><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={19}/></button></div>{children}</div></div>;
}
