/* Tasmi AI word engine: matches what speech recognition heard against the passage, word by word.
 * Pure functions (no DOM), so it runs in the browser and in node tests. */
(function (root) {
  'use strict';
  const HARAKAT = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

  /** spelling-independent skeleton of an Arabic word: no harakat, one alef form, no long alef after the first letter */
  function norm(w) {
    let s = String(w).normalize('NFC').replace(HARAKAT, '')
      .replace(/[ٱأإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ء/g, '')
      .replace(/[^ء-ي]/g, '');
    return s.length > 1 ? s[0] + s.slice(1).replace(/ا/g, '') : s;
  }
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }
  /** close enough to be the same word (speech recognition spells freely) */
  function same(h, e) {
    if (!h || !e) return false;
    if (h === e) return true;
    const L = Math.max(h.length, e.length);
    if (L <= 2) return false;
    // hamza, ة/ه and long alef are already normalised away, so a real difference is a different word:
    // allow one slipped letter (two only in very long words) — يعلمون for يعملون is a mistake
    return lev(h, e) <= (L >= 10 ? 2 : 1);
  }
  const words = text => String(text || '').trim().split(/\s+/).map(norm).filter(Boolean);

  // surahs whose first word is a group of separate letters (الم، طه، يس...): read as letter names, recognised freely
  const MUQ = new Set([2, 3, 7, 10, 11, 12, 13, 14, 15, 19, 20, 26, 27, 28, 29, 30, 31, 32, 36, 38, 40, 41, 42, 43, 44, 45, 46, 50, 68]);

  /** S: ayat [{d:[display], i:[key | [keys]], sn, an}], passage: [[ai, k], ...] → one token per spoken word */
  function tokens(S, passage) {
    const out = [];
    passage.forEach(([ai, k], wi) => {
      const a = S[ai], key = a.i[k];
      const free = k === 0 && ((a.an === 1 && MUQ.has(a.sn)) || (a.sn === 42 && a.an === 2));
      for (const part of Array.isArray(key) ? key : [key]) out.push({ k: norm(part), wi, free });
    });
    return out;
  }

  /** global alignment of heard words H against expected tokens E (trailing E free: not recited yet) */
  function align(H, E) {
    const N = H.length, K = E.length, W = K + 1;
    const dp = new Float32Array((N + 1) * W), bk = new Int8Array((N + 1) * W);
    const skip = j => (E[j - 1].free ? 0 : 1);
    for (let j = 1; j <= K; j++) { dp[j] = dp[j - 1] - skip(j); bk[j] = 2; }
    for (let i = 1; i <= N; i++) {
      dp[i * W] = -0.7 * i; bk[i * W] = 3;
      for (let j = 1; j <= K; j++) {
        const m = same(H[i - 1], E[j - 1].k) ? 2 : E[j - 1].free ? -0.3 : -1;
        const d = dp[(i - 1) * W + j - 1] + m, l = dp[i * W + j - 1] - skip(j), u = dp[(i - 1) * W + j] - 0.7;
        let b = 1, v = d; if (l > v) { v = l; b = 2; } if (u > v) { v = u; b = 3; }
        dp[i * W + j] = v; bk[i * W + j] = b;
      }
    }
    let j = 0, best = -1e9;
    for (let k = 0; k <= K; k++) if (dp[N * W + k] > best) { best = dp[N * W + k]; j = k; }
    const ops = []; let i = N;
    while (i > 0 || j > 0) {
      const b = bk[i * W + j];
      if (b === 1) { ops.push({ t: same(H[i - 1], E[j - 1].k) || E[j - 1].free ? 'ok' : 'wr', h: i - 1, e: j - 1 }); i--; j--; }
      else if (b === 2) { ops.push({ t: E[j - 1].free ? 'ok' : 'ms', e: j - 1 }); j--; }
      else { ops.push({ t: 'x', h: i - 1 }); i--; }
    }
    return { ops: ops.reverse(), score: best };
  }

  /** Where in the passage was this heard and how did each word go?
   *  pos: display word the reciter should be at. A recitation may start a few words back (repeating, or starting
   *  the ayah again after a correction) — never ahead, so a skipped word is judged as missing. */
  function assess(T, passage, pos, heardRaw) {
    const H = Array.isArray(heardRaw) ? heardRaw : words(heardRaw);
    const raw = Array.isArray(heardRaw) ? heardRaw : String(heardRaw || '').trim().split(/\s+/).filter(w => norm(w));
    if (!H.length) return null;
    const tokAt = wi => T.findIndex(t => t.wi >= wi);
    pos = Math.max(0, Math.min(pos, passage.length));
    if (pos >= passage.length) return { a: pos, frontier: pos - 1, status: {}, trail: raw, score: -H.length, matched: 0, H, raw };
    const ai = passage[pos][0];
    let s = pos; while (s > 0 && passage[s - 1][0] === ai && pos - s < 25) s--;
    const back = Math.max(6, pos - s);
    let best = null;
    for (let a = pos; a >= Math.max(0, pos - back); a--) {
      const t0 = tokAt(a), E = T.slice(t0, t0 + Math.ceil(H.length * 1.6) + 12);
      const r = align(H, E);
      const sc = r.score - 0.05 * (pos - a);
      if (!best || sc > best.sc) best = { a, t0, E, r, sc };
    }
    const { a, t0, E, r } = best;
    const tokSt = {}, heardAt = {};
    let lastOk = -1;
    for (const o of r.ops) if (o.e != null) { tokSt[o.e] = o.t; if (o.h != null) heardAt[o.e] = raw[o.h]; if (o.t === 'ok' || o.t === 'wr') lastOk = Math.max(lastOk, o.e); }
    // per display word: ok if all its spoken words are ok
    const status = {}, heard = {}; let frontier = a - 1, matched = 0;
    for (let e = 0; e <= lastOk; e++) {
      const wi = E[e].wi, st = tokSt[e];
      if (st === 'ok' && !E[e].free) matched++;
      if (st === 'ok' || st === 'wr') frontier = Math.max(frontier, wi);
      const prev = status[wi];
      status[wi] = !prev ? st : prev === 'ok' ? st : prev === 'ms' && st === 'ok' ? 'wr' : prev;
      if (heardAt[e]) heard[wi] = (heard[wi] ? heard[wi] + ' ' : '') + heardAt[e];
    }
    // heard words after the last matched word (a wrong word at the end, or a repeat)
    const lastOp = r.ops.map(o => o.t !== 'x' && o.t !== 'ms').lastIndexOf(true);
    const trail = r.ops.slice(lastOp + 1).filter(o => o.t === 'x').map(o => ({ k: H[o.h], raw: raw[o.h] }));
    return { a, frontier, status, heard, trail, score: r.score, matched, H, raw, E, t0 };
  }

  /** What does the muhaffiz do?  final: the recogniser has settled this phrase.
   *  {stop: wi, kind: 'wr'|'ms', heard} to correct the reciter, or {commit: nextPos} to move on, or {none: true}. */
  function decide(res, passage, T, final) {
    if (!res) return { none: true };
    const { a, frontier, status } = res;
    for (let wi = a; wi <= frontier; wi++) {
      const st = status[wi];
      if (st !== 'wr' && st !== 'ms') continue;
      // while words are still coming in, only stop once two later words were heard correctly after it
      if (!final) { let okAfter = 0; for (let x = wi + 1; x <= frontier; x++) if (status[x] === 'ok') okAfter++; if (okAfter < 2) return { none: true }; }
      return { stop: wi, kind: st, heard: res.heard[wi] || '' };
    }
    if (final && res.trail.length && frontier + 1 < passage.length && frontier >= a) {
      // unmatched words at the end: a wrong word — unless they repeat what was just recited
      const recent = T.filter(t => t.wi >= Math.max(0, a - 8) && t.wi <= frontier + 1).map(t => t.k);
      const nextFree = T.some(t => t.wi === frontier + 1 && t.free);
      if (!nextFree && !res.trail.some(x => recent.some(k => same(x.k, k))))
        return { stop: frontier + 1, kind: 'wr', heard: res.trail.map(x => x.raw).join(' ') };
    }
    if (final) return frontier >= a ? { commit: frontier + 1 } : { none: true };
    return { none: true };
  }

  const PRE = ['بسم الله الرحمن الرحيم', 'أعوذ بالله من الشيطان الرجيم', 'صدق الله العظيم'].map(words);
  /** how many of the first heard words are basmala / isti'adha / "sadaqallahul azim" (said around a recitation) */
  function preambleLength(heardRaw) {
    const H = Array.isArray(heardRaw) ? heardRaw : words(heardRaw);
    let used = 0, progress = true;
    while (progress && used < H.length) {          // any order: isti'adha then basmala, or just one of them
      progress = false;
      for (const p of PRE) {
        let k = 0; for (const w of p) if (H[used + k] && same(H[used + k], w)) k++;
        if (k >= Math.ceil(p.length * 0.6)) { used += k; progress = true; break; }
      }
    }
    return used;
  }
  function isPreamble(heardRaw) { const n = words(heardRaw).length; const u = preambleLength(heardRaw); return u > 0 && u >= n - 1; }
  /** the heard text without a leading basmala / isti'adha (said in the same breath as the first words) */
  function withoutPreamble(text) {
    const raw = String(text || '').trim().split(/\s+/).filter(w => norm(w));
    const n = preambleLength(raw.map(norm));
    return n >= 3 ? raw.slice(n).join(' ') : raw.join(' ');
  }

  const API = { norm, same, words, tokens, align, assess, decide, isPreamble, preambleLength, withoutPreamble, lev };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.Recite = API;
})(typeof self !== 'undefined' ? self : this);
