package ai.tasmi.app;

import android.content.Context;
import android.content.Intent;
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
 * Keeps the microphone on for a whole recitation. Android's recogniser stops after every phrase, so it is started
 * again at once, with the start/stop beep muted; to the page it looks like one continuous session.
 * All methods run on the main thread.
 */
final class Listener {
    interface Events {
        void partial(String text);
        void fin(String text);
        /** the session is over: error is a browser-style code ("not-allowed", "network", "no-speech"…) or null */
        void ended(String error);
    }

    private static final long QUIET_MS = 45_000;       // nothing heard for this long: end the session (the page pauses)
    private static final int[] BACKOFF = {0, 250, 700, 1500, 3000, 5000};

    private final Context ctx;
    private final Events ev;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AudioManager audio;
    private SpeechRecognizer sr;
    private boolean want, muted;
    private String lang = "ar-SA";
    private int fails;
    private long lastSpeech;
    private String lastPartial = "";
    private int generation;
    private final int[] mutedStreams = {AudioManager.STREAM_MUSIC, AudioManager.STREAM_NOTIFICATION, AudioManager.STREAM_SYSTEM};

    Listener(Context ctx, Events ev) {
        this.ctx = ctx;
        this.ev = ev;
        this.audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
    }

    static boolean available(Context ctx) { return SpeechRecognizer.isRecognitionAvailable(ctx); }

    void start(String lang) {
        if (lang != null && !lang.isEmpty()) this.lang = lang;
        want = true;
        fails = 0;
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

    /** the start and end beeps play on these streams: silence them while listening, restore them after */
    private void mute(boolean on) {
        if (audio == null || muted == on) return;
        muted = on;
        for (int s : mutedStreams) {
            try { audio.adjustStreamVolume(s, on ? AudioManager.ADJUST_MUTE : AudioManager.ADJUST_UNMUTE, 0); }
            catch (Exception ignored) { /* Do Not Disturb may refuse; then the beep stays */ }
        }
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
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 15_000L);
        return i;
    }

    private void open() {
        if (!want) return;
        destroy();
        final int gen = ++generation;
        try {
            sr = SpeechRecognizer.createSpeechRecognizer(ctx);
        } catch (Exception e) {
            finish("language-not-supported");
            return;
        }
        lastPartial = "";
        sr.setRecognitionListener(new RecognitionListener() {
            private boolean current() { return gen == generation && want; }
            @Override public void onReadyForSpeech(Bundle b) { }
            @Override public void onBeginningOfSpeech() { if (current()) lastSpeech = SystemClock.elapsedRealtime(); }
            @Override public void onRmsChanged(float v) { }
            @Override public void onBufferReceived(byte[] b) { }
            @Override public void onEndOfSpeech() { }
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
                String t = first(b);
                if (t.isEmpty()) t = lastPartial;           // some recognisers end with an empty final
                lastPartial = "";
                if (!t.isEmpty()) { lastSpeech = SystemClock.elapsedRealtime(); fails = 0; ev.fin(t); }
                again(0);
            }

            @Override public void onError(int code) {
                if (!current()) return;
                // words heard but never finalised: pass them on as final
                if (!lastPartial.isEmpty()) { ev.fin(lastPartial); lastPartial = ""; fails = 0; }
                switch (code) {
                    case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                        finish("not-allowed");
                        return;
                    case SpeechRecognizer.ERROR_NO_MATCH:
                    case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                        again(0);                         // silence: just listen again
                        return;
                    case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                    case SpeechRecognizer.ERROR_CLIENT:
                        fails++;
                        again(300);
                        return;
                    case SpeechRecognizer.ERROR_NETWORK:
                    case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                    case SpeechRecognizer.ERROR_SERVER:
                        fails++;
                        if (fails >= 8) { finish("network"); return; }
                        again(BACKOFF[Math.min(fails, BACKOFF.length - 1)]);
                        return;
                    case SpeechRecognizer.ERROR_AUDIO:
                        fails++;
                        if (fails >= 6) { finish("audio-capture"); return; }
                        again(BACKOFF[Math.min(fails, BACKOFF.length - 1)]);
                        return;
                    default:
                        // language not available, server disconnected, too many requests…
                        if (code == 12 /* ERROR_LANGUAGE_NOT_SUPPORTED */ || code == 13 /* ERROR_LANGUAGE_UNAVAILABLE */) { finish("language-not-supported"); return; }
                        fails++;
                        if (fails >= 8) { finish("network"); return; }
                        again(BACKOFF[Math.min(fails, BACKOFF.length - 1)]);
                }
            }
        });
        try {
            sr.startListening(intent());
        } catch (Exception e) {
            fails++;
            if (fails >= 8) finish("audio-capture"); else again(BACKOFF[Math.min(fails, BACKOFF.length - 1)]);
        }
    }

    /** start a fresh recogniser after the phrase (or after a hiccup); a long silence ends the session instead */
    private void again(long delay) {
        if (!want) return;
        if (SystemClock.elapsedRealtime() - lastSpeech > QUIET_MS) { finish("no-speech"); return; }
        final int gen = generation;
        main.postDelayed(() -> { if (want && gen == generation) open(); }, delay);
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
