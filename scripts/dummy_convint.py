"""A stand-in model containing ConvInteger (as in the real model-int8.onnx), which onnxruntime-web cannot run.
Used to test the app's fallback to the fp32 model."""
import sys, numpy as np, onnx
from onnx import helper, TensorProto, numpy_helper
w = numpy_helper.from_array(np.ones((80, 80, 3), np.int8), 'w')
xz = numpy_helper.from_array(np.array(0, np.uint8), 'xz')
nodes = [helper.make_node('Cast', ['mel'], ['m8'], to=TensorProto.UINT8),
         helper.make_node('ConvInteger', ['m8', 'w', 'xz'], ['c'], pads=[1, 1], name='/conv1/Conv_quant'),
         helper.make_node('Cast', ['c'], ['cf'], to=TensorProto.FLOAT),
         helper.make_node('Identity', ['cf'], ['logprobs'])]
g = helper.make_graph(nodes, 'convint', [helper.make_tensor_value_info('mel', TensorProto.FLOAT, [1, 80, 'F']),
                                         helper.make_tensor_value_info('riwaya', TensorProto.INT64, [1])],
                      [helper.make_tensor_value_info('logprobs', TensorProto.FLOAT, None)], [w, xz])
m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 17)]); m.ir_version = 8
onnx.save(m, sys.argv[1]); print('ok')
