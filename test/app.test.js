// App tests in headless Chrome with a fake speech recogniser that behaves like Chrome's (interim words, then a final
// phrase, then the recogniser ends and is restarted). node --test test/app.test.js
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

const FAKE_SR = () => {
  class FakeSR {
    constructor() { this.lang = ''; }
    start() { window.__sr = this; window.__srStarts = (window.__srStarts || 0) + 1; }
    stop() { this.abort(); }
    abort() { if (window.__sr === this) window.__sr = null; setTimeout(() => this.onend && this.onend(), 0); }
    emit(text, final) {
      this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: final })] });
      if (final) { if (window.__sr === this) window.__sr = null; setTimeout(() => this.onend && this.onend(), 0); }
    }
    /** the session ends with no final result (Android does this), optionally after an error */
    end(error) {
      if (window.__sr === this) window.__sr = null;
      if (error) this.onerror && this.onerror({ error });
      setTimeout(() => this.onend && this.onend(), 0);
    }
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
  window.__spoken = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ready = async () => { for (let i = 0; i < 200 && !window.__sr; i++) await wait(10); return window.__sr; };
  /** the reciter says a phrase: words arrive one by one (interim), then the whole phrase as final */
  window.recite = async (text, { final = true } = {}) => {
    const sr = await ready(); if (!sr) throw new Error('not listening');
    const w = text.trim().split(/\s+/);
    for (let i = 1; i <= w.length; i++) { if (window.__sr !== sr) return 'stopped'; sr.emit(w.slice(0, i).join(' '), false); await wait(5); }
    if (window.__sr !== sr) return 'stopped';
    if (final) sr.emit(text, true);
    await wait(120);
    return 'done';
  };
};

async function open(set) {
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e))); page.errs = errs;
  await page.addInitScript(() => { try { if (!sessionStorage.__cleared) { localStorage.clear(); sessionStorage.__cleared = 1; } } catch (e) {} });
  await page.addInitScript(FAKE_SR);
  await page.goto(base + '/site/index.html?test=1');
  await page.waitForFunction(() => window.__app && window.__app.passage.length > 0);
  if (set) await choose(page, set);
  await page.evaluate(() => {
    window.sp = (a, b) => __app.passage.slice(a, b).flatMap(([ai, k]) => [].concat(__app.S[ai].i[k])).join(' ');
    window.wi = (sn, an, k = 0) => __app.passage.findIndex(([ai, w]) => __app.S[ai].sn === sn && __app.S[ai].an === an && w === k);
  });
  return page;
}
async function choose(page, set) {
  await page.evaluate(async set => {
    for (const [k, v] of Object.entries(set)) document.getElementById(k).value = v;
    document.getElementById('unit').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
  }, set);
  return page.evaluate(() => ({ desc: document.getElementById('unitDesc').textContent, first: [__app.S[0].sn, __app.S[0].an],
    last: [__app.S.at(-1).sn, __app.S.at(-1).an], headers: [...document.querySelectorAll('#mushaf .sh')].map(h => h.textContent) }));
}
const startTasmi = page => page.click('#mainBtn');
const state = page => page.evaluate(() => ({ pos: __app.pos, st: __app.W.map(w => w.st), spoken: [...__spoken], stop: __app.stop && __app.stop.i,
  listening: __app.listening, card: document.getElementById('stopCard').className }));
const strip = s => s.replace(/[ً-ْۡ]/g, '');

test('perfect recitation of al-Ikhlas: all green, never stopped', async () => {
  const p = await open({ unit: 'range', surah: 112, from: 1, to: 4 });
  await startTasmi(p);
  await p.evaluate(async () => { for (const an of [1, 2, 3, 4]) await recite(sp(wi(112, an), an < 4 ? wi(112, an + 1) : __app.passage.length)); });
  const s = await state(p);
  assert.deepStrictEqual(p.errs, []);
  assert.strictEqual(s.pos, s.st.length);
  assert.ok(s.st.every(x => x === 'ok'), JSON.stringify(s.st));
  assert.deepStrictEqual(s.spoken, []);
  await p.close();
});

test('THE BUG: a wrong word mid-ayah stops right there, while still reciting — no jump back to the ayah start', async () => {
  const p = await open({ unit: 'page', page: 2 });
  await startTasmi(p);
  const r = await p.evaluate(async () => {
    await recite(sp(0, 1));                                                // الم
    const s = wi(2, 2), e = wi(2, 3), w = sp(s, e).split(' '); w[3] = 'شك';  // لا شك فيه instead of لا ريب فيه
    await recite(w.join(' ') + ' ' + sp(e, e + 3), { final: false });
    await new Promise(r => setTimeout(r, 1000));            // the wrong word held (Chrome did not rewrite it)
    return { s, stoppedBeforeFinal: __app.stop != null && __spoken.length === 1 };
  });
  const s1 = await state(p);
  assert.strictEqual(r.stoppedBeforeFinal, true, 'stopped before the phrase ended');
  assert.strictEqual(s1.stop, r.s + 3);
  assert.strictEqual(s1.pos, r.s + 3, 'continues from the wrong word');
  assert.strictEqual(s1.st[r.s + 3], 'wr');
  assert.ok(s1.st.slice(r.s, r.s + 3).every(x => x === 'ok'));
  assert.strictEqual(s1.spoken.length, 1);
  assert.strictEqual(strip(s1.spoken[0]), 'ريب');
  // listening resumes by itself; the reciter carries on from the corrected word
  await p.evaluate(async r => { await recite(sp(r.s + 3, wi(2, 3))); }, r);
  const s2 = await state(p);
  assert.strictEqual(s2.listening, true, 'listening again on its own');
  assert.strictEqual(s2.st[r.s + 3], 'fixed');
  assert.strictEqual(s2.spoken.length, 1, 'no second stop');
  assert.strictEqual(s2.card, '');
  await p.close();
});

test('after a correction, starting the ayah again from the beginning is fine', async () => {
  const p = await open({ unit: 'page', page: 2 });
  await startTasmi(p);
  const r = await p.evaluate(async () => {
    await recite(sp(0, wi(2, 4)));
    const s = wi(2, 4), e = wi(2, 5), w = sp(s, e).split(' '); w.splice(5, 1);    // skipped the 6th word of ayah 4
    await recite(w.join(' '));
    const afterStop = __app.pos;
    await recite(sp(s, e));                                                         // starts ayah 4 again, correctly
    return { s, e, afterStop };
  });
  const st = await state(p);
  assert.strictEqual(r.afterStop, r.s + 5);
  assert.strictEqual(st.pos, r.e);
  assert.strictEqual(st.st[r.s + 5], 'fixed');
  assert.strictEqual(st.spoken.length, 1);
  await p.close();
});

test('a late result from before the stop is ignored', async () => {
  const p = await open({ unit: 'range', surah: 67, from: 1, to: 2 });
  await startTasmi(p);
  const before = await p.evaluate(async () => {
    const w = sp(0, 8).split(' '); w[2] = 'الذين';
    const old = window.__sr;
    await recite(w.join(' '), { final: false });
    await new Promise(r => setTimeout(r, 1000));
    const pos = __app.pos;
    old.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: sp(0, 12) }], { isFinal: true })] });   // stale
    await new Promise(r => setTimeout(r, 100));
    return { pos, after: __app.pos };
  });
  assert.strictEqual(before.after, before.pos);
  await p.close();
});

test("isti'adha and basmala are ignored; a page crossing three surahs is recited without stops", async () => {
  const p = await open({ unit: 'page', page: 604 });
  await startTasmi(p);
  await p.evaluate(async () => {
    await recite('أعوذ بالله من الشيطان الرجيم بسم الله الرحمن الرحيم');
    const b113 = wi(113, 1), b114 = wi(114, 1), n = __app.passage.length;
    await recite(sp(0, b113)); await recite('بسم الله الرحمن الرحيم');
    await recite(sp(b113, b114)); await recite('بسم الله الرحمن الرحيم');
    await recite(sp(b114, n)); await recite('صدق الله العظيم');
  });
  const s = await state(p);
  assert.strictEqual(s.spoken.length, 0);
  assert.strictEqual(s.pos, s.st.length);
  assert.ok(s.st.every(x => x === 'ok'));
  await p.close();
});

test('words light up while being recited (before the phrase is final)', async () => {
  const p = await open({ unit: 'range', surah: 1, from: 1, to: 7 });
  await startTasmi(p);
  await p.evaluate(async () => { const sr = await (async () => { for (let i = 0; i < 100 && !window.__sr; i++) await new Promise(r => setTimeout(r, 10)); return window.__sr; })(); sr.emit(sp(0, 6), false); });
  await p.waitForTimeout(50);
  const live = await p.evaluate(() => [...document.querySelectorAll('#mushaf .w.live')].length);
  assert.strictEqual(live, 6);
  await p.close();
});

test('"I said it right" clears the mistake', async () => {
  const p = await open({ unit: 'range', surah: 112, from: 1, to: 4 });
  await startTasmi(p);
  await p.evaluate(async () => { const w = sp(0, 4).split(' '); w[3] = 'واحد'; await recite(w.join(' ')); document.getElementById('scRight').click(); });
  const s = await state(p);
  assert.strictEqual(s.st[3], 'ok');
  assert.strictEqual(s.pos, 4);
  await p.close();
});

test('finish shows a summary with what to revise', async () => {
  const p = await open({ unit: 'range', surah: 112, from: 1, to: 4 });
  await startTasmi(p);
  const txt = await p.evaluate(async () => {
    await recite(sp(0, 4));
    const w = sp(4, 6).split(' '); w[1] = 'الكريم'; await recite(w.join(' '));
    await recite(sp(5, 6));
    document.getElementById('doneBtn').click();
    return document.getElementById('sumDlg').textContent;
  });
  assert.match(txt, /Mistakes/); assert.match(txt, /Revise/); assert.match(txt, /112:2/);
  await p.close();
});

// ---------- choosing safha / ruba / nisf / para / ayah (Madani 604-page mushaf) ----------
test('safha 2 = 2:1–2:5; safha 604 = surahs 112–114 with surah headers', async () => {
  const p = await open();
  let r = await choose(p, { unit: 'page', page: 2 });
  assert.deepStrictEqual([r.first, r.last], [[2, 1], [2, 5]]);
  r = await choose(p, { unit: 'page', page: 604 });
  assert.deepStrictEqual([r.first, r.last], [[112, 1], [114, 6]]);
  assert.strictEqual(r.headers.length, 3);
  await p.close();
});
test('ruba 2 of para 1 = 2:44–2:74; para 2 starts at 2:142; nisf 2 of para 30 ends at 114:6', async () => {
  const p = await open();
  assert.deepStrictEqual(Object.values(await choose(p, { unit: 'ruba', para: 1, ruba: 2 })).slice(1, 3), [[2, 44], [2, 74]]);
  assert.deepStrictEqual((await choose(p, { unit: 'juz', para: 2 })).first, [2, 142]);
  assert.deepStrictEqual((await choose(p, { unit: 'nisf', para: 30, nisf: 2 })).last, [114, 6]);
  await p.close();
});
test('one ayah, and Next / Previous through ayat, pages and ruba', async () => {
  const p = await open();
  await choose(p, { unit: 'ayah', surah: 2, ayah: 255 });
  await p.click('#nextU'); await p.waitForTimeout(300);
  assert.deepStrictEqual(await p.evaluate(() => [__app.S[0].sn, __app.S[0].an]), [2, 256]);
  await choose(p, { unit: 'ruba', para: 1, ruba: 4 });
  await p.click('#nextU'); await p.waitForTimeout(300);
  assert.deepStrictEqual(await p.evaluate(() => [para.value, ruba.value]), ['2', '1']);
  await p.click('#prevU'); await p.waitForTimeout(300);
  assert.deepStrictEqual(await p.evaluate(() => [para.value, ruba.value]), ['1', '4']);
  await p.close();
});
test('the chosen part is remembered after a reload', async () => {
  const p = await open();
  await choose(p, { unit: 'page', page: 77 });
  await p.reload(); await p.waitForFunction(() => window.__app && window.__app.passage.length > 0); await p.waitForTimeout(300);
  assert.deepStrictEqual(await p.evaluate(() => [unit.value, page.value]), ['page', '77']);
  assert.match(await p.evaluate(() => unitDesc.textContent), /Safha 77/);
  await p.close();
});
test('basmala in the same breath as the start of the next surah: no stop', async () => {
  const p = await open({ unit: 'page', page: 604 });
  await startTasmi(p);
  await p.evaluate(async () => {
    const b113 = wi(113, 1), b114 = wi(114, 1);
    await recite(sp(0, b113));
    await recite('بسم الله الرحمن الرحيم ' + sp(b113, b114));
  });
  const s = await state(p);
  assert.strictEqual(s.spoken.length, 0);
  assert.strictEqual(s.pos, await p.evaluate(() => wi(114, 1)));
  await p.close();
});
test('al-Fatiha: the basmala is ayah 1 there and is checked, not ignored', async () => {
  const p = await open({ unit: 'range', surah: 1, from: 1, to: 7 });
  await startTasmi(p);
  await p.evaluate(async () => { await recite('بسم الله الرحمن الرحيم'); await recite(sp(4, 8)); });
  const s = await state(p);
  assert.ok(s.st.slice(0, 8).every(x => x === 'ok'), JSON.stringify(s.st.slice(0, 8)));
  assert.strictEqual(s.pos, 8);
  await p.close();
});

// ---------- resilience: what real recognisers and phones do ----------
test('a phrase that ends without a final result (Android) is still judged — no false "skipped" stop', async () => {
  const p = await open({ unit: 'range', surah: 112, from: 1, to: 4 });
  await startTasmi(p);
  const r = await p.evaluate(async () => {
    await recite(sp(0, 4), { final: false }); window.__sr.end();          // ayah 1 heard only as interim, then the session ended
    await new Promise(r => setTimeout(r, 150));
    const after1 = __app.pos;
    await recite(sp(4, 6));
    return { after1, pos: __app.pos };
  });
  const s = await state(p);
  assert.strictEqual(r.after1, 4);
  assert.strictEqual(r.pos, 6);
  assert.deepStrictEqual(s.spoken, []);
  await p.close();
});
test('the same final result delivered twice is judged once', async () => {
  const p = await open({ unit: 'range', surah: 112, from: 1, to: 4 });
  await startTasmi(p);
  const pos = await p.evaluate(async () => {
    const sr = await (async () => { for (let i = 0; i < 100 && !window.__sr; i++) await new Promise(r => setTimeout(r, 10)); return window.__sr; })();
    sr.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: sp(0, 4) }], { isFinal: true })] });
    sr.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: sp(0, 4) }], { isFinal: true })] });
    sr.end(); await new Promise(r => setTimeout(r, 150));
    return __app.pos;
  });
  assert.strictEqual(pos, 4);
  assert.strictEqual(await p.evaluate(() => __log.length), 1);
  await p.close();
});
test('silence (no-speech) keeps listening; repeated network errors back off, then stop with a message', async () => {
  const p = await open({ unit: 'range', surah: 112, from: 1, to: 4 });
  await startTasmi(p);
  const r = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const next = async () => { for (let i = 0; i < 600 && !window.__sr; i++) await wait(10); return window.__sr; };
    for (let i = 0; i < 3; i++) { (await next()).end('no-speech'); await wait(20); }
    const afterSilence = __app.listening;
    for (let i = 0; i < 3; i++) { (await next()).end('network'); await wait(5); }
    const retryNote = document.getElementById('note').textContent;
    await recite(sp(0, 4));                                                  // the connection came back
    const recovered = { note: document.getElementById('note').textContent, pos: __app.pos };
    const startsBefore = window.__srStarts;
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) { const sr = await next(); if (!sr) break; sr.end('network'); await wait(5); }
    await wait(100);
    return { afterSilence, retryNote, recovered, starts: window.__srStarts - startsBefore, ms: Date.now() - t0, listening: __app.listening,
      note: document.getElementById('note').textContent, btn: document.getElementById('mainTxt').textContent };
  });
  assert.strictEqual(r.afterSilence, true);
  assert.match(r.retryNote, /Trying again/);
  assert.deepStrictEqual(r.recovered, { note: '', pos: 4 });
  assert.ok(r.ms > 2000, 'backed off between retries: ' + r.ms);
  assert.strictEqual(r.listening, false);
  assert.match(r.note, /internet/);
  assert.match(r.btn, /Start|Continue/);
  await p.close();
});
test('microphone blocked → stops at once with a message', async () => {
  const p = await open({ unit: 'range', surah: 112, from: 1, to: 4 });
  await startTasmi(p);
  const r = await p.evaluate(async () => {
    for (let i = 0; i < 100 && !window.__sr; i++) await new Promise(r => setTimeout(r, 10));
    const n = window.__srStarts; window.__sr.end('not-allowed'); await new Promise(r => setTimeout(r, 300));
    return { more: window.__srStarts - n, listening: __app.listening, note: document.getElementById('note').textContent };
  });
  assert.deepStrictEqual([r.more, r.listening], [0, false]);
  assert.match(r.note, /blocked the microphone/);
  await p.close();
});
test('stopping while the right word is being said does not switch the mic back on', async () => {
  const p = await open({ unit: 'range', surah: 112, from: 1, to: 4 });
  await startTasmi(p);
  const r = await p.evaluate(async () => {
    const w = sp(0, 4).split(' '); w[3] = 'الكريم';
    const sr = await (async () => { for (let i = 0; i < 100 && !window.__sr; i++) await new Promise(r => setTimeout(r, 10)); return window.__sr; })();
    await new Promise(r => setTimeout(r, 400));       // (not a double tap)
    sr.emit(w.join(' '), true);                       // mistake → the app stops the mic to say the word
    document.getElementById('mainBtn').click();       // …and the reciter taps Stop meanwhile
    await new Promise(r => setTimeout(r, 300));
    return { listening: __app.listening, sr: !!window.__sr, spoken: __spoken.length };
  });
  assert.deepStrictEqual(r, { listening: false, sr: false, spoken: 1 });
  await p.close();
});
test('screen off / tab hidden: listening pauses and carries on when the page is back', async () => {
  const p = await open({ unit: 'range', surah: 112, from: 1, to: 4 });
  await startTasmi(p);
  const r = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    let vis = 'visible'; Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
    await wait(50);
    vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); await wait(100);
    const hidden = { listening: __app.listening, sr: !!window.__sr };
    vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); await wait(100);
    await recite(sp(0, 4));
    return { hidden, listening: __app.listening, pos: __app.pos };
  });
  assert.deepStrictEqual(r, { hidden: { listening: false, sr: false }, listening: true, pos: 4 });
  await p.close();
});
test('a surah that fails to load shows a message instead of breaking', async () => {
  const p = await open({ unit: 'range', surah: 112, from: 1, to: 4 });
  await p.route('**/words/113.json*', r => r.abort());
  const r = await p.evaluate(async () => {
    const s = document.getElementById('surah'); s.value = 113; s.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 3500));
    return { note: document.getElementById('note').textContent, sn: __app.S[0].sn, desc: document.getElementById('unitDesc').textContent };
  });
  assert.match(r.note, /Could not load/);
  assert.match(r.desc, /112:1/, 'the label still names the passage on screen');
  assert.strictEqual(r.sn, 112, 'the old passage is still usable');
  assert.deepStrictEqual(p.errs, []);
  await p.close();
});

test('a wrong interim guess that Chrome rewrites a moment later is not a mistake', async () => {
  const p = await open({ unit: 'range', surah: 67, from: 1, to: 2 });
  await startTasmi(p);
  const r = await p.evaluate(async () => {
    const sr = await (async () => { for (let i = 0; i < 100 && !window.__sr; i++) await new Promise(r => setTimeout(r, 10)); return window.__sr; })();
    const w = sp(0, 9).split(' '), bad = [...w]; bad[2] = 'الذين';
    for (let i = 1; i <= 9; i++) { sr.emit(bad.slice(0, i).join(' '), false); await new Promise(r => setTimeout(r, 60)); }   // wrong guess held ~0.4s
    sr.emit(w.join(' '), false); await new Promise(r => setTimeout(r, 900));                                                // …then corrected
    sr.emit(w.join(' '), true); await new Promise(r => setTimeout(r, 150));
    return { spoken: __spoken.length, pos: __app.pos };
  });
  assert.deepStrictEqual(r, { spoken: 0, pos: 9 });
  await p.close();
});
