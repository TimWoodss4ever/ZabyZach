import {useEffect, useState} from 'react';
import {isBrowserStorageUnavailable, observeBrowserStorage} from './browserStorage';
export function BrowserStorageNotice() {
  const [unavailable, setUnavailable] = useState(isBrowserStorageUnavailable);
  useEffect(() => {
    const update = () => setUnavailable(isBrowserStorageUnavailable());
    const stop = observeBrowserStorage(update);
    update();
    return stop;
  }, []);
  if (!unavailable) return null;
  return <div role="status" style={{position:'fixed',bottom:8,left:8,right:8,zIndex:4000,padding:12,background:'#fff4d6',color:'#49360f',border:'1px solid #b8862b',borderRadius:8,fontSize:14}}>
    Browser storage is unavailable. Changes to the local workspace may be lost when this page closes. Records saved to the shared database are unaffected.
  </div>;
}
