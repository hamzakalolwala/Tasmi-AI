# Tasmi AI

A muhaffiz in your phone: listens to your Quran tasmi breath by breath, stops you on a mistake and says the right
word, and notes tajweed slips (madd, ghunnah, ikhfa, iqlab, idgham, qalqalah).

**Open it in Chrome:** https://hamzakalolwala.github.io/Tasmi-AI/

- `site/` — the app (deployed to the `gh-pages` branch)
- `scripts/precompute.py` — builds `site/data/*.json` with quran-transcript
- `test/` — `npm install && node --test test/*.test.js` (browser tests need Chrome + Playwright)

See `CLAUDE.md` for how it works and `site/NOTICE.md` for credits.
