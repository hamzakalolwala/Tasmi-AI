// Word engine tests: node --test test/recite.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../site/recite.js');

const cache = {};
const surah = n => cache[n] || (cache[n] = JSON.parse(fs.readFileSync(path.join(__dirname, '../site/words', n + '.json'), 'utf8')).map((a, i) => ({ ...a, sn: n, an: i + 1 })));
function passageOf(sn, from, to) {
  const S = surah(sn).slice(from - 1, to), passage = [];
  S.forEach((a, ai) => a.d.forEach((_, k) => passage.push([ai, k])));
  return { S, passage, T: R.tokens(S, passage) };
}
// what speech recognition would write for display words a..b-1 (plain spelling, no harakat)
const spoken = (P, a, b) => P.passage.slice(a, b).flatMap(([ai, k]) => [].concat(P.S[ai].i[k])).join(' ');
const step = (P, pos, heard, final = true) => R.decide(R.assess(P.T, P.passage, pos, heard), P.passage, P.T, final);
const ayahStart = (P, an) => P.passage.findIndex(([ai, k]) => P.S[ai].an === an && k === 0);

test('perfect recitation of an ayah → move on, no stop', () => {
  const P = passageOf(2, 1, 5), s = ayahStart(P, 3), e = ayahStart(P, 4);
  assert.deepStrictEqual(step(P, s, spoken(P, s, e)), { commit: e });
});
test('THE BUG: wrong word in the middle of an ayah → stop on that word (not the ayah start)', () => {
  const P = passageOf(2, 1, 5), s = ayahStart(P, 2);
  const h = spoken(P, s, s + 7).split(' '); h[3] = 'شك';               // لا شك instead of لا ريب
  assert.deepStrictEqual(step(P, s, h.join(' ')), { stop: s + 3, kind: 'wr', heard: 'شك' });
});
test('…and caught early, while still reciting, once two more words are heard', () => {
  const P = passageOf(2, 1, 5), s = ayahStart(P, 2);
  const h = spoken(P, s, s + 7).split(' '); h[3] = 'شك';
  assert.deepStrictEqual(step(P, s, h.slice(0, 5).join(' '), false), { none: true });      // only one word after it
  assert.strictEqual(step(P, s, h.slice(0, 6).join(' '), false).stop, s + 3);              // two words after it
});
test('after a correction, carrying on from the corrected word works', () => {
  const P = passageOf(2, 1, 5), s = ayahStart(P, 2), e = ayahStart(P, 3);
  assert.deepStrictEqual(step(P, s + 3, spoken(P, s + 3, e)), { commit: e });
});
test('after a correction, starting the ayah again from the beginning works (no loop, no stop)', () => {
  const P = passageOf(2, 1, 5), s = ayahStart(P, 4), e = ayahStart(P, 5);
  const r = R.assess(P.T, P.passage, s + 6, spoken(P, s, e));
  assert.strictEqual(r.a, s);
  assert.deepStrictEqual(R.decide(r, P.passage, P.T, true), { commit: e });
});
test('skipped word → stop on the skipped word', () => {
  const P = passageOf(36, 1, 12), s = ayahStart(P, 9), e = ayahStart(P, 10);
  const h = spoken(P, s, e).split(' '); h.splice(3, 1);
  const d = step(P, s, h.join(' '));
  assert.deepStrictEqual([d.stop, d.kind], [s + 3, 'ms']);
});
test('wrong last word of a phrase → stop on it', () => {
  const P = passageOf(67, 1, 3);
  const h = spoken(P, 0, 6).split(' '); h[5] = 'الأرض';
  const d = step(P, 0, h.join(' '));
  assert.strictEqual(d.stop, 5);
});
test('repeating the last few words is not a mistake', () => {
  const P = passageOf(1, 1, 7);
  assert.deepStrictEqual(step(P, 0, spoken(P, 0, 8) + ' ' + spoken(P, 5, 8)), { commit: 8 });
});
test('يَٰٓأَيُّهَا heard as two words "يا أيها" counts as one correct word', () => {
  const P = passageOf(2, 21, 21);
  assert.deepStrictEqual(step(P, 0, 'يا أيها الناس اعبدوا ربكم'), { commit: 4 });   // 5 spoken words = 4 mushaf words
});
test('huroof muqatta\'at: "الم", "ألف لام ميم" or nothing at all are all fine', () => {
  const P = passageOf(2, 1, 2), rest = spoken(P, 1, 5);
  for (const m of ['الم', 'ألف لام ميم', '']) assert.deepStrictEqual(step(P, 0, (m + ' ' + rest).trim()), { commit: 5 }, m);
});
test('spelling the recogniser may use (ة/ه, hamza seats, missing alef) still matches', () => {
  const P = passageOf(2, 3, 3);
  assert.deepStrictEqual(step(P, 0, 'الذين يومنون بالغيب ويقيمون الصلاه ومما رزقنهم ينفقون'), { commit: 8 });
});
test('basmala, isti\'adha and "sadaqallahul azim" are recognised', () => {
  assert.ok(R.isPreamble('بسم الله الرحمن الرحيم'));
  assert.ok(R.isPreamble('أعوذ بالله من الشيطان الرجيم بسم الله الرحمن الرحيم'));
  assert.ok(R.isPreamble('صدق الله العظيم'));
  assert.ok(!R.isPreamble('ذلك الكتاب لا ريب فيه'));
});

// ---------- stress: random places in the whole Quran ----------
let seed = 99; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function randomChunk() {
  for (;;) {
    const sn = 1 + Math.floor(rnd() * 114), n = surah(sn).length, a = 1 + Math.floor(rnd() * n), P = passageOf(sn, a, Math.min(n, a + 2));
    if (P.passage.length < 8) continue;
    const s = Math.floor(rnd() * (P.passage.length - 7)), e = Math.min(P.passage.length, s + 6 + Math.floor(rnd() * 8));
    return { P, s, e, sn };
  }
}
const DISTRACT = ['الكتاب', 'السماء', 'قالوا', 'يعلمون', 'الأرض', 'رسول', 'كانوا', 'شيء'];
for (const [kind, min] of [['perfect', 1], ['wrong', 0.96], ['skip', 0.96]]) {
  test(`stress: 400 random phrases from all 114 surahs, ${kind} → right decision ≥ ${min * 100}%`, () => {
    let good = 0; const bad = [];
    for (let t = 0; t < 400; t++) {
      const { P, s, e, sn } = randomChunk();
      const w = []; for (let i = s; i < e; i++) w.push([].concat(P.S[P.passage[i][0]].i[P.passage[i][1]]));
      const k = 1 + Math.floor(rnd() * (e - s - 3));                    // not first or the last two words
      if (P.T.some(x => x.wi === s + k && x.free)) { t--; continue; }
      if (kind === 'wrong') { const d = DISTRACT.find(x => !w.flat().some(y => R.same(R.norm(x), R.norm(y)))); w[k] = [d]; }
      if (kind === 'skip') { if (w[k].some(x => w.some((y, j) => j !== k && y.some(z => R.same(R.norm(x), R.norm(z)))))) { t--; continue; } w.splice(k, 1); }
      const d = step(P, s, w.flat().join(' '));
      const ok = kind === 'perfect' ? d.commit === e : d.stop === s + k;
      if (ok) good++; else if (bad.length < 4) bad.push({ sn, kind, k, d, words: w.flat().join(' ') });
    }
    console.log(`    ${kind}: ${(good / 4).toFixed(1)}%`);
    assert.ok(good / 400 >= min, JSON.stringify(bad, null, 1));
  });
}

test('a basmala said in the same breath as the first words is taken off before matching', () => {
  assert.strictEqual(R.withoutPreamble('بسم الله الرحمن الرحيم قل أعوذ برب الفلق'), 'قل أعوذ برب الفلق');
  assert.strictEqual(R.withoutPreamble('قل هو الله أحد'), 'قل هو الله أحد');
  assert.strictEqual(R.withoutPreamble('أعوذ بالله من الشيطان الرجيم بسم الله الرحمن الرحيم الحمد لله'), 'الحمد لله');
});

test('a different word that looks similar is a mistake (بالقلب for بالغيب, يعلمون for يعملون)', () => {
  const P = passageOf(2, 3, 3);
  assert.strictEqual(step(P, 0, 'الذين يؤمنون بالقلب ويقيمون الصلاة ومما رزقناهم ينفقون').stop, 2);
  assert.strictEqual(R.same(R.norm('يعلمون'), R.norm('يعملون')), false);
  assert.strictEqual(R.same(R.norm('الصلاه'), R.norm('الصلوة')), true);   // spelling only
});
