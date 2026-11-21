import * as Q from 'quran-meta/hafs';
import { writeFileSync } from 'fs';
const r = m => [m.firstAyahId, m.lastAyahId];
const out = {
  source: 'quran-meta (Hafs, Madani 604-page mushaf)',
  page: Array.from({ length: 604 }, (_, i) => r(Q.getPageMeta(i + 1))),
  rub: Array.from({ length: 240 }, (_, i) => r(Q.getRubAlHizbMeta(i + 1))),
  juz: Array.from({ length: 30 }, (_, i) => r(Q.getJuzMeta(i + 1))),
};
// sanity: contiguous cover of 1..6236
for (const k of ['page', 'rub', 'juz']) {
  let next = 1; for (const [f, l] of out[k]) { if (f !== next || l < f) throw new Error(k + ' gap at ' + f); next = l + 1; }
  if (next !== 6237) throw new Error(k + ' end ' + next);
}
writeFileSync(process.argv[2], JSON.stringify(out));
console.log('ok', out.page.length, out.rub.length, out.juz.length, 'juz 2 starts at ayah id', out.juz[1][0]);
