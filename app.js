/* Tasmi AI: listens with the browser's speech recognition, matches every word against the passage, stops on a
 * wrong or skipped word and says the right one, then keeps listening on its own. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const TEST = params.has('test');
  const VER = window.TASMI_V || '';
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- state ----------
  let SURAHS = [], DIV = null, START = [], S = [], passage = [], T = [], W = [], spans = [];
  let pos = 0, mode = 'mic', listening = false, selfPtr = 0, hints = new Set(), stop = null, unitLabel = '';
  let heardFinal = '', interim = '', live = null, muted = false;
  const log = [];
  const disp = (ai, k) => S[ai].d[k];
  const wordName = i => passage[i] ? disp(passage[i][0], passage[i][1]) : '';
  const ayahRef = (sn, an) => `${sn}:${an}`;
  const refOf = i => ayahRef(S[passage[i][0]].sn, S[passage[i][0]].an);

  // ---------- what to recite: safha, ruba, nisf, para, one ayah, or an ayah range (Madani 604-page mushaf) ----------
  const idOf = (sn, an) => START[sn] + an - 1;
  function sa(id) { let s = 1; while (s < 114 && START[s + 1] <= id) s++; return [s, id - START[s] + 1]; }
  function showSel() {
    const u = $('unit').value;
    document.querySelectorAll('#sel [data-u]').forEach(l => { l.style.display = l.dataset.u.split(' ').includes(u) ? '' : 'none'; });
  }
  function clampInputs() {
    const cl = (el, lo, hi) => { el.value = Math.max(lo, Math.min(hi, Math.round(+el.value || lo))); return +el.value; };
    cl($('page'), 1, 604); cl($('para'), 1, 30);
    const n = SURAHS[+$('surah').value - 1][3];
    cl($('ayah'), 1, n); const f = cl($('from'), 1, n); $('to').value = Math.max(f, Math.min(n, +$('to').value || n));
    return $('unit').value;
  }
  function chosen() {
    const u = clampInputs(), j = +$('para').value, sn = +$('surah').value;
    if (u === 'page') return { r: DIV.page[+$('page').value - 1], label: 'Safha ' + $('page').value };
    if (u === 'juz') return { r: DIV.juz[j - 1], label: 'Para ' + j };
    if (u === 'ruba') { const q = (j - 1) * 8 + (+$('ruba').value - 1) * 2; return { r: [DIV.rub[q][0], DIV.rub[q + 1][1]], label: `Para ${j}, ruba ${$('ruba').value}` }; }
    if (u === 'nisf') { const q = (j - 1) * 8 + (+$('nisf').value - 1) * 4; return { r: [DIV.rub[q][0], DIV.rub[q + 3][1]], label: `Para ${j}, nisf ${$('nisf').value}` }; }
    if (u === 'ayah') { const id = idOf(sn, +$('ayah').value); return { r: [id, id], label: 'Ayah' }; }
    return { r: [idOf(sn, +$('from').value), idOf(sn, +$('to').value)], label: SURAHS[sn - 1][2] };
  }
  function step(d) {
    const u = $('unit').value;
    if (u === 'page') $('page').value = +$('page').value + d;
    else if (u === 'juz') $('para').value = +$('para').value + d;
    else if (u === 'ruba' || u === 'nisf') {
      const el = $(u), n = u === 'ruba' ? 4 : 2; let k = +el.value + d, j = +$('para').value;
      if (k > n) { k = 1; j++; } if (k < 1) { k = n; j--; }
      if (j >= 1 && j <= 30) { el.value = k; $('para').value = j; }
    } else {
      const cur = chosen().r, len = cur[1] - cur[0] + 1, id = d > 0 ? cur[1] + 1 : cur[0] - len;
      if (id < 1 || id > 6236) return;
      const [s2, a2] = sa(id); $('surah').value = s2;
      if (u === 'ayah') $('ayah').value = a2;
      else { $('from').value = a2; $('to').value = Math.min(SURAHS[s2 - 1][3], a2 + len - 1); }
    }
    build();
  }
  const surahCache = {};
  async function loadSurah(n) {
    if (!surahCache[n]) surahCache[n] = (await (await fetch(`words/${n}.json?v=${VER}`)).json()).map((a, i) => ({ ...a, sn: n, an: i + 1 }));
    return surahCache[n];
  }
  async function build() {
    showSel();
    const { r: [f, l], label } = chosen();
    const [s0, a0] = sa(f), [s1, a1] = sa(l);
    unitLabel = `${label} · ${SURAHS[s0 - 1][2]} ${ayahRef(s0, a0)}` + (f !== l ? ` – ${s1 !== s0 ? SURAHS[s1 - 1][2] + ' ' : ''}${ayahRef(s1, a1)}` : '');
    $('unitDesc').textContent = unitLabel;
    lsSet('tasmi.sel', { unit: $('unit').value, page: $('page').value, para: $('para').value, ruba: $('ruba').value, nisf: $('nisf').value,
      surah: $('surah').value, ayah: $('ayah').value, from: $('from').value, to: $('to').value });
    const token = (build.token = (build.token || 0) + 1);
    const ayat = [];
    for (let sn = s0; sn <= s1; sn++) {
      const data = await loadSurah(sn);
      for (let an = sn === s0 ? a0 : 1; an <= (sn === s1 ? a1 : data.length); an++) ayat.push(data[an - 1]);
    }
    if (token !== build.token) return;
    if (listening) stopListening();
    S = ayat; passage = [];
    S.forEach((a, ai) => a.d.forEach((_, k) => passage.push([ai, k])));
    T = Recite.tokens(S, passage);
    const box = $('mushaf'); box.innerHTML = ''; spans = [];
    const frag = document.createDocumentFragment();
    passage.forEach(([ai, k], i) => {
      if (k === 0 && S[ai].an === 1) { const h = document.createElement('span'); h.className = 'sh'; h.textContent = 'سورة ' + SURAHS[S[ai].sn - 1][1]; frag.appendChild(h); }
      const sp = document.createElement('span'); sp.className = 'w p'; sp.textContent = disp(ai, k); sp.dataset.i = i;
      spans.push(sp); frag.appendChild(sp); frag.appendChild(document.createTextNode(' '));
      if (k === S[ai].d.length - 1) {
        const am = document.createElement('span'); am.className = 'am'; am.textContent = S[ai].an.toLocaleString('ar-EG');
        frag.appendChild(am); frag.appendChild(document.createTextNode(' '));
      }
    });
    box.appendChild(frag);
    reset(); setMain();
  }
  function reset() {
    W = passage.map(() => ({ st: 'p', everWrong: false, heard: '' }));
    pos = 0; selfPtr = 0; hints = new Set(); heardFinal = ''; interim = ''; live = null; hideStop(); render();
  }

  // ---------- the listener: the browser's speech recognition, restarted after every phrase ----------
  function makeListener() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    let want = false, rec = null, lastErr = null, epoch = 0;
    const h = { f: [], p: [], s: [] }, emit = (k, e) => h[k].forEach(fn => fn(e));
    function open() {
      const my = ++epoch;
      rec = new SR(); rec.lang = 'ar-SA'; rec.continuous = false; rec.interimResults = true; rec.maxAlternatives = 1;
      rec.onresult = e => {
        if (my !== epoch) return;          // a phrase from before a stop: ignore
        let fin = '', par = '';
        for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) fin += t; else par += t; }
        if (fin.trim()) emit('f', fin.trim()); else emit('p', par.trim());
      };
      rec.onerror = e => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { want = false; lastErr = 'not_granted'; }
        else if (e.error === 'language-not-supported') { want = false; lastErr = 'unavailable'; }
        else if (e.error === 'network') lastErr = 'network';
      };
      rec.onend = () => {
        if (my !== epoch) return;
        rec = null;
        if (want) setTimeout(() => { if (want && !rec) { try { open(); } catch (err) { want = false; emit('s', { state: 'idle', reason: 'error' }); } } }, 60);
        else emit('s', { state: 'idle', reason: lastErr || 'stopped' });
      };
      rec.start();
    }
    return {
      start() { if (want) return; want = true; lastErr = null; open(); emit('s', { state: 'listening' }); },
      stop() { want = false; epoch++; if (rec) { try { rec.abort(); } catch (e) {} rec = null; } emit('s', { state: 'idle', reason: 'stopped' }); },
      onFinal(fn) { h.f.push(fn); }, onPartial(fn) { h.p.push(fn); }, onState(fn) { h.s.push(fn); },
    };
  }
  let L = null;
  function startListening() {
    if (!L) {
      L = makeListener();
      if (!L) { note('This browser has no speech recognition. Open the page in <b>Google Chrome</b>, or use <b>Self-check</b>.'); return; }
      L.onPartial(t => { if (!muted) { interim = t; think(false); } });
      L.onFinal(t => { if (!muted) { heardFinal += ' ' + t; interim = ''; think(true); } });
      L.onState(({ state, reason }) => {
        if (state === 'idle' && !muted) {
          listening = false;
          if (reason === 'not_granted') note('Chrome blocked the microphone. Tap the lock icon next to the address, allow Microphone, then tap Start again.');
          else if (reason === 'unavailable') note('Arabic speech recognition is not available in this browser. Use Chrome, or Self-check.');
          else if (reason === 'network') note('Speech recognition needs internet. Check your connection and tap Start.');
        }
        setMain(); status();
      });
    }
    note(''); heardFinal = ''; interim = '';
    try { L.start(); listening = true; } catch (e) { note('Could not start the microphone: ' + esc(e.message || e)); }
    setMain(); render(); status();
  }
  function stopListening() { listening = false; if (L) L.stop(); live = null; setMain(); render(); status(); }

  // ---------- each time words come in: where are we, and is anything wrong? ----------
  function think(final) {
    const said = (heardFinal + ' ' + interim).trim();
    if (!said) return;
    // basmala / isti'adha before the words are not part of the passage — except in al-Fatiha, where the basmala is ayah 1
    let fatiha = false;
    for (let i = Math.max(0, pos - 8); i <= Math.min(pos, passage.length - 1); i++) { const x = S[passage[i][0]]; if (x.sn === 1 && x.an <= 2) fatiha = true; }
    const text = fatiha ? said : Recite.withoutPreamble(said);
    if (!fatiha && (!text || Recite.isPreamble(said))) {
      if (final) { addLog({ heard: said, result: 'basmala / isti\'adha — ignored' }); heardFinal = ''; live = null; render(); }
      return;
    }
    const res = Recite.assess(T, passage, pos, text);
    const d = Recite.decide(res, passage, T, final);
    live = res && res.frontier >= res.a ? res : null;
    if (d.stop != null) return correct(res, d, text);
    if (final) {
      const entry = { heard: text, at: res ? `${res.a + 1}–${res.frontier + 1}` : '' };
      if (d.commit != null) {
        for (let i = res.a; i < d.commit; i++) mark(i, 'ok');
        pos = d.commit; entry.result = 'ok → ' + (pos < passage.length ? wordName(pos) : 'end');
        hideStop();
        if (pos >= passage.length) toastNote('MashaAllah, you reached the end. Tap <b>Finish</b> for your result, or <b>Next</b> for the next part.');
      } else { entry.result = 'did not match the passage'; if (pos > 0) toastNote(`That didn't match. Carry on from <b>${esc(wordName(pos))}</b>.`); }
      addLog(entry);
      heardFinal = ''; live = null;
    }
    render();
  }
  function mark(i, st, heard) {
    const w = W[i];
    if (st === 'ok') W[i] = { ...w, st: w.everWrong ? 'fixed' : 'ok' };
    else W[i] = { st, everWrong: true, heard: heard || w.heard };
  }

  // ---------- the muhaffiz stops you and says the right word ----------
  function correct(res, d, text) {
    for (let i = res.a; i < d.stop; i++) mark(i, 'ok');
    mark(d.stop, d.kind === 'ms' ? 'ms' : 'wr', d.heard);
    pos = d.stop; heardFinal = ''; interim = ''; live = null;
    addLog({ heard: text, at: `${res.a + 1}–${res.frontier + 1}`, result: (d.kind === 'ms' ? 'skipped ' : 'wrong ') + wordName(d.stop) + (d.heard ? ` (heard ${d.heard})` : '') });
    stop = { i: d.stop, kind: d.kind, heard: d.heard };
    $('stopCard').className = 'show';
    document.body.classList.add('stopped');
    $('scTitle').textContent = (d.kind === 'ms' ? 'You skipped' : 'Mistake') + ' · ayah ' + refOf(d.stop);
    $('scWord').textContent = wordName(d.stop);
    $('scWhy').textContent = d.kind === 'ms' ? 'This word was left out.' : d.heard ? 'You said: ' + d.heard : '';
    $('scRight').style.display = d.kind === 'ms' ? 'none' : '';
    render();
    requestAnimationFrame(() => { const sp = spans[d.stop]; if (sp) window.scrollBy({ top: sp.getBoundingClientRect().top - 120, behavior: 'smooth' }); });
    say(d.stop);
  }
  function hideStop() { $('stopCard').className = ''; document.body.classList.remove('stopped'); stop = null; }
  const speakable = t => t.replace(/[ۖ-ۭ]/g, '').replace(/ٱ/g, 'ا');
  function arabicVoice() { const v = speechSynthesis.getVoices(); return v.find(x => /^ar[-_]SA/i.test(x.lang)) || v.find(x => /^ar/i.test(x.lang)) || null; }
  /** pause listening, say the word, listen again */
  function say(i) {
    const word = speakable(wordName(i));
    const wasListening = listening;
    muted = true; if (L && wasListening) L.stop(); listening = wasListening;
    const resume = () => { muted = false; if (wasListening && mode === 'mic') { heardFinal = ''; interim = ''; L.start(); listening = true; } setMain(); status(); };
    if (TEST && window.__spoken) { window.__spoken.push(word); setTimeout(resume, 30); return; }
    if (!$('voiceOn').checked || !window.speechSynthesis) { setTimeout(resume, 700); return; }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(word); u.lang = 'ar-SA'; const v = arabicVoice(); if (v) u.voice = v; u.rate = 0.8;
      let done = false; const fin = () => { if (!done) { done = true; setTimeout(resume, 250); } };
      u.onend = fin; u.onerror = fin; setTimeout(fin, 5000);
      speechSynthesis.speak(u);
    } catch (e) { resume(); }
  }

  // ---------- rendering ----------
  function render() {
    let ok = 0, wrong = 0, fixed = 0;
    const reach = mode === 'self' ? selfPtr : pos;
    for (let i = 0; i < W.length; i++) {
      let st = W[i].st;
      if (mode === 'self') st = W[i].st === 'wr' ? 'wr' : i < selfPtr ? 'ok' : 'p';
      if (st === 'p' && live && i >= live.a && i <= live.frontier) st = 'live';   // being recited right now
      if (st === 'p' && hints.has(i)) st = 'hint';
      if (W[i].st === 'ok') ok++; else if (W[i].st === 'wr' || W[i].st === 'ms') wrong++; else if (W[i].st === 'fixed') fixed++;
      const c = 'w ' + st + (i === reach && (listening || mode === 'self') ? ' cur' : '');
      if (spans[i] && spans[i]._c !== c) { spans[i].className = c; spans[i]._c = c; }
    }
    const cur = spans[Math.min(reach, spans.length - 1)];
    if (cur && (listening || mode === 'self')) {
      const r = cur.getBoundingClientRect();
      if (r.top > innerHeight - 280 || r.top < 60) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    const pct = W.length ? Math.round(100 * Math.min(reach, W.length) / W.length) : 0;
    $('stats').innerHTML = `<span>Progress <b>${pct}%</b></span><span>Correct <b>${ok}</b></span><span>Mistakes <b>${wrong}</b></span><span>Fixed <b>${fixed}</b></span>`;
    $('mushaf').classList.toggle('hide', $('hideT').checked);
    $('heard').textContent = listening && (heardFinal || interim) ? (heardFinal + ' ' + interim).trim().split(/\s+/).slice(-12).join(' ') : '';
  }
  function setMain() {
    const b = $('mainBtn');
    b.classList.toggle('live', listening);
    if (mode === 'self') { $('mainTxt').textContent = 'Reveal next ayah'; $('hintBtn').textContent = 'Next word'; }
    else { $('mainTxt').textContent = listening ? 'Stop listening' : (W.some(w => w.st !== 'p') ? 'Continue' : 'Start tasmi'); $('hintBtn').textContent = 'Hint'; }
  }
  function status() { $('status').textContent = mode === 'self' ? 'Self-check' : listening ? 'Listening' : 'Ready'; }
  function note(msg) { $('note').innerHTML = msg || ''; $('note').classList.toggle('show', !!msg); }
  let toastT = 0;
  function toastNote(msg) { note(msg); clearTimeout(toastT); toastT = setTimeout(() => note(''), 6000); }
  function addLog(e) {
    e.t = new Date().toLocaleTimeString(); log.push(e); if (log.length > 200) log.shift();
    if (TEST) window.__log = log;
    $('log').textContent = `${e.t}  ${e.at ? 'words ' + e.at + '  ' : ''}${e.result}\nheard: ${e.heard}\n\n` + $('log').textContent.slice(0, 20000);
  }

  // ---------- word sheet & summary ----------
  function openWord(i) {
    const w = W[i]; if (!w || w.st === 'p') return;
    $('wdWord').textContent = wordName(i);
    $('wdBody').innerHTML = w.st === 'ok' ? '<p>Recited correctly.</p>'
      : w.st === 'fixed' ? `<p>You got this word wrong first${w.heard ? ' (said <b>' + esc(w.heard) + '</b>)' : ''}, then fixed it.</p>`
      : w.st === 'ms' ? '<p>This word was skipped.</p>' : `<p>Mistake${w.heard ? ': you said <b>' + esc(w.heard) + '</b>' : ''}.</p>`;
    $('wdOk').onclick = () => { W[i] = { st: 'ok', everWrong: false, heard: '' }; $('wordDlg').close(); render(); };
    $('wdOk').style.display = w.st === 'ok' ? 'none' : '';
    $('wordDlg').showModal();
  }
  function finish() {
    if (listening) stopListening();
    hideStop();
    const c = { ok: 0, fixed: 0 }; W.forEach(w => { if (w.st in c) c[w.st]++; });
    const mistakes = W.filter(w => w.everWrong).length, unread = W.filter(w => w.st === 'p').length;
    $('sRange').textContent = unitLabel;
    $('sBig').innerHTML = `<div><b>${c.ok}</b>Correct</div><div><b>${mistakes}</b>Mistakes</div><div><b>${c.fixed}</b>Fixed</div><div><b>${unread}</b>Not read</div>`;
    const byAyah = new Map();
    W.forEach((w, i) => {
      if (!w.everWrong) return;
      const a = refOf(i); if (!byAyah.has(a)) byAyah.set(a, []);
      byAyah.get(a).push(`<span class="qw">${esc(wordName(i))}</span> — ${w.st === 'fixed' ? 'fixed after correction' : w.st === 'ms' ? 'skipped' : 'mistake'}${w.heard ? ' (said ' + esc(w.heard) + ')' : ''}`);
    });
    $('sRev').innerHTML = byAyah.size ? '<b>Revise:</b><ul>' + [...byAyah].map(([a, l]) => `<li>Ayah ${a}<ul>${l.map(x => `<li>${x}</li>`).join('')}</ul></li>`).join('') + '</ul>' : '<b>MashaAllah — no mistakes.</b>';
    const hist = lsGet('emuhaffiz.hist', []);
    hist.unshift({ d: new Date().toISOString().slice(0, 16).replace('T', ' '), label: unitLabel, ok: c.ok, m: mistakes });
    lsSet('emuhaffiz.hist', hist.slice(0, 40)); showHist();
    $('sumDlg').showModal();
  }
  function showHist() {
    const h = lsGet('emuhaffiz.hist', []);
    $('histBox').style.display = h.length ? '' : 'none';
    $('hist').innerHTML = h.map(x => `<li>${esc(x.d)} — ${esc(x.label || (x.s + ' ' + x.a + '–' + x.b))}: ${x.ok} correct, ${x.m ?? 0} mistakes</li>`).join('');
  }

  // ---------- controls ----------
  $('mainBtn').addEventListener('click', () => {
    if (mode === 'self') {
      if (selfPtr >= W.length) return;
      const a = passage[selfPtr][0]; while (selfPtr < W.length && passage[selfPtr][0] === a) selfPtr++;
      return render();
    }
    if (listening) stopListening(); else startListening();
  });
  $('hintBtn').addEventListener('click', () => {
    if (mode === 'self') { if (selfPtr < W.length) { selfPtr++; render(); } return; }
    let i = pos; while (hints.has(i) && i < W.length) i++;
    if (i < W.length) { hints.add(i); render(); }
  });
  $('doneBtn').addEventListener('click', finish);
  $('scGo').addEventListener('click', () => { hideStop(); if (!listening && mode === 'mic') startListening(); });
  $('scAgain').addEventListener('click', () => { if (stop) say(stop.i); });
  $('scRight').addEventListener('click', () => {
    if (!stop) return;
    W[stop.i] = { st: 'ok', everWrong: false, heard: '' }; pos = stop.i + 1; hideStop(); render();
  });
  $('mushaf').addEventListener('click', e => {
    const sp = e.target.closest('.w'); if (!sp) return;
    const i = +sp.dataset.i;
    if (mode === 'self') { if (i < selfPtr) { W[i] = W[i].st === 'wr' ? { st: 'ok', everWrong: false } : { st: 'wr', everWrong: true }; render(); } return; }
    openWord(i);
  });
  $('wdClose').addEventListener('click', () => $('wordDlg').close());
  $('sClose').addEventListener('click', () => $('sumDlg').close());
  $('sAgain').addEventListener('click', () => { $('sumDlg').close(); reset(); setMain(); });
  $('modeSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (listening) stopListening();
    mode = b.dataset.m; [...$('modeSeg').children].forEach(x => x.classList.toggle('on', x === b));
    note(mode === 'self' ? 'Recite from memory, then tap <b>Reveal next ayah</b> to check yourself. Tap a word you got wrong to mark it red.' : '');
    reset(); setMain(); status();
  });
  ['hideT', 'voiceOn'].forEach(id => {
    const saved = lsGet('emuhaffiz.' + id, null); if (saved !== null) $(id).checked = saved;
    $(id).addEventListener('change', () => { lsSet('emuhaffiz.' + id, $(id).checked); render(); });
  });
  $('surah').addEventListener('change', () => { $('from').value = 1; $('ayah').value = 1; $('to').value = SURAHS[+$('surah').value - 1][3]; build(); });
  ['unit', 'page', 'para', 'ruba', 'nisf', 'ayah', 'from', 'to'].forEach(id => $(id).addEventListener('change', build));
  $('prevU').addEventListener('click', () => step(-1));
  $('nextU').addEventListener('click', () => step(1));
  $('copyLog').addEventListener('click', () => {
    navigator.clipboard.writeText(JSON.stringify({ unit: unitLabel, ua: navigator.userAgent, log }, null, 1))
      .then(() => toastNote('Log copied. Paste it to Claude.'), () => toastNote('Could not copy.'));
  });

  // ---------- start ----------
  (async () => {
    [SURAHS, DIV] = await Promise.all([fetch('surahs.json?v=' + VER).then(r => r.json()), fetch('divisions.json?v=' + VER).then(r => r.json())]);
    START = [0, 1]; for (let n = 1; n < 114; n++) START.push(START[n] + SURAHS[n - 1][3]);
    $('surah').innerHTML = SURAHS.map(s => `<option value="${s[0]}">${s[0]}. ${s[2]} · ${s[1]}</option>`).join('');
    const sel = lsGet('tasmi.sel', null);
    if (sel) for (const [k, v] of Object.entries(sel)) if ($(k) && v != null) $(k).value = v;
    await build(); showHist(); setMain(); status();
    if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) note('This browser has no speech recognition. Open the page in <b>Google Chrome</b>, or use <b>Self-check</b>.');
    if (TEST) window.__app = { get pos() { return pos; }, get W() { return W; }, get passage() { return passage; }, get S() { return S; },
      get T() { return T; }, get stop() { return stop; }, get listening() { return listening; } };
  })();
})();
