import {useEffect,useRef,useState} from 'react';
import {X,ScanLine} from 'lucide-react';
import {decodeCode128Image} from './scanCode128';
export function CameraScanner({onClose,onResult}:{onClose:()=>void;onResult:(value:string)=>void}){
 const video=useRef<HTMLVideoElement>(null),result=useRef(onResult);result.current=onResult;const [message,setMessage]=useState('Starting camera…');
 useEffect(()=>{let stream:MediaStream|undefined,stopped=false,timer:ReturnType<typeof setTimeout>|undefined;const stop=()=>{stopped=true;if(timer)clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());};
 const start=async()=>{try{
  if(!navigator.mediaDevices?.getUserMedia){setMessage('Camera access requires the secure HTTPS website. You can still enter the barcode manually.');return;}
  stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});if(stopped){stream.getTracks().forEach(t=>t.stop());return;}
  if(!video.current){stop();return;}video.current.srcObject=stream;await video.current.play();if(stopped)return;
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});let detector:any=null;try{const Native=(window as any).BarcodeDetector;if(Native)detector=new Native({formats:['code_128']});}catch{}
  setMessage('Hold one printed label steady in good light. Keep the full barcode and white margins visible.');
  const scan=async()=>{if(stopped||!video.current)return;try{let code:string|null=null;
   if(detector){try{const found=await detector.detect(video.current);code=found[0]?.rawValue??null;}catch{detector=null;}}
   if(!code&&ctx&&video.current.readyState>=2){const v=video.current;canvas.width=Math.min(1280,v.videoWidth);canvas.height=Math.round(canvas.width*v.videoHeight/v.videoWidth);if(canvas.width&&canvas.height){ctx.drawImage(v,0,0,canvas.width,canvas.height);code=decodeCode128Image(ctx.getImageData(0,0,canvas.width,canvas.height));}}
   if(code&&!stopped){stop();result.current(code);return;}
  }catch{}if(!stopped)timer=setTimeout(scan,300);};void scan();
 }catch(e){if(!stopped)setMessage((e as Error).name==='NotAllowedError'?'Camera permission was denied. Allow camera access in your browser settings, or enter the barcode manually.':'Could not start the camera. Close other camera apps and retry, or enter the barcode manually.');}};void start();return stop;
 },[]);
 return <div className="modal-backdrop" style={{zIndex:2000}}><div className="modal camera-modal" role="dialog" aria-label="Scan a barcode"><button className="modal-x" aria-label="Close camera" onClick={onClose}><X size={18}/></button><h2>Scan an item label</h2><video ref={video} muted playsInline style={{width:'100%',maxHeight:'55vh',objectFit:'contain'}}/><p className="camera-message" role="status"><ScanLine size={16}/>{message}</p><button className="button secondary full" onClick={onClose}>Close scanner</button></div></div>;
}
