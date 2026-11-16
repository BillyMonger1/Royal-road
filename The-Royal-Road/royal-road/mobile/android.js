/* The Royal Road — only active inside the Android app.
   Presents Android's own speech recognition (free, no key) through the same
   SpeechRecognition interface the browser offers, so app.js works unchanged. */
(function () {
  'use strict';
  const A = window.RoyalAndroid;
  if (!A) return;
  document.documentElement.classList.add('in-app');
  let current = null;
  const listeners = { scan: [] };

  window.__royal = {
    emit(type, data) {
      if (type === 'scan') { listeners.scan.forEach(f => f(data)); listeners.scan = []; return; }
      if (type === 'level') { if (window.__waveKick) window.__waveKick(data.v * 0.6); return; }
      const r = current; if (!r) return;
      if (type === 'result' && r.onresult) r.onresult({ results: [Object.assign([{ transcript: data.text }], { isFinal: !!data.final })] });
      else if (type === 'error' && r.onerror) r.onerror({ error: data.code });
      else if (type === 'end') { current = null; if (r.onend) r.onend(); }
    }
  };

  if (A.speechAvailable()) {
    window.SpeechRecognition = class {
      constructor() { this.lang = navigator.language || 'en-AU'; }
      start() { current = this; A.startListening(this.lang); }
      stop() { A.stopListening(); }
      abort() { A.abortListening(); }
    };
    window.webkitSpeechRecognition = window.SpeechRecognition;
  } else {
    window.SpeechRecognition = window.webkitSpeechRecognition = undefined;
  }

  window.RoyalScan = () => new Promise(res => { listeners.scan.push(res); A.scanCode(); });
})();
