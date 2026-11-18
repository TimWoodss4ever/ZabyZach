import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import {BrowserStorageNotice} from './BrowserStorageNotice';
import './style.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/><BrowserStorageNotice/></React.StrictMode>);
