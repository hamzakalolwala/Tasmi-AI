package ai.tasmi.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.util.Locale;

/** The Tasmi page (bundled in the app) in a WebView, with Android's speech recognition and text-to-speech. */
public class MainActivity extends Activity {
    private static final String HOME = "https://appassets.androidplatform.net/assets/index.html";
    private static final int MIC = 1;

    private WebView web;
    private Listener listener;
    private TextToSpeech tts;
    private boolean ttsArabic, resumed, startWhenResumed;
    private String pendingLang;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        setContentView(web);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setTextZoom(100);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return loader.shouldInterceptRequest(r.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });

        listener = new Listener(this, new Listener.Events() {
            @Override public void partial(String t) { send("partial", "text", t); }
            @Override public void fin(String t) { send("final", "text", t); }
            @Override public void ended(String error) {
                keepScreenOn(false);
                if (error == null) send("end", null, null); else send("error", "error", error);
            }
        });
        tts = new TextToSpeech(this, status -> {
            if (status != TextToSpeech.SUCCESS) return;
            int r = tts.setLanguage(new Locale("ar", "SA"));
            if (r < 0) r = tts.setLanguage(new Locale("ar"));
            ttsArabic = r >= 0;
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { send("ttsDone", "id", id); }
                @Override public void onError(String id) { send("ttsError", "id", id); }
                @Override public void onStop(String id, boolean interrupted) { send("ttsError", "id", id); }
            });
            send("voices", null, null);
        });

        web.addJavascriptInterface(new Bridge(), "TasmiNative");
        if (saved != null) web.restoreState(saved); else web.loadUrl(HOME);
    }

    /** called from the page (on a background thread: everything is posted to the main thread) */
    final class Bridge {
        @JavascriptInterface public void startListening(String lang) { runOnUiThread(() -> startListen(lang)); }
        @JavascriptInterface public void stopListening() { runOnUiThread(() -> { startWhenResumed = false; listener.stop(); keepScreenOn(false); }); }
        @JavascriptInterface public boolean speak(String text, double rate, String id) {
            if (tts == null || !ttsArabic) return false;
            // after the microphone was released (and the sound un-muted): calls from the page run in order
            runOnUiThread(() -> {
                tts.setSpeechRate((float) Math.max(0.3, Math.min(2.0, rate)));
                if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) send("ttsError", "id", id);
            });
            return true;
        }
        @JavascriptInterface public void stopSpeaking() { if (tts != null) tts.stop(); }
        @JavascriptInterface public boolean hasArabicVoice() { return ttsArabic; }
        @JavascriptInterface public boolean copy(String text) {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("Tasmi log", text));
                return true;
            } catch (Exception e) { return false; }
        }
    }

    private void startListen(String lang) {
        if (!Listener.available(this)) { send("error", "error", "language-not-supported"); return; }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingLang = lang;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC);
            return;
        }
        if (!resumed) { startWhenResumed = true; pendingLang = lang; return; }
        keepScreenOn(true);
        listener.start(lang);
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (code != MIC) return;
        if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) startListen(pendingLang);
        else send("error", "error", "not-allowed");
    }

    private void keepScreenOn(boolean on) {
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    /** an event to native.js */
    private void send(String type, String key, String value) {
        runOnUiThread(() -> {
            try {
                JSONObject o = new JSONObject();
                o.put("type", type);
                if (key != null) o.put(key, value);
                web.evaluateJavascript("window.__tasmiNative && window.__tasmiNative.onEvent(" + o + ")", null);
            } catch (Exception ignored) { }
        });
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        web.onResume();
        if (startWhenResumed) { startWhenResumed = false; startListen(pendingLang); }
    }

    @Override protected void onPause() {
        // the app is hidden or the screen went off: stop the microphone and give the sound back.
        // The page sees the session end; it starts listening again when it is visible.
        resumed = false;
        if (listener.listening()) { listener.stop(); keepScreenOn(false); send("end", null, null); }
        if (tts != null) tts.stop();
        web.onPause();
        super.onPause();
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        listener.stop();
        if (tts != null) { tts.stop(); tts.shutdown(); }
        web.destroy();
        super.onDestroy();
    }
}
