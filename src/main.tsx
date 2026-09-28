import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { SessionProvider } from './session';
import { ArIAWidget } from './components/ArIAWidget';
import { TutorialOverlay } from './components/TutorialOverlay';
import './enhancements.css';

const presentationMode = new URLSearchParams(window.location.search).get('presentation') === '1';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SessionProvider>
      <App />
      {!presentationMode && <TutorialOverlay />}
      {!presentationMode && <ArIAWidget />}
    </SessionProvider>
  </React.StrictMode>
);
