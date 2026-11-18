import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import {BrowserStorageNotice} from './BrowserStorageNotice';
import {initializeBrowserStorage} from './browserStorage';
import './style.css';
const root = createRoot(document.getElementById('root')!);
root.render(<div className="login-screen"><div className="login-panel" role="status">Opening your workspace…</div></div>);
// Hydrate before any screen calls synchronous loadState.
void initializeBrowserStorage().then(() => {
  root.render(<React.StrictMode><App/><BrowserStorageNotice/></React.StrictMode>);
});
