# Tasmi AI — Android app

The same page as the website (`site/`, bundled as the app's assets) in a WebView, with Android's own speech
recognition and Arabic text-to-speech instead of Chrome's:

- `Listener.java` keeps listening through the breaths between ayat, best way first, stepping down by itself:
  - STREAM (Android 13+): `Mic.java` records the microphone itself without a break and streams it into one long
    segmented recogniser session (`EXTRA_AUDIO_SOURCE` + `EXTRA_SEGMENTED_SESSION`); a new session gets the last
    seconds it missed replayed, so nothing is lost. Steps down if the recogniser errors at once or writes nothing
    while the mic hears a voice.
  - SEGMENTED (Android 13+): one long session on the recogniser's own mic.
  - RESTART: the recogniser restarted after every phrase (short gap; the media stream is muted while listening so
    its beep isn't heard, and restored on stop, before the correction is spoken, and when the app is left).
  The mode in use is written to the page's log ("listening mode: …").
- `MainActivity.java` — WebView (`WebViewAssetLoader`, https://appassets.androidplatform.net/assets/index.html),
  `TasmiNative` bridge (listen, speak, copy), mic permission, screen kept on while listening, stops when left.
- `site/native.js` makes the bridge look like the browser's `SpeechRecognition` / `speechSynthesis`, so `app.js`
  runs unchanged (one continuous session). Tested in `test/sim.test.js` ("Android app" tests).

- The Quran model (`QuranModel.java`, `Verifier.java`, `model/`): a second opinion before every stop — see
  model/README.md.

## Build
GitHub Actions (`.github/workflows/android.yml`) builds on every push that touches `site/` or `android/` and
publishes `TasmiAI.apk` to the `app` release:
https://github.com/hamzakalolwala/Tasmi-AI/releases/download/app/TasmiAI.apk

Locally: `cd android && gradle assembleRelease` (needs the Android SDK; `ANDROID_HOME`).

## Signing
Android only installs a new APK over the old one if both are signed with the same key. The workflow reads the key from
two repository secrets (Settings → Secrets and variables → Actions):
- `TASMI_KEYSTORE_B64` — `base64 -w0 tasmi.keystore` of a keystore with alias `tasmi`
- `TASMI_KEY_PASSWORD` — its password (store and key)

Make one with `keytool -genkeypair -keystore tasmi.keystore -alias tasmi -keyalg RSA -keysize 2048 -validity 20000
-dname "CN=Tasmi AI"`, and keep it safe — never commit it. Without the secrets each build is signed with a one-off key,
so installing a newer build needs the old app uninstalled first (its saved history goes with it).
