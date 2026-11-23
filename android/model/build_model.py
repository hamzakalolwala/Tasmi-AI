"""Build the Quran model files for the Android app (run by .github/workflows/android.yml, cached).

Tarteel's open model tarteel-ai/whisper-tiny-ar-quran (Apache-2.0) → ONNX (Hugging Face Optimum) → int8 weights for
the matrix layers only (the two small convolutions stay float: older ONNX Runtimes can't run int8 convolutions) →
android/app/quran-assets/quran-model/{encoder_model,decoder_model,decoder_with_past_model}.int8.onnx + tokens.txt.

    pip install torch --index-url https://download.pytorch.org/whl/cpu
    pip install "optimum[onnxruntime]" transformers
    python android/model/build_model.py
"""
import json, os, shutil, subprocess, sys, tempfile
from onnxruntime.quantization import quantize_dynamic, QuantType

MODEL = 'tarteel-ai/whisper-tiny-ar-quran'
here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, '..', 'app', 'quran-assets', 'quran-model')
os.makedirs(out, exist_ok=True)
with tempfile.TemporaryDirectory() as tmp:
    subprocess.run(['optimum-cli', 'export', 'onnx', '-m', MODEL, '--task', 'automatic-speech-recognition-with-past', tmp], check=True)
    for n in ['encoder_model', 'decoder_model', 'decoder_with_past_model']:
        quantize_dynamic(os.path.join(tmp, n + '.onnx'), os.path.join(out, n + '.int8.onnx'),
                         weight_type=QuantType.QInt8, op_types_to_quantize=['MatMul', 'Gemm', 'Gather'])
    vocab = json.load(open(os.path.join(tmp, 'vocab.json'), encoding='utf-8'))
    inv = {i: t for t, i in vocab.items()}
    n = max(inv) + 1
    assert all(i in inv for i in range(n)) and not any('\n' in t for t in vocab)
    with open(os.path.join(out, 'tokens.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(inv[i] for i in range(n)) + '\n')
for f in sorted(os.listdir(out)):
    print(f, round(os.path.getsize(os.path.join(out, f)) / 1e6, 1), 'MB')
