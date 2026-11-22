# Tasmi AI — Android app

The same page as the website (`site/`, bundled as the app's assets) in a WebView, with Android's own speech
recognition and Arabic text-to-speech instead of Chrome's:

- `Listener.java` keeps the microphone on for the whole recitation: Android's recogniser stops after every phrase, so
  it is restarted at once with the start/stop beep muted (music/notification/system streams are muted only while
  listening, and restored on stop, before the correction is spoken, and when the app is left).
- `MainActivity.java` — WebView (`WebViewAssetLoader`, https://appassets.androidplatform.net/assets/index.html),
  `TasmiNative` bridge (listen, speak, copy), mic permission, screen kept on while listening, stops when left.
- `site/native.js` makes the bridge look like the browser's `SpeechRecognition` / `speechSynthesis`, so `app.js`
  runs unchanged (one continuous session). Tested in `test/sim.test.js` ("Android app" tests).

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
