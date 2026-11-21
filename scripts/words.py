"""Per-surah word lists for listening with speech recognition (no tajweed model):
  site/words/N.json = [{"d": [display words], "i": [plain imla'i spelling without harakat]}, ...] one entry per ayah.
Display text: quran-json (Tanzil Uthmani) where it splits into the same words, else quran-transcript's Uthmani.
Matching text: quran-transcript's imla'i spelling, which is how speech recognition writes Arabic.

  python3 -I scripts/words.py QURAN_JSON OUTDIR
"""
import json, os, re, sys
from quran_transcript import Aya

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
display = json.load(open(src))
HARAKAT = re.compile('[ؐ-ًؚ-ٰٟۖ-ۭـ]')


def skel(w):
    w = HARAKAT.sub('', w)
    w = re.sub('[ٱأإآ]', 'ا', w).replace('ى', 'ي').replace('ة', 'ه').replace('ؤ', 'و').replace('ئ', 'ي').replace('ء', '')
    return w[:1] + w[1:].replace('ا', '') if w else w


def sim(a, b):
    import difflib
    return difflib.SequenceMatcher(None, skel(a), skel(b)).ratio()


def group(uth, im):
    """one entry per Uthmani word: its imla'i word, or a list when the imla'i spelling splits it (يَٰٓأَيُّهَا → يا أيها)"""
    extra = len(im) - len(uth)
    if extra < 0: return None
    out, i = [], 0
    for k, w in enumerate(uth):
        take = 1
        if extra > 0:
            best = sim(w, im[i])
            for t in range(2, min(extra + 1, 3) + 1):
                if i + t <= len(im) and sim(w, ''.join(im[i:i + t])) > best + 0.05:
                    best, take = sim(w, ''.join(im[i:i + t])), t
        # never leave fewer imla'i words than Uthmani words still to place
        take = min(take, len(im) - i - (len(uth) - k - 1))
        out.append(im[i] if take == 1 else im[i:i + take]); i += take; extra -= take - 1
    return out if i == len(im) else None


bad = 0
for s in display:
    n, ayat = s['n'], []
    for a, dv in enumerate(s['v'], 1):
        g = Aya(n, a).get()
        u, im = g.uthmani_words, g.imlaey_words
        d = dv.split() if len(dv.split()) == len(u) else u
        keys = group(u, [HARAKAT.sub('', w) for w in im])
        if keys is None:
            bad += 1; print('could not map', n, a, len(u), len(im)); keys = [HARAKAT.sub('', w) for w in u]
        ayat.append({'d': d, 'i': keys})
    json.dump(ayat, open(os.path.join(out, f'{n}.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
print('surahs', len(display), 'imlaey/uthmani count mismatches', bad)
