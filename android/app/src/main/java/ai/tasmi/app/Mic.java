package ai.tasmi.app;

import android.annotation.SuppressLint;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;

import java.io.IOException;
import java.io.OutputStream;

/**
 * The microphone, recorded by the app itself from Start to Stop — it never pauses, not even when the reciter breathes
 * between ayat. Audio is kept in a ring buffer and streamed into the recogniser's session through a pipe; when the
 * recogniser starts a new session, the audio it missed meanwhile is replayed first, so no word is lost.
 */
final class Mic {
    static final int RATE = 16000;                       // 16 kHz mono 16-bit PCM
    private static final int BYTES_PER_MS = RATE * 2 / 1000;
    private static final int RING = RATE * 2 * 8;        // 8 s of audio
    private static final int REPLAY_MS = 3000;           // replay at most this much into a new session
    private static final int OVERLAP_MS = 1000;

    private final byte[] ring = new byte[RING];
    private long written;                                // total bytes recorded (position in the ring = written % RING)
    private long consumed;                               // bytes already sent to a session
    private AudioRecord rec;
    private Thread capture, feeder;
    private volatile boolean running;
    private volatile OutputStream sink;                  // the current session's pipe
    private ParcelFileDescriptor readSide;
    private volatile long lastLoud;                      // when the reciter's voice was last heard (by level)

    @SuppressLint("MissingPermission")
    boolean start() {
        if (running) return true;
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) return false;
        try {
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE * 2));
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) { rec.release(); rec = null; return false; }
            rec.startRecording();
        } catch (Exception e) {
            if (rec != null) { try { rec.release(); } catch (Exception ignored) { } rec = null; }
            return false;
        }
        running = true;
        synchronized (ring) { written = 0; consumed = 0; }
        capture = new Thread(this::captureLoop, "tasmi-mic");
        capture.start();
        feeder = new Thread(this::feedLoop, "tasmi-feed");
        feeder.start();
        return true;
    }

    void stop() {
        running = false;
        endSession();
        if (rec != null) {
            try { rec.stop(); } catch (Exception ignored) { }
            try { rec.release(); } catch (Exception ignored) { }
            rec = null;
        }
        synchronized (ring) { ring.notifyAll(); }
        capture = null; feeder = null;
    }

    boolean running() { return running; }

    /** ms since the reciter's voice was last loud enough to be speech */
    long quietMs() { return lastLoud == 0 ? Long.MAX_VALUE : SystemClock.elapsedRealtime() - lastLoud; }

    /** a pipe for a new recogniser session: the read side goes to the recogniser (EXTRA_AUDIO_SOURCE) */
    ParcelFileDescriptor newSession() throws IOException {
        endSession();
        ParcelFileDescriptor[] p = ParcelFileDescriptor.createPipe();
        synchronized (ring) {
            // replay what the previous session missed (the reciter may have started the next ayah meanwhile)
            // and 1 s before it: the old session may not have read the end of what it was sent (a repeated word is fine)
            consumed = Math.max(consumed - (long) OVERLAP_MS * BYTES_PER_MS, written - (long) REPLAY_MS * BYTES_PER_MS);
            consumed = Math.max(consumed, 0);
            consumed = Math.max(consumed, written - RING + 1);
            readSide = p[0];
            sink = new ParcelFileDescriptor.AutoCloseOutputStream(p[1]);
            ring.notifyAll();
        }
        return p[0];
    }

    /** the session is over (its result came, or it failed): stop feeding it; recording carries on */
    void endSession() {
        OutputStream s; ParcelFileDescriptor r;
        synchronized (ring) { s = sink; r = readSide; sink = null; readSide = null; }
        if (s != null) { try { s.close(); } catch (Exception ignored) { } }
        if (r != null) { try { r.close(); } catch (Exception ignored) { } }
    }

    private void captureLoop() {
        byte[] buf = new byte[BYTES_PER_MS * 20];       // 20 ms chunks
        while (running) {
            AudioRecord r = rec;
            if (r == null) break;
            int n = r.read(buf, 0, buf.length);
            if (n <= 0) { if (n < 0) SystemClock.sleep(10); continue; }
            if (level(buf, n) > 900) lastLoud = SystemClock.elapsedRealtime();
            synchronized (ring) {
                for (int i = 0; i < n; i++) ring[(int) ((written + i) % RING)] = buf[i];
                written += n;
                ring.notifyAll();
            }
        }
    }

    private void feedLoop() {
        byte[] out = new byte[BYTES_PER_MS * 40];
        while (running) {
            OutputStream s; int n;
            synchronized (ring) {
                while (running && (sink == null || consumed >= written)) {
                    try { ring.wait(200); } catch (InterruptedException e) { return; }
                }
                if (!running) return;
                s = sink;
                if (consumed < written - RING + 1) consumed = written - RING + 1;   // fell behind: skip the oldest
                n = (int) Math.min(out.length, written - consumed);
                for (int i = 0; i < n; i++) out[i] = ring[(int) ((consumed + i) % RING)];
            }
            try {
                s.write(out, 0, n);                      // blocks while the recogniser is not reading
                synchronized (ring) { if (sink == s) consumed += n; }
            } catch (IOException e) {
                synchronized (ring) { if (sink == s) { sink = null; } }   // the session closed its side
            }
        }
    }

    /** mean absolute amplitude of 16-bit little-endian samples */
    private static int level(byte[] b, int n) {
        long sum = 0; int k = 0;
        for (int i = 0; i + 1 < n; i += 8) { int v = (short) ((b[i] & 0xff) | (b[i + 1] << 8)); sum += Math.abs(v); k++; }
        return k == 0 ? 0 : (int) (sum / k);
    }
}
