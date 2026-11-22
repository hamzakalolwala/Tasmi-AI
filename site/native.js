/* Inside the Android app (window.TasmiNative exists): speech recognition and text-to-speech come from Android itself.
 * This file makes them look like the browser's SpeechRecognition / speechSynthesis, so app.js runs unchanged.
 * Android keeps the microphone on: it restarts its recogniser after every phrase by itself, silently, and this
 * looks like one continuous session to app.js. On the website this file does nothing. */
(function () {
  'use strict';
  const N = window.TasmiNative;
  if (!N) return;
  document.documentElement.classList.add('native');

  // ---------- speech recognition ----------
  let active = null;
  const result = (t, f) => Object.assign([{ transcript: t, confidence: f ? 0.9 : 0 }], { isFinal: f });
  class NativeRecognition {
    constructor() { this.lang = 'ar-SA'; this.continuous = true; this.interimResults = true; this.maxAlternatives = 1; this._r = []; this._alive = false; }
    start() {
      if (active === this && this._alive) throw Object.assign(new Error('already started'), { name: 'InvalidStateError' });
      if (active && active !== this) active._end(null);
      active = this; this._alive = true; this._r = [];
      N.startListening(this.lang || 'ar-SA');
    }
    stop() { if (active === this) N.stopListening(); this._end(null); }
    abort() { if (active === this) N.stopListening(); this._end('aborted'); }
    _end(err) {
      if (!this._alive) return; this._alive = false;
      if (active === this) active = null;
      setTimeout(() => { if (err && this.onerror) this.onerror({ error: err }); if (this.onend) this.onend(); }, 0);
    }
    _emit(changed) { if (this.onresult) this.onresult({ resultIndex: changed, results: this._r.map(x => result(x.t, x.f)) }); }
    _partial(t) {
      const last = this._r[this._r.length - 1];
      if (last && !last.f) last.t = t; else this._r.push({ t, f: false });
      this._emit(this._r.length - 1);
    }
    _final(t) {
      const last = this._r[this._r.length - 1];
      if (last && !last.f) { last.t = t; last.f = true; } else this._r.push({ t, f: true });
      this._emit(this._r.length - 1);
    }
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = NativeRecognition;

  // ---------- text to speech ----------
  const pending = new Map(); let nextId = 1;
  class Utterance { constructor(text) { this.text = text || ''; this.lang = 'ar-SA'; this.rate = 1; this.voice = null; } }
  const listeners = {};
  const synth = {
    speaking: false, pending: false,
    speak(u) {
      const id = String(nextId++); pending.set(id, u);
      synth.speaking = true;
      if (!N.speak(u.text, +u.rate || 1, id)) setTimeout(() => done(id, 'error'), 0);
    },
    cancel() { N.stopSpeaking(); for (const id of [...pending.keys()]) done(id, 'error'); },
    getVoices() {
      if (N.hasArabicVoice()) return [{ lang: 'ar-SA', name: 'Android Arabic', default: true, localService: true, voiceURI: 'android-ar' }];
      return N.ttsReady() ? [{ lang: 'en', name: 'Android (no Arabic)', default: true, localService: true, voiceURI: 'android' }] : [];   // app.js warns
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
  };
  function done(id, kind) {
    const u = pending.get(id); if (!u) return;
    pending.delete(id); synth.speaking = pending.size > 0;
    const fn = kind === 'error' ? u.onerror : u.onend; if (fn) fn({});
  }
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = Utterance;

  // ---------- events from Android ----------
  window.__tasmiNative = {
    onEvent(ev) {
      switch (ev.type) {
        case 'partial': if (active) active._partial(ev.text); break;
        case 'final': if (active) active._final(ev.text); break;
        case 'error': if (active) { const a = active; a._end(ev.error); } break;   // the session is over (app.js restarts it or gives up)
        case 'end': if (active) active._end(null); break;
        case 'ttsDone': done(ev.id, 'end'); break;
        case 'ttsError': done(ev.id, 'error'); break;
        case 'voices': (listeners.voiceschanged || []).forEach(fn => fn()); break;
        case 'refused': if (window.__tasmiRefused) window.__tasmiRefused(); break;   // the mic was refused while the dialog hid the page
      }
    },
  };
  // copy the troubleshooting log through Android (the clipboard API may be missing in the app)
  window.__tasmiCopy = text => { try { return N.copy(text); } catch (e) { return false; } };
})();
