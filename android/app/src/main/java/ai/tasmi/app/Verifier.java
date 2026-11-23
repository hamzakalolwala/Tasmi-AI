package ai.tasmi.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.SystemClock;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The Quran model as a second opinion: before the page stops the reciter for a mistake, it asks what the model
 * heard in the last seconds of audio. Loaded once in the background (the files are copied out of the APK the first
 * time, then read from disk); every call runs on one background thread.
 */
final class Verifier {
    interface Done { void text(String text, long ms, String error); }

    private static final String[] FILES = {"encoder_model.int8.onnx", "decoder_model.int8.onnx", "decoder_with_past_model.int8.onnx", "tokens.txt"};
    private final Context ctx;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> new Thread(r, "tasmi-quran-model"));
    private volatile QuranModel model;
    private volatile String state = "not loaded";       // for the log: not loaded / loading / ready / missing / failed: …
    private boolean started;

    Verifier(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    /** is the model in this APK at all (it is added at build time) */
    boolean bundled() {
        try { String[] a = ctx.getAssets().list("quran-model"); return a != null && a.length >= FILES.length; }
        catch (Exception e) { return false; }
    }

    boolean ready() { return model != null; }
    String state() { return state; }

    /** load it in the background (once) */
    synchronized void prepare() {
        if (started) return;
        started = true;
        if (!bundled()) { state = "missing"; return; }
        state = "loading";
        worker.execute(() -> {
            try {
                long t0 = SystemClock.elapsedRealtime();
                File dir = unpack();
                model = new QuranModel(dir);
                state = "ready (" + (SystemClock.elapsedRealtime() - t0) + " ms to load)";
            } catch (Throwable e) {
                state = "failed: " + e;
            }
        });
    }

    /** what the model hears in this audio; the answer comes on the model's thread */
    void transcribe(float[] audio, Done done) {
        worker.execute(() -> {
            QuranModel m = model;
            if (m == null) { done.text("", 0, state); return; }
            long t0 = SystemClock.elapsedRealtime();
            try { done.text(m.transcribe(audio), SystemClock.elapsedRealtime() - t0, null); }
            catch (Throwable e) { done.text("", SystemClock.elapsedRealtime() - t0, e.toString()); }
        });
    }

    /** copy the model out of the APK into the app's files (once per app version) */
    private File unpack() throws Exception {
        long version;
        try { version = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).getLongVersionCode(); }
        catch (Exception e) { version = 0; }
        File dir = new File(ctx.getFilesDir(), "quran-model-" + version);
        File done = new File(dir, ".complete");
        if (done.exists()) return dir;
        // remove older copies
        File[] old = ctx.getFilesDir().listFiles((d, n) -> n.startsWith("quran-model-"));
        if (old != null) for (File o : old) deleteAll(o);
        if (!dir.mkdirs() && !dir.isDirectory()) throw new IllegalStateException("cannot create " + dir);
        AssetManager am = ctx.getAssets();
        byte[] buf = new byte[1 << 16];
        for (String f : FILES) {
            try (InputStream in = am.open("quran-model/" + f); OutputStream out = new FileOutputStream(new File(dir, f))) {
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
        }
        if (!done.createNewFile() && !done.exists()) throw new IllegalStateException("cannot finish " + dir);
        return dir;
    }

    private static void deleteAll(File f) {
        File[] k = f.listFiles();
        if (k != null) for (File c : k) deleteAll(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
