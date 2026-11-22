// Simulation of how Chrome's recogniser really behaves while someone recites a whole passage: words arrive one by one,
// short pauses between phrases, a long silence ends the session, every start() beeps on Android, and Android repeats
// earlier words in later results. node --test test/sim.test.js
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = (() => { for (const m of [process.env.PLAYWRIGHT, 'playwright', '/opt/npm-tools/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { if (!m) continue; try { return require(m); } catch (e) {} } throw new Error('Playwright not found: set PLAYWRIGHT'); })();
const { start } = require('./server');

let srv, browser, base;
test.before(async () => {
  srv = await start(0); base = `http://127.0.0.1:${srv.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME || (require('fs').existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined), args: ['--no-sandbox'] });
});
test.after(async () => { await browser?.close(); srv?.close(); });

// one microphone, one speaker; a recogniser session hears it only while it is running
const SIM = flavour => {
  const T = { word: 60, endpoint: 350, silence: 2500 };    // ms: between words, pause that ends a phrase, silence that ends a session
  const sim = window.__sim = { starts: 0, flavour, sessions: [], heardWhileOff: 0, T };
  let active = null;
  class FakeSR {
    constructor() { this.continuous = false; this.interimResults = false; this.lang = ''; }
    start() {
      if (active) throw Object.assign(new Error('already started'), { name: 'InvalidStateError' });
      sim.starts++; active = this; this.res = []; this.cur = null; this.quietSince = Date.now(); this.alive = true;
      sim.sessions.push({ continuous: this.continuous });
      this.tick = setInterval(() => {          // ends the session after silence (and after one phrase if not continuous)
        if (!this.alive || this.cur) return;
        if (Date.now() - this.quietSince > T.silence) this._end(this.res.length ? null : 'no-speech');
      }, 50);
    }
    stop() { this._end(null); }
    abort() { this._end('aborted'); }
    _end(err) {
      if (!this.alive) return; this.alive = false; clearInterval(this.tick);
      if (active === this) active = null;
      setTimeout(() => { if (err) this.onerror && this.onerror({ error: err }); this.onend && this.onend(); }, 0);
    }
    _emit() {
      const list = this.res.map(r => Object.assign([{ transcript: r.t, confidence: r.f ? 0.9 : 0 }], { isFinal: r.f }));
      this.onresult && this.onresult({ resultIndex: Math.max(0, this.res.findIndex(r => !r.f)), results: list });
    }
    word(w) {                                    // the reciter says one word
      this.quietSince = Date.now();
      if (!this.cur) { this.cur = { t: '', f: false }; this.res.push(this.cur); }
      this.cur.t = (this.cur.t + ' ' + w).trim();
      if (flavour === 'android' && this.res.length > 1) {   // Android: a later result repeats the earlier finals
        this.cur.shown = this.res.slice(0, -1).map(r => r.own || r.t).join(' ') + ' ' + this.cur.t;
      }
      this._emitCur();
    }
    _emitCur() {
      if (flavour === 'android' && this.cur.shown) { const own = this.cur.t; this.cur.own = own; this.cur.t = this.cur.shown; this._emit(); this.cur.t = own; }
      else this._emit();
    }
    pause() {                                    // a short pause: the phrase becomes final
      if (!this.cur) return;
      this.cur.f = true;
      if (flavour === 'android' && this.cur.shown) { this.cur.own = this.cur.t; this.cur.t = this.cur.shown; }
      this._emit(); this.cur = null; this.quietSince = Date.now();
      if (!this.continuous) this._end(null);    // one phrase per session
    }
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
  window.__spoken = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  /** the reciter recites phrases (arrays of words) with natural pauses, whatever the app is doing */
  window.reciteAll = async phrases => {
    for (const ph of phrases) {
      for (const w of ph) { if (active) active.word(w); else sim.heardWhileOff++; await wait(T.word); }
      await wait(T.endpoint); if (active) active.pause();
      await wait(150);
      // after a correction the reciter waits for the app to listen again
      for (let i = 0; i < 100 && !active; i++) await wait(20);
    }
    await wait(300);
  };
};

async function open(flavour, set) {
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e))); page.errs = errs;
  await page.addInitScript(() => { try { if (!sessionStorage.__cleared) { localStorage.clear(); sessionStorage.__cleared = 1; } } catch (e) {} });
  await page.addInitScript(SIM, flavour);
  await page.goto(base + '/site/index.html?test=1&quiet=8000');
  await page.waitForFunction(() => window.__app && window.__app.passage.length > 0);
  await page.evaluate(async set => {
    for (const [k, v] of Object.entries(set)) document.getElementById(k).value = v;
    document.getElementById('unit').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    // phrases of an ayah split at about 6 words, as a reciter breathes
    window.phrasesOf = (a, b) => {
      const out = []; let cur = [], ai = null;
      for (let i = a; i < b; i++) {
        const [x, k] = __app.passage[i];
        if (ai !== null && (x !== ai || cur.length >= 6)) { out.push(cur); cur = []; }
        ai = x; cur.push(...[].concat(__app.S[x].i[k]));
      }
      if (cur.length) out.push(cur);
      return out;
    };
  }, set);
  await page.click('#mainBtn');
  return page;
}
const result = p => p.evaluate(() => ({ starts: __sim.starts, lost: __sim.heardWhileOff, pos: __app.pos, n: __app.passage.length,
  st: __app.W.map(w => w.st), spoken: [...__spoken], listening: __app.listening, mistakes: +document.querySelector('#stats').textContent.match(/Mistakes (\d+)/)[1] }));

for (const flavour of ['desktop', 'android']) {
  test(`${flavour}: a whole page recited with pauses → one microphone session, no beeps between phrases, all green`, async () => {
    const p = await open(flavour, { unit: 'page', page: 3 });
    await p.evaluate(async () => { await reciteAll(phrasesOf(0, __app.passage.length)); });
    const r = await result(p);
    assert.deepStrictEqual(p.errs, []);
    assert.deepStrictEqual(r.spoken, [], 'no false stops');
    assert.strictEqual(r.pos, r.n, 'reached the end');
    assert.ok(r.st.every(x => x === 'ok'), JSON.stringify(r.st));
    assert.strictEqual(r.lost, 0, 'no words said while the mic was off');
    assert.strictEqual(r.starts, 1, 'the microphone was started once (each start beeps on Android)');
    await p.close();
  });

  test(`${flavour}: a mistake is corrected once, stays counted, and is not erased by later recitation`, async () => {
    const p = await open(flavour, { unit: 'range', surah: 2, from: 2, to: 5 });
    const r0 = await p.evaluate(async () => {
      const ph = phrasesOf(0, __app.passage.length), bad = ph.map(x => [...x]);
      bad[0][3] = 'شك';                                     // ذلك الكتاب لا شك …
      await reciteAll([bad[0]]);
      const afterStop = { pos: __app.pos, spoken: __spoken.length };
      // the reciter restarts the ayah from its beginning, then carries on to the end
      await reciteAll(ph);
      return afterStop;
    });
    const r = await result(p);
    assert.deepStrictEqual(r0, { pos: 3, spoken: 1 });
    assert.strictEqual(r.spoken.length, 1, 'only one correction');
    assert.strictEqual(r.st[3], 'fixed');
    assert.strictEqual(r.mistakes, 1, 'the mistake still counts after it was fixed');
    assert.strictEqual(r.pos, r.n);
    assert.ok(r.starts <= 2, 'one restart after the spoken correction, not one per phrase: ' + r.starts);
    await p.close();
  });

  test(`${flavour}: going back over earlier words never moves progress back or re-judges them`, async () => {
    const p = await open(flavour, { unit: 'range', surah: 2, from: 2, to: 5 });
    await p.evaluate(async () => {
      const ph = phrasesOf(0, __app.passage.length);
      await reciteAll(ph.slice(0, 3));
      window.__mid = __app.pos;
      const again = [...ph[1]]; again[1] = 'شك';            // repeats an earlier phrase, with a slip, then carries on
      await reciteAll([again, ...ph.slice(3)]);
    });
    const r = await result(p);
    assert.strictEqual(r.spoken.length, 0, 'no stop on a word already passed');
    assert.strictEqual(r.pos, r.n);
    await p.close();
  });

  test(`${flavour}: sitting quietly does not keep beeping — it pauses after a while`, async () => {
    const p = await open(flavour, { unit: 'range', surah: 112, from: 1, to: 4 });
    await p.evaluate(() => new Promise(r => setTimeout(r, 12000)));
    const r = await result(p);
    const note = await p.evaluate(() => document.getElementById('note').textContent);
    assert.ok(r.starts <= 4, 'restarts while quiet: ' + r.starts);
    assert.strictEqual(r.listening, false);
    assert.match(note, /quiet/i);
    await p.close();
  });
}

test('android: a long messy session (mistakes, restarted ayat) — progress and mistakes are never lost', async () => {
  const p = await open('android', { unit: 'range', surah: 2, from: 255, to: 260 });
  const r = await p.evaluate(async () => {
    const trace = []; const iv = setInterval(() => trace.push([__app.pos, +document.querySelector('#stats').textContent.match(/Mistakes (\d+)/)[1]]), 50);
    const ph = phrasesOf(0, __app.passage.length);
    let made = 0;
    for (let i = 0; i < ph.length; i++) {
      if (i % 4 === 2 && ph[i].length > 4) {                    // a slip in every 4th phrase…
        const bad = [...ph[i]]; bad[2] = 'السماوات'; if (bad[2] === ph[i][2]) bad[2] = 'الكتاب';
        const before = __spoken.length;
        await reciteAll([bad]);
        if (__spoken.length > before) made++;
        await reciteAll([ph[i - 1].slice(-2).concat(ph[i])]);  // …then go back a little and recite it right
      } else await reciteAll([ph[i]]);
    }
    clearInterval(iv);
    return { trace, made, spoken: __spoken.length, pos: __app.pos, n: __app.passage.length, starts: __sim.starts,
      fixed: __app.W.filter(w => w.st === 'fixed').length, wrong: __app.W.filter(w => w.st === 'wr' || w.st === 'ms').length };
  });
  for (let i = 1; i < r.trace.length; i++) {
    assert.ok(r.trace[i][0] >= r.trace[i - 1][0], `progress went back: ${r.trace[i - 1][0]} → ${r.trace[i][0]}`);
    assert.ok(r.trace[i][1] >= r.trace[i - 1][1], `a mistake disappeared: ${r.trace[i - 1][1]} → ${r.trace[i][1]}`);
  }
  assert.ok(r.made >= 3, 'mistakes were caught: ' + r.made);
  assert.strictEqual(r.spoken, r.made, 'each mistake corrected once, no false stops');
  assert.strictEqual(r.fixed, r.made);
  assert.strictEqual(r.wrong, 0);
  assert.strictEqual(r.pos, r.n);
  assert.ok(r.starts <= 1 + r.made, `mic starts ${r.starts} for ${r.made} corrections`);
  await p.close();
});

// ---------- inside the Android app: native.js turns Android's recogniser and voice into the browser APIs ----------
const NATIVE = () => {
  const ev = e => setTimeout(() => window.__tasmiNative && window.__tasmiNative.onEvent(e), 0);
  const n = window.__native = { starts: 0, stops: 0, spoken: [], on: false };
  window.TasmiNative = {
    startListening() { n.starts++; n.on = true; },
    stopListening() { n.stops++; n.on = false; },
    speak(text, rate, id) { n.spoken.push(text); setTimeout(() => ev({ type: 'ttsDone', id }), 50); return true; },
    stopSpeaking() {}, hasArabicVoice() { return true; }, copy() { return true; },
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  /** Android: partial results word by word, a final at each pause; the app's Listener restarts by itself in between */
  window.nativeRecite = async phrases => {
    for (const ph of phrases) {
      for (let i = 0; i < 100 && !n.on; i++) await wait(20);
      for (let i = 1; i <= ph.length; i++) { if (n.on) ev({ type: 'partial', text: ph.slice(0, i).join(' ') }); await wait(40); }
      if (n.on) ev({ type: 'final', text: ph.join(' ') });
      await wait(200);
    }
    await wait(300);
  };
  window.nativeEvent = ev;
};
async function openNative(set) {
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e))); page.errs = errs;
  await page.addInitScript(() => { try { if (!sessionStorage.__cleared) { localStorage.clear(); sessionStorage.__cleared = 1; } } catch (e) {} });
  await page.addInitScript(NATIVE);
  await page.goto(base + '/site/index.html?test=1&quiet=8000');
  await page.waitForFunction(() => window.__app && window.__app.passage.length > 0);
  await page.evaluate(async set => {
    for (const [k, v] of Object.entries(set)) document.getElementById(k).value = v;
    document.getElementById('unit').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    window.phrasesOf = (a, b) => { const out = []; let cur = [], ai = null;
      for (let i = a; i < b; i++) { const [x, k] = __app.passage[i]; if (ai !== null && (x !== ai || cur.length >= 6)) { out.push(cur); cur = []; } ai = x; cur.push(...[].concat(__app.S[x].i[k])); }
      if (cur.length) out.push(cur); return out; };
  }, set);
  await page.click('#mainBtn');
  return page;
}

test('Android app: a page with a mistake — listening starts once, the word is said by Android, mistake kept', async () => {
  const p = await openNative({ unit: 'range', surah: 2, from: 2, to: 5 });
  const r = await p.evaluate(async () => {
    delete window.__spoken;                                   // use the real say() path through native.js
    const ph = phrasesOf(0, __app.passage.length), bad = ph.map(x => [...x]); bad[0][3] = 'شك';
    await nativeRecite([bad[0]]);
    await new Promise(r => setTimeout(r, 1200));
    await nativeRecite(ph);
    return { starts: __native.starts, spoken: __native.spoken, pos: __app.pos, n: __app.passage.length, st3: __app.W[3].st,
      native: document.documentElement.classList.contains('native') };
  });
  assert.deepStrictEqual(p.errs, []);
  assert.strictEqual(r.native, true);
  assert.strictEqual(r.spoken.length, 1);
  assert.match(r.spoken[0].replace(/[ً-ْ]/g, ''), /ريب/);
  assert.strictEqual(r.st3, 'fixed');
  assert.strictEqual(r.pos, r.n);
  assert.strictEqual(r.starts, 2, 'started once, and once more after saying the word');
  await p.close();
});

test('Android app: Android ends the session after a long quiet → the page pauses with a message', async () => {
  const p = await openNative({ unit: 'range', surah: 112, from: 1, to: 4 });
  const r = await p.evaluate(async () => {
    await new Promise(r => setTimeout(r, 9000));
    nativeEvent({ type: 'error', error: 'no-speech' });
    await new Promise(r => setTimeout(r, 300));
    return { listening: __app.listening, note: document.getElementById('note').textContent, starts: __native.starts };
  });
  assert.strictEqual(r.listening, false);
  assert.match(r.note, /quiet/);
  assert.strictEqual(r.starts, 1);
  await p.close();
});

test('Android app: microphone permission refused → message, no retry loop', async () => {
  const p = await openNative({ unit: 'range', surah: 112, from: 1, to: 4 });
  const r = await p.evaluate(async () => {
    nativeEvent({ type: 'error', error: 'not-allowed' });
    await new Promise(r => setTimeout(r, 500));
    return { listening: __app.listening, note: document.getElementById('note').textContent, starts: __native.starts };
  });
  assert.deepStrictEqual([r.listening, r.starts], [false, 1]);
  assert.match(r.note, /microphone/i);
  await p.close();
});
