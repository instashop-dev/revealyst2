"""Export the trained scorer to quantized int8 ONNX for Transformers.js.

The runtime contract is:
  - encoder: raw MiniLM BertModel, output `last_hidden_state` [B, S, 384]
    (mean-pooled + head applied by OnnxScoringAdapter in JS),
  - head:    head.json (written by train.py) — linear + sigmoid over the
    mean-pooled embedding.

Steps:
  1. Load the fine-tuned backbone (ml/models/prompt-scorer-v1/checkpoint/backbone).
  2. torch.onnx.export -> ml/models/prompt-scorer-v1/onnx/model.onnx (fp32,
     gitignored).
  3. onnxruntime dynamic int8 quantization ->
     ml/models/prompt-scorer-v1/onnx/model_quantized.onnx (committed artifact).
  4. Copy tokenizer + config next to the artifact so @xenova/transformers can
     load it from a bare URL.

Usage:
    python ml/python/export_onnx.py [--backbone ml/models/prompt-scorer-v1/checkpoint/backbone]
                                    [--artifact ml/models/prompt-scorer-v1]
"""

from __future__ import annotations

import argparse
import os

import onnxruntime
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModel, AutoTokenizer


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backbone", default="ml/models/prompt-scorer-v1/checkpoint/backbone")
    parser.add_argument("--artifact", default="ml/models/prompt-scorer-v1")
    parser.add_argument("--opset", type=int, default=14)
    args = parser.parse_args()

    os.makedirs(os.path.join(args.artifact, "onnx"), exist_ok=True)

    tokenizer = AutoTokenizer.from_pretrained(args.backbone)
    model = AutoModel.from_pretrained(args.backbone)
    model.eval()

    sample = tokenizer(
        "Write a product launch email for our new AI assistant",
        return_tensors="pt",
        padding="max_length",
        truncation=True,
        max_length=256,
    )
    fp32_path = os.path.join(args.artifact, "onnx", "model.onnx")
    torch.onnx.export(
        model,
        (sample["input_ids"], sample["attention_mask"], sample["token_type_ids"]),
        fp32_path,
        input_names=["input_ids", "attention_mask", "token_type_ids"],
        output_names=["last_hidden_state"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "sequence"},
            "attention_mask": {0: "batch", 1: "sequence"},
            "token_type_ids": {0: "batch", 1: "sequence"},
            "last_hidden_state": {0: "batch", 1: "sequence"},
        },
        opset_version=args.opset,
        # Legacy (TorchScript) exporter: the dynamo exporter requires onnxscript
        # and its verbose progress prints crash on cp1252 consoles.
        dynamo=False,
    )
    print(f"[export] fp32 ONNX -> {fp32_path} ({os.path.getsize(fp32_path) / 1e6:.1f} MB)")

    int8_path = os.path.join(args.artifact, "onnx", "model_quantized.onnx")
    quantize_dynamic(fp32_path, int8_path, weight_type=QuantType.QInt8)
    print(f"[export] int8 ONNX -> {int8_path} ({os.path.getsize(int8_path) / 1e6:.1f} MB)")

    # Smoke: run one inference through the quantized graph.
    sess = onnxruntime.InferenceSession(int8_path, providers=["CPUExecutionProvider"])
    feeds = {k: v.numpy() for k, v in sample.items()}
    out = sess.run(None, feeds)[0]
    print(f"[export] smoke output shape={out.shape}")

    # Tokenizer + config travel with the artifact (Transformers.js needs them).
    tokenizer.save_pretrained(args.artifact)
    model.config.save_pretrained(args.artifact)
    print(f"[export] config + tokenizer files copied -> {args.artifact}")
    print("[export] done")


if __name__ == "__main__":
    main()
