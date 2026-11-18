import {useEffect, useState} from 'react';
import {exportBrowserWorkspace, isBrowserStorageUnavailable, observeBrowserStorage} from './browserStorage';
export function BrowserStorageNotice() {
  const [unavailable, setUnavailable] = useState(isBrowserStorageUnavailable);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const update = () => setUnavailable(isBrowserStorageUnavailable());
    const stop = observeBrowserStorage(update);
    update();
    return stop;
  }, []);
  if (!unavailable) return null;
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportBrowserWorkspace()], {type:'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'Za-by-Zack-local-workspace-backup.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <aside role="status" aria-label="Local workspace save status" style={{position:'fixed',bottom:8,right:8,left:8,marginLeft:'auto',maxWidth:480,zIndex:4000,padding:10,background:'#fff4d6',color:'#49360f',border:'1px solid #b8862b',borderRadius:8,fontSize:14}}>
    <span>Local workspace changes aren’t saving on this device.</span>{' '}
    <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? 'Hide details' : 'Details'}</button>
    {expanded && <div><p>Keep this tab open to retain unsaved local changes. Records already saved to the shared database are unaffected. Download a local backup before closing.</p><button type="button" onClick={download}>Download local backup</button></div>}
  </aside>;
}
