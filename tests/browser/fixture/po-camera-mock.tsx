export function CameraScanner({onClose,onResult}:{onClose:()=>void;onResult:(code:string)=>void}){
 return <div role="dialog" aria-label="Simulated camera callback"><button onClick={()=>onResult((window as any).scanTestCode)}>Use simulated scan</button><button onClick={onClose}>Close simulated camera</button></div>;
}
