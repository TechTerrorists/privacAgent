export interface NerCapability {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly backend: 'onnx';
  readonly labels: readonly string[];
  readonly measuredMicroRecall: number;
  readonly measurementSource: string;
}

export const RECALL_TARGET = 0.98;

export const RUN3_NER_CAPABILITY: NerCapability = {
  modelId: 'privacagent-pii-ner',
  modelVersion: 'run3',
  backend: 'onnx',
  labels: ['NAME', 'ADDRESS', 'ORG', 'LOCATION', 'DOB'],
  measuredMicroRecall: 0.3024,
  measurementSource:
    'held-out test set, quantized ONNX (model.quant.onnx), token-level micro recall; see packages/models/pii-ner/artifacts/run3/quantized_onnx_test_recall.json. D-08 issue states a corrected 0.1334 for the same artifact, not reproduced here.',
};

export function meetsCoverageThreshold(
  capability: NerCapability,
  target: number = RECALL_TARGET
): boolean {
  return capability.measuredMicroRecall >= target;
}
