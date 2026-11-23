package ai.tasmi.app;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * A Quran-trained speech model on the phone: Tarteel's open whisper-tiny-ar-quran (Apache-2.0), exported to ONNX and
 * quantised to int8 at build time. Turns up to 30 s of 16 kHz audio into Quran text with harakat.
 * Plain Java (no Android classes), so the same code is tested on a computer (android/model/README.md).
 * Not thread-safe: use from one thread.
 */
final class QuranModel implements AutoCloseable {
    static final int RATE = 16000;
    private static final int N_FFT = 400, HOP = 160, N_MELS = 80, FRAMES = 3000, SAMPLES = RATE * 30;
    private static final long SOT = 50258, AR = 50272, TRANSCRIBE = 50359, NO_TIMESTAMPS = 50363, EOT = 50257;
    private static final int MAX_TOKENS = 220;

    private final OrtEnvironment env = OrtEnvironment.getEnvironment();
    private final OrtSession encoder, decoder, decoderWithPast;
    private final String[] vocab;
    private final float[][] mel = melFilters();
    private final float[] window = new float[N_FFT];
    private final int[] byteOf = new int[512];

    /** the model files in a folder: encoder_model.int8.onnx, decoder_model.int8.onnx, decoder_with_past_model.int8.onnx,
     *  tokens.txt (one BPE token per line, line number = token id) */
    QuranModel(java.io.File dir) throws Exception {
        OrtSession.SessionOptions o = new OrtSession.SessionOptions();
        o.setIntraOpNumThreads(Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors())));
        o.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        encoder = env.createSession(new java.io.File(dir, "encoder_model.int8.onnx").getPath(), o);
        decoder = env.createSession(new java.io.File(dir, "decoder_model.int8.onnx").getPath(), o);
        decoderWithPast = env.createSession(new java.io.File(dir, "decoder_with_past_model.int8.onnx").getPath(), o);
        InputStream tokens = new java.io.FileInputStream(new java.io.File(dir, "tokens.txt"));
        List<String> v = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(tokens, StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) v.add(line);
        }
        vocab = v.toArray(new String[0]);
        for (int i = 0; i < N_FFT; i++) window[i] = (float) (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N_FFT));   // periodic Hann
        // GPT-2 byte-level BPE: each byte is written as a printable character
        int n = 0; boolean[] direct = new boolean[256];
        for (int b = '!'; b <= '~'; b++) direct[b] = true;
        for (int b = 0xA1; b <= 0xAC; b++) direct[b] = true;
        for (int b = 0xAE; b <= 0xFF; b++) direct[b] = true;
        java.util.Arrays.fill(byteOf, -1);
        for (int b = 0; b < 256; b++) { if (direct[b]) byteOf[b] = b; else byteOf[256 + n++] = b; }
    }

    /** the Quran text in this audio (16 kHz mono, at most 30 s; longer is cut to its last 30 s) */
    String transcribe(float[] audio) throws OrtException {
        float[] feats = logMel(audio);
        Map<String, OnnxTensor> past = new HashMap<>();
        List<Long> ids = new ArrayList<>(List.of(SOT, AR, TRANSCRIBE, NO_TIMESTAMPS));
        try (OnnxTensor in = OnnxTensor.createTensor(env, FloatBuffer.wrap(feats), new long[]{1, N_MELS, FRAMES});
             OrtSession.Result enc = encoder.run(Map.of("input_features", in));   // closing it closes its output too
             OnnxTensor first = ids(ids)) {
            OnnxTensor hidden = (OnnxTensor) enc.get(0);
            // first step: the whole prompt; it also returns the cross-attention keys/values used for every later step
            long next;
            OrtSession.Result r = decoder.run(Map.of("input_ids", first, "encoder_hidden_states", hidden));
            try {
                next = argmax((OnnxTensor) r.get(0), true);
                keep(r, past, true);
            } finally { r.close(); }
            for (int step = 0; step < MAX_TOKENS && next != EOT; step++) {
                ids.add(next);
                Map<String, OnnxTensor> in2 = new HashMap<>(past);
                try (OnnxTensor one = ids(List.of(next))) {
                    in2.put("input_ids", one);
                    OrtSession.Result r2 = decoderWithPast.run(in2);
                    try {
                        next = argmax((OnnxTensor) r2.get(0), false);
                        keep(r2, past, false);
                    } finally { r2.close(); }
                }
            }
        } finally {
            for (OnnxTensor t : past.values()) t.close();
        }
        return detokenize(ids.subList(4, ids.size()));
    }

    private OnnxTensor ids(List<Long> ids) throws OrtException {
        long[] a = new long[ids.size()];
        for (int i = 0; i < a.length; i++) a[i] = ids.get(i);
        return OnnxTensor.createTensor(env, LongBuffer.wrap(a), new long[]{1, a.length});
    }

    /** take the present.* outputs as the next step's past_key_values.* (copied: the result is closed after) */
    private void keep(OrtSession.Result r, Map<String, OnnxTensor> past, boolean firstStep) throws OrtException {
        for (Map.Entry<String, ai.onnxruntime.OnnxValue> e : r) {
            String name = e.getKey();
            if (!name.startsWith("present.")) continue;
            if (!firstStep && name.endsWith(".encoder.key") || !firstStep && name.endsWith(".encoder.value")) continue;
            OnnxTensor t = (OnnxTensor) e.getValue();
            long[] shape = t.getInfo().getShape();
            FloatBuffer src = t.getFloatBuffer();
            float[] copy = new float[src.remaining()];
            src.get(copy);
            String key = "past_key_values." + name.substring("present.".length());
            OnnxTensor old = past.put(key, OnnxTensor.createTensor(env, FloatBuffer.wrap(copy), shape));
            if (old != null) old.close();
        }
    }

    /** the most likely next token (at the first step, never end-of-text or a space) */
    private static long argmax(OnnxTensor logits, boolean firstStep) throws OrtException {
        long[] shape = logits.getInfo().getShape();       // [1, steps, vocab]
        int vocabN = (int) shape[2], steps = (int) shape[1];
        FloatBuffer b = logits.getFloatBuffer();
        int off = (steps - 1) * vocabN, best = 0; float bv = -Float.MAX_VALUE;
        for (int i = 0; i < vocabN; i++) {
            if (firstStep && (i == 220 || i == EOT)) continue;
            if (i >= EOT && i != EOT) continue;              // special tokens (language, task, timestamps…) are never text
            float v = b.get(off + i);
            if (v > bv) { bv = v; best = i; }
        }
        return best;
    }

    private String detokenize(List<Long> ids) {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        for (long id : ids) {
            if (id < 0 || id >= vocab.length || id >= EOT) continue;
            String t = vocab[(int) id];
            for (int k = 0; k < t.length(); k++) {
                int c = t.charAt(k);
                int b = c < byteOf.length ? byteOf[c] : -1;
                if (b >= 0) out.write(b);
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8).trim();
    }

    // ---------- Whisper's log-mel spectrogram ----------

    /** 80 x 3000 log-mel features of the audio padded (or cut) to 30 s, exactly as Whisper computes them */
    float[] logMel(float[] audio) {
        float[] x = new float[SAMPLES];
        int n = Math.min(audio.length, SAMPLES), from = audio.length - n;
        System.arraycopy(audio, from, x, 0, n);
        // centre the frames: reflect-pad by n_fft/2 on both sides
        int pad = N_FFT / 2;
        float[] p = new float[SAMPLES + 2 * pad];
        System.arraycopy(x, 0, p, pad, SAMPLES);
        for (int i = 0; i < pad; i++) { p[pad - 1 - i] = x[i + 1]; p[pad + SAMPLES + i] = x[SAMPLES - 2 - i]; }
        int bins = N_FFT / 2 + 1;
        float[] out = new float[N_MELS * FRAMES];
        double[] re = new double[bins], im = new double[bins], power = new double[bins];
        double[] cos = new double[N_FFT], sin = new double[N_FFT];
        for (int k = 0; k < N_FFT; k++) { cos[k] = Math.cos(2 * Math.PI * k / N_FFT); sin[k] = Math.sin(2 * Math.PI * k / N_FFT); }
        float[] frame = new float[N_FFT];
        double max = -Double.MAX_VALUE;
        for (int f = 0; f < FRAMES; f++) {
            int s = f * HOP;
            boolean silent = true;
            for (int i = 0; i < N_FFT; i++) { frame[i] = p[s + i] * window[i]; if (frame[i] != 0) silent = false; }
            if (silent) {                                  // the padding after the audio: nothing to compute
                for (int m = 0; m < N_MELS; m++) out[m * FRAMES + f] = -10f;
                continue;
            }
            dft(frame, re, im, cos, sin);
            for (int k = 0; k < bins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
            for (int m = 0; m < N_MELS; m++) {
                double acc = 0; float[] w = mel[m];
                for (int k = 0; k < bins; k++) if (w[k] != 0) acc += w[k] * power[k];
                double v = Math.log10(Math.max(acc, 1e-10));
                out[m * FRAMES + f] = (float) v;
                if (v > max) max = v;
            }
        }
        float floor = (float) (max - 8.0);
        for (int i = 0; i < out.length; i++) out[i] = (Math.max(out[i], floor) + 4f) / 4f;
        return out;
    }

    /** real DFT of a 400-sample frame (400 = 16·25: a direct O(n²) sum per bin is fast enough here, ~25 ms/s on a phone) */
    private static void dft(float[] x, double[] re, double[] im, double[] cos, double[] sin) {
        int n = x.length;
        for (int k = 0; k < re.length; k++) {
            double a = 0, b = 0; int idx = 0;
            for (int t = 0; t < n; t++) {
                a += x[t] * cos[idx]; b -= x[t] * sin[idx];
                idx += k; if (idx >= n) idx -= n;
            }
            re[k] = a; im[k] = b;
        }
    }

    /** librosa.filters.mel(sr=16000, n_fft=400, n_mels=80) — Slaney mel scale, Slaney normalisation (what Whisper uses) */
    static float[][] melFilters() {
        int bins = N_FFT / 2 + 1;
        double fmin = 0, fmax = RATE / 2.0;
        double[] fftFreqs = new double[bins];
        for (int i = 0; i < bins; i++) fftFreqs[i] = i * (double) RATE / N_FFT;
        double mMin = hzToMel(fmin), mMax = hzToMel(fmax);
        double[] pts = new double[N_MELS + 2];
        for (int i = 0; i < pts.length; i++) pts[i] = melToHz(mMin + (mMax - mMin) * i / (N_MELS + 1));
        float[][] w = new float[N_MELS][bins];
        for (int m = 0; m < N_MELS; m++) {
            double lo = pts[m], c = pts[m + 1], hi = pts[m + 2], enorm = 2.0 / (hi - lo);
            for (int k = 0; k < bins; k++) {
                double up = (fftFreqs[k] - lo) / (c - lo), down = (hi - fftFreqs[k]) / (hi - c);
                w[m][k] = (float) (Math.max(0, Math.min(up, down)) * enorm);
            }
        }
        return w;
    }
    private static double hzToMel(double f) {
        double fSp = 200.0 / 3, minLogHz = 1000.0, minLogMel = minLogHz / fSp, logstep = Math.log(6.4) / 27.0;
        return f < minLogHz ? f / fSp : minLogMel + Math.log(f / minLogHz) / logstep;
    }
    private static double melToHz(double m) {
        double fSp = 200.0 / 3, minLogHz = 1000.0, minLogMel = minLogHz / fSp, logstep = Math.log(6.4) / 27.0;
        return m < minLogMel ? fSp * m : minLogHz * Math.exp(logstep * (m - minLogMel));
    }

    @Override public void close() throws OrtException {
        encoder.close(); decoder.close(); decoderWithPast.close();
    }
}
