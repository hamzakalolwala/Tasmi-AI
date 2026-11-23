package ai.tasmi.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import java.util.ArrayList;

/**
 * Keeps listening for a whole recitation — through the breaths between ayat — until the reciter taps Stop.
 *
 * Three ways, best first; it steps down by itself if the phone's recogniser can't do one:
 *  STREAM    (Android 13+) the app records the microphone itself without a break ({@link Mic}) and streams it into
 *            one long recogniser session, which reports each phrase as it ends; if the session ever restarts, the
 *            audio it missed is replayed, so nothing is lost.
 *  SEGMENTED (Android 13+) one long recogniser session on the recogniser's own microphone.
 *  RESTART   the recogniser stops after every phrase and is started again at once (a short gap; the beep muted).
 * All methods run on the main thread.
 */
final class Listener {
    interface Events {
        void partial(String text);
        void fin(String text);
        /** the session is over: error is a browser-style code ("not-allowed", "network", "no-speech"…) or null */
        void ended(String error);
        /** which way it is listening (for the troubleshooting log) */
        void mode(String mode, String why);
        /** the microphone was off for a moment (RESTART only): a word said just then may be missing */
        void gap();
    }

    static final int STREAM = 0, SEGMENTED = 1, RESTART = 2;
    private static final String[] NAMES = {"stream", "segmented", "restart"};

    private static final long QUIET_MS = 45_000;       // nothing heard for this long: end the session (the page pauses)
    private static final long STUCK_MS = 15_000;       // RESTART: no callback at all for this long — the recogniser hung
    private static final long LONG_SESSION_MS = 10 * 60_000;
    private static final int[] BACKOFF = {0, 250, 700, 1500, 3000, 5000};
    private static final String PREFS = "tasmi", MUTED = "musicMuted";

    private final Context ctx;
    private final Events ev;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AudioManager audio;
    private final SharedPreferences prefs;
    private final Mic mic = new Mic();
    private SpeechRecognizer sr;
    private boolean want, muted;
    private String lang = "ar-SA";
    private int mode = Build.VERSION.SDK_INT >= 33 ? STREAM : RESTART;
    private boolean modeWorked;                         // the current mode has produced words at least once
    private int fails, busy, deafTicks, earlyFails;
    private long modeAt;                                 // when the current mode was first started
    private long lastSpeech, sessionAt, lastWords;
    private String lastPartial = "";
    private int generation;
    private final Runnable stuck = () -> { if (want) { destroy(); open(); } };
    private final Runnable tick = new Runnable() {     // once a second while listening
        @Override public void run() {
            if (!want) return;
            long now = SystemClock.elapsedRealtime();
            if (mode == STREAM && mic.quietMs() < 1500) lastSpeech = Math.max(lastSpeech, now - mic.quietMs());
            if (now - lastSpeech > QUIET_MS) { finish("no-speech"); return; }
            // STREAM: the mic hears a voice but the recogniser writes nothing — it does not take our audio
            if (mode == STREAM && !modeWorked && now - sessionAt > 3000 && mic.quietMs() < 1200 && ++deafTicks >= 5) {
                stepDown("the recogniser heard nothing from the app's microphone");
                return;
            }
            // …or the mic level never says "speech" on this phone: no words at all for 25 s although something was heard
            if (mode == STREAM && !modeWorked && now - modeAt > 25_000 && mic.quietMs() < 25_000) {
                stepDown("no words in 25 s from the app's microphone");
                return;
            }
            // STREAM: it worked, but now the voice goes on and no words come: the session hung — start a new one
            // (the audio it missed is replayed into the new one)
            if (mode == STREAM && modeWorked && mic.quietMs() < 1500 && now - Math.max(lastWords, sessionAt) > 20_000) {
                destroy(); open();
            }
            main.postDelayed(this, 1000);
        }
    };

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
        if (!modeWorked) { modeAt = lastSpeech; earlyFails = 0; }
        mute(true);
        ev.mode(NAMES[mode], "start");
        if (mode == RESTART) ev.gap();                  // the recogniser opening its mic takes a moment
        open();
        main.removeCallbacks(tick);
        main.postDelayed(tick, 1000);
    }

    /** stop listening; the page already knows (it asked) */
    void stop() {
        want = false;
        generation++;
        main.removeCallbacksAndMessages(null);
        destroy();
        mic.stop();
        mute(false);
        lastPartial = "";
    }

    boolean listening() { return want; }

    /** the last `ms` of the reciter's audio, when the app records the mic itself (STREAM mode); else null */
    float[] recentAudio(int ms) { return want && mode == STREAM ? mic.recent(ms) : null; }

    private void destroy() {
        if (sr != null) {
            try { sr.cancel(); } catch (Exception ignored) { }
            try { sr.destroy(); } catch (Exception ignored) { }
            sr = null;
        }
        mic.endSession();
    }

    /** this way does not work on this phone: try the next one (for as long as the app runs) */
    private void stepDown(String why) {
        if (mode >= RESTART) return;
        mode++;
        modeWorked = false;
        deafTicks = 0;
        earlyFails = 0;
        modeAt = SystemClock.elapsedRealtime();
        if (mode != STREAM) mic.stop();
        ev.mode(NAMES[mode], why);
        destroy();
        main.post(() -> { if (want) open(); });
        main.removeCallbacks(tick);
        main.postDelayed(tick, 1000);
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

    private Intent intent(ParcelFileDescriptor source) {
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
        if (Build.VERSION.SDK_INT >= 33 && mode == STREAM && source != null) {
            i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, source);
            i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
            i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
            i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, Mic.RATE);
            // one session for as long as the app streams audio; each phrase arrives as a segment
            i.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE);
        } else if (Build.VERSION.SDK_INT >= 33 && mode == SEGMENTED) {
            i.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS);
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, LONG_SESSION_MS);
        }
        return i;
    }

    /** a new recogniser (first start, or after it hung or kept failing) */
    private void open() {
        if (!want) return;
        destroy();
        if (mode == STREAM && !mic.running() && !mic.start()) { stepDown("the app could not open the microphone itself"); return; }
        try {
            sr = SpeechRecognizer.createSpeechRecognizer(ctx);
        } catch (Exception e) {
            finish("language-not-supported");
            return;
        }
        listen();
    }

    /** listen for the next phrase (RESTART) or the next long session, on the same recogniser */
    private void listen() {
        if (!want || sr == null) return;
        final int gen = ++generation;
        final int myMode = mode;
        lastPartial = "";
        sessionAt = SystemClock.elapsedRealtime();
        deafTicks = 0;
        sr.setRecognitionListener(new RecognitionListener() {
            private boolean current() {
                if (gen != generation || !want || myMode != mode) return false;
                if (mode == RESTART) { main.removeCallbacks(stuck); main.postDelayed(stuck, STUCK_MS); }   // still alive
                return true;
            }
            @Override public void onReadyForSpeech(Bundle b) { if (current()) { busy = 0; if (mode == STREAM) mic.releaseReadSide(); } }
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
                heard();
                ev.partial(t);
            }

            /** a long session: one phrase is done, the session goes on */
            @Override public void onSegmentResults(Bundle b) {
                if (!current()) return;
                String t = first(b);
                if (t.isEmpty()) t = lastPartial;
                lastPartial = "";
                if (!t.isEmpty()) { heard(); ev.fin(t); }
            }

            /** a long session ended (time limit, or the audio stream was closed): start the next one */
            @Override public void onEndOfSegmentedSession() {
                if (!current()) return;
                generation++;
                flushPartial();
                again(0, false);
            }

            @Override public void onResults(Bundle b) {
                if (!current()) return;
                generation++;                               // an onError after this result is ignored
                String t = first(b);
                if (t.isEmpty()) t = lastPartial;           // some recognisers end with an empty final
                lastPartial = "";
                if (!t.isEmpty()) { heard(); ev.fin(t); }
                again(0, false);
            }

            @Override public void onError(int code) {
                if (!current()) return;
                generation++;
                flushPartial();
                // a long-session mode the phone's recogniser can't do. "Not supported" errors (12–15) say so at once;
                // ordinary hiccups (busy, client, server, no match…) only after 3 in a row before any word was heard
                if (mode != RESTART && !modeWorked && code != SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS
                        && code != SpeechRecognizer.ERROR_NETWORK && code != SpeechRecognizer.ERROR_NETWORK_TIMEOUT) {
                    boolean unsupported = code >= 12 && code <= 15;
                    if (unsupported || (SystemClock.elapsedRealtime() - sessionAt < 4000 && ++earlyFails >= 3)) {
                        stepDown("recogniser error " + code + " in " + NAMES[mode] + " mode");
                        return;
                    }
                }
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
        if (mode == RESTART) { main.removeCallbacks(stuck); main.postDelayed(stuck, STUCK_MS); }
        try {
            ParcelFileDescriptor source = mode == STREAM ? mic.newSession() : null;
            sr.startListening(intent(source));
        } catch (Exception e) {
            if (mode != RESTART && !modeWorked && ++earlyFails >= 2) { stepDown("could not start " + NAMES[mode] + " mode"); return; }
            busy++;
            if (busy > 12) finish("error"); else again(600, true);
        }
    }

    private void heard() {
        lastSpeech = lastWords = SystemClock.elapsedRealtime();
        fails = 0;
        if (!modeWorked) { modeWorked = true; ev.mode(NAMES[mode], "working"); }
    }

    /** words heard but never finalised: pass them on as final */
    private void flushPartial() {
        if (!lastPartial.isEmpty()) { ev.fin(lastPartial); lastPartial = ""; fails = 0; }
    }

    /** listen again after the phrase (or after a hiccup); a long silence ends the session instead */
    private void again(long delay, boolean fresh) {
        if (!want) return;
        if (SystemClock.elapsedRealtime() - lastSpeech > QUIET_MS) { finish("no-speech"); return; }
        if (mode == RESTART) ev.gap();
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
        mic.stop();
        mute(false);
        ev.ended(error);
    }

    private static String first(Bundle b) {
        if (b == null) return "";
        ArrayList<String> r = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return r == null || r.isEmpty() || r.get(0) == null ? "" : r.get(0).trim();
    }
}
