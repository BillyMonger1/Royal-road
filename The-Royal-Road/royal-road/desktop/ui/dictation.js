/* The Royal Road — dictation.
   Wraps the browser's speech recognition so it keeps listening through pauses until told to stop,
   copes with the different ways phones and desktops report results, and waits for the last words.
   Optionally exposes the microphone level so a trace can follow the voice. */
(function (root) {
  'use strict';
  const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
  const ANDROID = /Android/i.test(navigator.userAgent);
  const join = (a, b) => (String(a || '').trim() + ' ' + String(b || '').trim()).trim();
  const starts = (long, short) => !!short && long.toLowerCase().startsWith(short.toLowerCase());

  function explain(code) {
    if (code === 'not-allowed' || code === 'service-not-allowed') return 'The microphone is blocked. Allow it for this app, or type the dream instead.';
    if (code === 'network') return 'Transcription needs an internet connection. Type the dream instead, or try again when online.';
    if (code === 'audio-capture') return 'No microphone was found. Plug one in, or type the dream instead.';
    if (code === 'language-not-supported') return 'Transcription does not support this language setting.';
    return 'Listening stopped unexpectedly. What was said so far is kept.';
  }

  class Dictation {
    /* opts: { onText(text, interim), onState(listening), onDone(text, note), meter: true } */
    constructor(opts) {
      this.o = opts || {}; this.listening = false; this.finishing = null;
      this.base = ''; this.session = ''; this.interim = ''; this.quick = 0; this.started = 0;
      this.level = 0; this.analyser = null; this.stream = null; this.wave = null;
      this.onDevice = false;
      if (SR && SR.available) {
        SR.available({ langs: [this.lang()], processLocally: true }).then(r => { this.onDevice = r === 'available'; }).catch(() => {});
      }
    }
    static supported() { return !!SR; }
    lang() { return navigator.language || 'en-AU'; }
    text() { return join(this.base, join(this.session, this.interim)); }

    async start(existing) {
      if (!SR) { this.o.onDone && this.o.onDone(existing || '', 'Transcription is not available here. Type the dream instead.'); return; }
      if (this.listening || this.finishing) return;
      this.base = existing || ''; this.session = ''; this.interim = ''; this.quick = 0; this.listening = true;
      this.o.onState && this.o.onState(true);
      if (this.o.meter) this._meter();
      try { this._engine(); } catch (e) { this._end('Listening could not start. Type the dream instead.'); }
    }

    stop() { if (this.listening) this._end(''); }

    _engine() {
      const r = this.rec = new SR();
      r.lang = this.lang(); r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
      if (this.onDevice) { try { r.processLocally = true; } catch (e) { /* not on this version */ } }
      this.started = Date.now();
      r.onresult = e => {
        if (ANDROID) {
          // Some Android versions repeat everything said so far in each result; others send only the new phrase.
          const res = e.results[e.results.length - 1], t = res[0].transcript.trim();
          if (res.isFinal) {
            if (starts(t, this.session)) this.session = t;
            else if (!this.session.toLowerCase().endsWith(t.toLowerCase())) this.session = join(this.session, t);
            this.interim = '';
          } else this.interim = starts(t, this.session) ? t.slice(this.session.length).trim() : t;
        } else {
          let fin = '', part = '';
          for (let i = 0; i < e.results.length; i++) { if (e.results[i].isFinal) fin += e.results[i][0].transcript + ' '; else part += e.results[i][0].transcript; }
          this.session = fin.trim(); this.interim = part.trim();
        }
        this.level = Math.min(1.4, this.level + 0.5);
        this.o.onText && this.o.onText(join(this.base, this.session), this.interim);
      };
      r.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') this._end(explain(e.error)); };
      r.onend = () => {
        this.base = join(this.base, join(this.session, this.interim)); this.session = ''; this.interim = '';
        if (!this.listening) { if (this.finishing) this._finish(); return; }
        // The engine ends a session after a pause; carry on until the person stops it.
        this.quick = Date.now() - this.started < 700 ? this.quick + 1 : 0;
        if (this.quick >= 4) { this._end('Listening keeps stopping. What was said so far is kept.'); return; }
        setTimeout(() => { if (this.listening) { try { this._engine(); } catch (err) { this._end('Listening could not restart. What was said so far is kept.'); } } }, 180);
      };
      r.start();
    }

    _end(note) {
      if (!this.listening) return;
      this.listening = false;
      this.o.onState && this.o.onState(false);
      try { this.rec && this.rec.stop(); } catch (e) { /* already stopped */ }
      this._unmeter();
      // The last phrase often arrives after stopping, so wait for the engine to say it has finished.
      this.finishing = { note: note || '', timer: setTimeout(() => this._finish(), 1500) };
    }

    _finish() {
      if (!this.finishing) return;
      const note = this.finishing.note; clearTimeout(this.finishing.timer); this.finishing = null;
      const text = this.text(); this.base = text; this.session = ''; this.interim = '';
      this.o.onDone && this.o.onDone(text, note);
    }

    /* Microphone level for the trace. If the microphone cannot be shared, the trace follows recognised words instead. */
    async _meter() {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (!this.listening) { this._unmeter(); return; }
        const ctx = this.actx = new (root.AudioContext || root.webkitAudioContext)();
        const src = ctx.createMediaStreamSource(this.stream);
        this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 1024;
        this.wave = new Float32Array(this.analyser.fftSize);
        src.connect(this.analyser);
      } catch (e) { this.analyser = null; }
    }
    _unmeter() {
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      if (this.actx) this.actx.close().catch(() => {});
      this.stream = null; this.actx = null; this.analyser = null;
    }
    /* Returns the live waveform (Float32Array, -1..1) or null. */
    samples() { if (!this.analyser) return null; this.analyser.getFloatTimeDomainData(this.wave); return this.wave; }
  }

  /* Records the microphone and sends the recording to a transcription service when stopped.
     Used by the desktop app, where the browser's own speech service is not available.
     opts.transcribe(arrayBuffer, mimeType) -> { ok, text, error } */
  class Recorder {
    constructor(opts) { this.o = opts || {}; this.listening = false; this.finishing = null; this.level = 0; this.base = ''; }
    static supported() { return !!(navigator.mediaDevices && root.MediaRecorder); }
    async start(existing) {
      if (this.listening || this.finishing) return;
      this.base = existing || '';
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      } catch (e) {
        this.o.onDone && this.o.onDone(this.base, e && e.name === 'NotFoundError' ? 'No microphone was found. Plug one in, or type the dream instead.' : 'The microphone is blocked. Allow it in Windows Settings › Privacy › Microphone, or type the dream instead.');
        return;
      }
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t)) || '';
      this.chunks = []; this.rec = new MediaRecorder(this.stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
      this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
      this.rec.onstop = () => this._send();
      this.rec.start(1000);
      const ctx = this.actx = new (root.AudioContext || root.webkitAudioContext)();
      this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 1024; this.wave = new Float32Array(1024);
      ctx.createMediaStreamSource(this.stream).connect(this.analyser);
      this.listening = true; this.started = Date.now();
      this.o.onState && this.o.onState(true);
      // Recordings are capped at 20 minutes so they stay within the services' upload limits.
      this.cap = setTimeout(() => this.stop(), 20 * 60 * 1000);
    }
    stop() {
      if (!this.listening) return;
      this.listening = false; clearTimeout(this.cap);
      this.o.onState && this.o.onState(false);
      this.finishing = true;
      this.o.onText && this.o.onText(this.base, 'Turning speech into text…');
      try { this.rec.stop(); } catch (e) { this._send(); }
      this.stream.getTracks().forEach(t => t.stop());
      if (this.actx) this.actx.close().catch(() => {});
      this.analyser = null;
    }
    async _send() {
      const blob = new Blob(this.chunks || [], { type: (this.rec && this.rec.mimeType) || 'audio/webm' });
      let text = this.base, note = '';
      if (blob.size < 2000 || Date.now() - this.started < 700) note = 'Nothing was recorded. Try again a little closer to the microphone.';
      else {
        const r = await this.o.transcribe(await blob.arrayBuffer(), blob.type);
        if (r && r.ok) { text = join(this.base, r.text); if (!String(r.text || '').trim()) note = 'No words were heard in that recording.'; }
        else note = (r && r.error) || 'Transcription failed.';
      }
      this.finishing = null; this.chunks = [];
      this.o.onDone && this.o.onDone(text, note);
    }
    samples() { if (!this.analyser) return null; this.analyser.getFloatTimeDomainData(this.wave); return this.wave; }
  }

  root.Dictation = Dictation;
  root.Recorder = Recorder;
})(typeof self !== 'undefined' ? self : this);
