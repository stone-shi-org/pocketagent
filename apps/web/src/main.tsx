import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
