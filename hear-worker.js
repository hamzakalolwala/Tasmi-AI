/* Runs the tajweed model off the main thread: audio (16 kHz mono Float32) -> log-mel -> ONNX -> phonetic script. */
const V = new URL(location.href).searchParams.get('v') || '';
importScripts('engine.js?v=' + V, 'mel.js?v=' + V, 'ort/ort.wasm.min.js');

let session = null, vocab = null, inNames = null, outName = null;

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'hear') postMessage({ type: 'heard', id: m.id, ...(await hear(m.audio, m.riwaya || 0)) });
  } catch (err) {
    postMessage({ type: 'error', id: m.id, stage: m.type, message: String((err && err.message) || err) });
  }
};

async function init(m) {
  vocab = m.vocab;
  ort.env.wasm.wasmPaths = m.ortBase;
  ort.env.wasm.numThreads = 1;
  // try each model in turn: the browser runtime cannot run some quantized layers (ConvInteger), so a model that
  // fails to start is dropped from the cache and the next one (the full-precision export) is used instead
  const urls = [m.modelUrl, ...(m.fallbackUrls || [])];
  let lastErr = null;
  for (let n = 0; n < urls.length; n++) {
    try {
      const bytes = await loadModel(urls[n], m.cacheName, n);
      postMessage({ type: 'progress', stage: 'starting' });
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      inNames = session.inputNames; outName = session.outputNames[0];
      await hear(new Float32Array(16000), 0);   // warm up (also proves the model runs)
      postMessage({ type: 'ready', model: urls[n] });
      return;
    } catch (err) {
      lastErr = err; session = null;
      try { (await caches.open(m.cacheName)).delete(urls[n]); } catch (e) { /* ignore */ }
      if (n + 1 < urls.length) postMessage({ type: 'progress', stage: 'fallback', reason: String((err && err.message) || err).slice(0, 160) });
    }
  }
  throw lastErr;
}

async function loadModel(url, cacheName, attempt = 0) {
  let cache = null;
  try { cache = await caches.open(cacheName); } catch (e) { /* no Cache API: download every time */ }
  if (cache) {
    const hit = await cache.match(url);
    if (hit) { postMessage({ type: 'progress', stage: 'cached' }); return new Uint8Array(await hit.arrayBuffer()); }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error('model download failed: HTTP ' + res.status);
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader(), parts = []; let got = 0, lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (got - lastPost > 512 * 1024) { lastPost = got; postMessage({ type: 'progress', stage: 'download', got, total, attempt }); }
  }
  const bytes = new Uint8Array(got); let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  if (cache) { try { await cache.put(url, new Response(bytes)); } catch (e) { /* storage full: fine */ } }
  return bytes;
}

async function hear(audio, riwaya) {
  const t0 = performance.now();
  const inp = Mel.modelInput(audio);
  const melName = inNames.includes('mel') ? 'mel' : inNames[0];
  const rName = inNames.includes('riwaya') ? 'riwaya' : inNames[1];
  const feeds = { [melName]: new ort.Tensor('float32', inp.mel, [1, 80, inp.frames]) };
  if (rName) feeds[rName] = new ort.Tensor('int64', BigInt64Array.from([BigInt(riwaya)]), [1]);
  const out = await session.run(feeds);
  const lp = out[outName], [, T, V] = lp.dims;
  const r = Engine.ctcDecode(lp.data, T, V, vocab, inp.seconds / T, inp.lead);
  return { text: r.text, probs: r.probs, times: r.times, T, ms: Math.round(performance.now() - t0), seconds: audio.length / 16000 };
}
