# The Quran model (second opinion before a stop)

Tarteel's open **whisper-tiny-ar-quran** (Apache-2.0, https://huggingface.co/tarteel-ai/whisper-tiny-ar-quran), run on
the phone with ONNX Runtime. Google's recogniser still follows the recitation; when it thinks a word was wrong or
skipped, the page asks this model what it heard in the last 10 s of audio (`Verifier.java`, `QuranModel.java`) and
`Recite.confirm()` lines its text up against the passage:
- **said** — the model heard the word right: Google misheard, no stop;
- **not** — the model heard that place, without the word: stop;
- **unknown** — its audio doesn't cover that place well enough (or it was slower than 3 s, or not loaded): stop.

Only in STREAM mode (the app records the mic itself, so the audio is there).

## Files
`build_model.py` (run in CI, cached) → `android/app/quran-assets/quran-model/` (not in git, ~110 MB):
encoder 11.7 MB, decoder 49.8 MB, decoder-with-past 48.6 MB (int8 matrix weights), tokens.txt.

## Measured (on a computer; a phone is ~2–3× slower)
- `QuranModel.java` gives the same text as the Python reference on all 8 test clips (log-mel max diff 2e-5).
- 0.4–1.0 s for 12 s of audio (int8, 4 threads).
- 72 clips (6 EveryAyah reciters × 12 random ayat), words at least 1.5 s into the audio window (in the app the word
  is always several seconds in: the stop comes 2–3 s after it). `confirm` needs matched words on both sides of the word
  and reads the transcript from its end (only the latest pass counts when the reciter went back to repeat):

| audio | right words confirmed (false stop cancelled) | real wrong word wrongly cancelled | real skip wrongly cancelled |
|---|---|---|---|
| clean | 92.8% | 0.0% | 1.4% |
| quiet room (28 dB SNR, phone band, cut mid-word) | 84.6% | 0.0% | 0.3% |
| noisy phone (15 dB SNR) | 80.6% | 0.3% | 0.8% |

whisper-base-ar-quran was 87.4% / 90.8% in room / noisy, but twice the size and 1.5× slower.
EveryAyah reciters may be in Tarteel's training data; Hamza's own voice is the real test (the log says what the
model heard: "Quran model on …").
