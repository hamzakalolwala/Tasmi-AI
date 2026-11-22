package ai.tasmi.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import java.util.ArrayList;

/**
 * Keeps the microphone on for a whole recitation. Android's recogniser stops after every phrase, so listening is
 * started again at once on the same recogniser, with the start/stop beep muted; to the page it looks like one
 * continuous session. All methods run on the main thread.
 */
final class Listener {
    interface Events {
        void partial(String text);
        void fin(String text);
        /** the session is over: error is a browser-style code ("not-allowed", "network", "no-speech"…) or null */
        void ended(String error);
    }

    private static final long QUIET_MS = 45_000;       // nothing heard for this long: end the session (the page pauses)
    private static final long STUCK_MS = 15_000;       // no callback at all for this long: the recogniser hung
    private static final int[] BACKOFF = {0, 250, 700, 1500, 3000, 5000};
    private static final String PREFS = "tasmi", MUTED = "musicMuted";

    private final Context ctx;
    private final Events ev;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AudioManager audio;
    private final SharedPreferences prefs;
    private SpeechRecognizer sr;
    private boolean want, muted;
    private String lang = "ar-SA";
    private int fails, busy;
    private long lastSpeech;
    private String lastPartial = "";
    private int generation;
    private final Runnable stuck = () -> { if (want) { destroy(); open(); } };

    Listener(Context ctx, Events ev) {
        this.ctx = ctx;
        this.ev = ev;
        this.audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        this.prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        // the app was killed while it had the sound muted: give it back
        if (prefs.getBoolean(MUTED, false)) { muted = true; mute(false); }
    }

    static boolean available(Context ctx) { return SpeechRecognizer.isRecognitionAvailable(ctx); }

    void start(String lang) {
        if (lang != null && !lang.isEmpty()) this.lang = lang;
        want = true;
        fails = 0;
        busy = 0;
        lastSpeech = SystemClock.elapsedRealtime();
        mute(true);
        open();
    }

    /** stop listening; the page already knows (it asked) */
    void stop() {
        want = false;
        generation++;
        main.removeCallbacksAndMessages(null);
        destroy();
        mute(false);
        lastPartial = "";
    }

    boolean listening() { return want; }

    private void destroy() {
        if (sr != null) {
            try { sr.cancel(); } catch (Exception ignored) { }
            try { sr.destroy(); } catch (Exception ignored) { }
            sr = null;
        }
    }

    /**
     * The recogniser's start/end beep plays on the media stream: mute it while listening and give it back after
     * (before a correction is spoken, on stop, when the app is left). Only the media stream — muting notification or
     * system sounds can change the phone's ringer mode — and only if it was not muted already.
     */
    private void mute(boolean on) {
        if (audio == null || muted == on) return;
        if (on && audio.isStreamMute(AudioManager.STREAM_MUSIC)) return;     // already silent: leave it to the user
        try {
            audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, on ? AudioManager.ADJUST_MUTE : AudioManager.ADJUST_UNMUTE, 0);
            muted = on;
            prefs.edit().putBoolean(MUTED, on).apply();
        } catch (Exception ignored) { /* Do Not Disturb may refuse; then the beep stays */ }
    }

    private Intent intent() {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.getPackageName());
        // let a reciter breathe between words without ending the phrase (recognisers may ignore these)
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L);
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L);
        return i;
    }

    /** a new recogniser (first start, or after it hung or kept failing) */
    private void open() {
        if (!want) return;
        destroy();
        try {
            sr = SpeechRecognizer.createSpeechRecognizer(ctx);
        } catch (Exception e) {
            finish("language-not-supported");
            return;
        }
        listen();
    }

    /** listen for the next phrase on the same recogniser: much quicker than making a new one, so no words are lost */
    private void listen() {
        if (!want || sr == null) return;
        final int gen = ++generation;
        lastPartial = "";
        sr.setRecognitionListener(new RecognitionListener() {
            private boolean current() {
                if (gen != generation || !want) return false;
                main.removeCallbacks(stuck); main.postDelayed(stuck, STUCK_MS);   // still alive
                return true;
            }
            @Override public void onReadyForSpeech(Bundle b) { if (current()) busy = 0; }
            @Override public void onBeginningOfSpeech() { if (current()) lastSpeech = SystemClock.elapsedRealtime(); }
            @Override public void onRmsChanged(float v) { }
            @Override public void onBufferReceived(byte[] b) { }
            @Override public void onEndOfSpeech() { current(); }
            @Override public void onEvent(int t, Bundle b) { }

            @Override public void onPartialResults(Bundle b) {
                if (!current()) return;
                String t = first(b);
                if (t.isEmpty() || t.equals(lastPartial)) return;
                lastPartial = t;
                lastSpeech = SystemClock.elapsedRealtime();
                fails = 0;
                ev.partial(t);
            }

            @Override public void onResults(Bundle b) {
                if (!current()) return;
                generation++;                               // an onError after this result is ignored
                String t = first(b);
                if (t.isEmpty()) t = lastPartial;           // some recognisers end with an empty final
                lastPartial = "";
                if (!t.isEmpty()) { lastSpeech = SystemClock.elapsedRealtime(); fails = 0; ev.fin(t); }
                again(0, false);
            }

            @Override public void onError(int code) {
                if (!current()) return;
                generation++;
                // words heard but never finalised: pass them on as final
                if (!lastPartial.isEmpty()) { ev.fin(lastPartial); lastPartial = ""; fails = 0; }
                switch (code) {
                    case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                        finish("not-allowed");
                        return;
                    case SpeechRecognizer.ERROR_NO_MATCH:
                    case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                        again(0, false);                    // silence: just listen again
                        return;
                    case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                    case SpeechRecognizer.ERROR_CLIENT:
                        // common right after a restart: cancel and try again, then a fresh recogniser, then give up
                        busy++;
                        if (busy > 12) { finish("error"); return; }
                        again(busy <= 2 ? 150 : 600, busy > 2);
                        return;
                    case SpeechRecognizer.ERROR_NETWORK:
                    case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                    case SpeechRecognizer.ERROR_SERVER:
                        fails++;
                        if (fails >= 8) { finish("network"); return; }
                        again(BACKOFF[Math.min(fails, BACKOFF.length - 1)], true);
                        return;
                    case SpeechRecognizer.ERROR_AUDIO:
                        fails++;
                        if (fails >= 6) { finish("audio-capture"); return; }
                        again(BACKOFF[Math.min(fails, BACKOFF.length - 1)], true);
                        return;
                    default:
                        if (code == 12 /* ERROR_LANGUAGE_NOT_SUPPORTED */ || code == 13 /* ERROR_LANGUAGE_UNAVAILABLE */) { finish("language-not-supported"); return; }
                        fails++;
                        if (fails >= 8) { finish("network"); return; }
                        again(BACKOFF[Math.min(fails, BACKOFF.length - 1)], true);
                }
            }
        });
        main.removeCallbacks(stuck);
        main.postDelayed(stuck, STUCK_MS);
        try {
            sr.startListening(intent());
        } catch (Exception e) {
            busy++;
            if (busy > 12) finish("error"); else again(600, true);
        }
    }

    /** listen again after the phrase (or after a hiccup); a long silence ends the session instead */
    private void again(long delay, boolean fresh) {
        if (!want) return;
        if (SystemClock.elapsedRealtime() - lastSpeech > QUIET_MS) { finish("no-speech"); return; }
        final int gen = generation;
        main.postDelayed(() -> {
            if (!want || gen != generation) return;
            if (fresh || sr == null) open();
            else { try { sr.cancel(); } catch (Exception ignored) { } listen(); }
        }, delay);
    }

    private void finish(String error) {
        want = false;
        generation++;
        main.removeCallbacksAndMessages(null);
        destroy();
        mute(false);
        ev.ended(error);
    }

    private static String first(Bundle b) {
        if (b == null) return "";
        ArrayList<String> r = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return r == null || r.isEmpty() || r.get(0) == null ? "" : r.get(0).trim();
    }
}
