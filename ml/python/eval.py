"""Evaluate the quantized ONNX artifact against the rule-labeled eval split.

Mirrors the production path exactly: int8 ONNX encoder -> masked mean pooling
(same math as transformers.js `pooling: "mean"`) -> head.json (linear +
sigmoid) -> 0..100 scores. Measures how faithfully the model distills the rule
engine:
  - per-dimension + overall MAE (score points),
  - overall-score correlation,
  - single-shot CPU latency (median, p95).

Usage:
    python ml/python/eval.py [--eval ml/data/eval.jsonl]
                             [--artifact ml/models/prompt-scorer-v1]
                             [--limit 1500]
"""

from __future__ import annotations

import argparse
import json
import statistics
import time

import numpy as np
import onnxruntime
from transformers import AutoTokenizer

DIM_ORDER = ["specificity", "context", "role_clarity", "output_format", "examples_included"]


def mean_pool(hidden: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Masked mean pooling over the sequence dim (matches transformers.js)."""
    mask = mask.astype(np.float32)[:, :, None]
    return (hidden * mask).sum(axis=1) / mask.sum(axis=1).clip(min=1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--eval", default="ml/data/eval.jsonl")
    parser.add_argument("--artifact", default="ml/models/prompt-scorer-v1")
    parser.add_argument("--limit", type=int, default=1500)
    args = parser.parse_args()

    with open(args.eval, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    rows = rows[: args.limit]

    tokenizer = AutoTokenizer.from_pretrained(args.artifact)
    sess = onnxruntime.InferenceSession(
        f"{args.artifact}/onnx/model_quantized.onnx", providers=["CPUExecutionProvider"]
    )
    with open(f"{args.artifact}/head.json", encoding="utf-8") as f:
        head = json.load(f)
    weight = np.array(head["weight"], dtype=np.float32)  # [6, 384]
    bias = np.array(head["bias"], dtype=np.float32)  # [6]

    preds: list[np.ndarray] = []
    targets: list[np.ndarray] = []
    latencies: list[float] = []
    for row in rows:
        enc = tokenizer(row["prompt"], return_tensors="np", truncation=True, max_length=256)
        t0 = time.perf_counter()
        hidden = sess.run(None, dict(enc))[0]  # [1, S, 384]
        pooled = mean_pool(hidden, enc["attention_mask"])  # [1, 384]
        logits = pooled @ weight.T + bias  # [1, 6]
        out = 100.0 / (1.0 + np.exp(-logits))  # [1, 6]
        latencies.append((time.perf_counter() - t0) * 1000)
        preds.append(out[0])
        targets.append(
            np.array(
                [row["score"]] + [row["breakdown"][d] for d in DIM_ORDER],
                dtype=np.float32,
            )
        )

    preds = np.stack(preds)
    targets = np.stack(targets)
    mae = np.abs(preds - targets).mean(axis=0)
    names = ["overall"] + DIM_ORDER
    print("[eval] MAE vs rule labels (score points):")
    for name, value in zip(names, mae, strict=True):
        print(f"  {name:16s} {value:6.2f}")
    print(f"  {'mean':16s} {mae.mean():6.2f}")

    corr = np.corrcoef(preds[:, 0], targets[:, 0])[0, 1]
    print(f"[eval] overall-score Pearson r = {corr:.3f}")
    print(
        f"[eval] latency ms: median={statistics.median(latencies):.1f} "
        f"p95={sorted(latencies)[int(len(latencies) * 0.95)]:.1f} "
        f"max={max(latencies):.1f}"
    )


if __name__ == "__main__":
    main()
