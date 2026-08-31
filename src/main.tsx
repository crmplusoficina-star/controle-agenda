import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { SessionProvider } from './session';
import { ArIAWidget } from './components/ArIAWidget';
import { TutorialOverlay } from './components/TutorialOverlay';
import './enhancements.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SessionProvider>
      <App />
      <TutorialOverlay />
      <ArIAWidget />
    </SessionProvider>
  </React.StrictMode>
);
