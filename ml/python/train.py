"""Train the Revealyst prompt-scorer-v1 (spec §5.2) — mean-pooling variant.

Model: microsoft's MiniLM-L6 (sentence-transformers/all-MiniLM-L6-v2) encoder,
followed by a masked **mean pool** over token embeddings and a linear 6-output
head with sigmoid. The mean pool matches exactly what the adapter computes at
runtime (transformers.js `pooling: "mean"`), so the trained head.json works
against the exported ONNX encoder with no feature mismatch.

Output contract (matches OnnxScoringAdapter.scoreWithHead):
    [overall, specificity, context, role_clarity, output_format,
     examples_included]  — values in 0..1 (probability scale).

Training labels are rule-engine scores (distillation): the model reproduces
rule behavior fully on-device until human-labeled beta data exists.

Usage (takes ~45-60 min on CPU):
    python ml/python/train.py [--epochs 6] [--batch-size 16] [--lr 2e-5]
                              [--max-length 256] [--patience 3] [--seed 42]
                              [--output ml/models/prompt-scorer-v1]
"""

from __future__ import annotations

import argparse
import json
import random
import time

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModel, AutoTokenizer

# Order must match the adapter contract and DIMENSIONS in packages/scoring.
DIM_ORDER = ["specificity", "context", "role_clarity", "output_format", "examples_included"]
BASE_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
HIDDEN = 384


class MeanPooledScorer(nn.Module):
    """MiniLM encoder + masked mean pool + linear head + sigmoid."""

    def __init__(self, backbone: nn.Module):
        super().__init__()
        self.backbone = backbone
        self.head = nn.Linear(HIDDEN, len(DIM_ORDER) + 1)

    def forward(self, input_ids, attention_mask, token_type_ids=None):
        hidden = self.backbone(
            input_ids=input_ids,
            attention_mask=attention_mask,
            token_type_ids=token_type_ids,
        ).last_hidden_state  # [B, S, H]
        mask = attention_mask.unsqueeze(-1)  # [B, S, 1]
        pooled = (hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)  # [B, H]
        return torch.sigmoid(self.head(pooled))  # [B, 6]


def load_rows(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def target_vector(row: dict) -> np.ndarray:
    breakdown = row["breakdown"]
    return np.array(
        [row["score"] / 100.0] + [breakdown[d] / 100.0 for d in DIM_ORDER],
        dtype=np.float32,
    )


class PromptDataset(Dataset):
    def __init__(self, rows: list[dict], tokenizer, max_length: int):
        self.targets = torch.from_numpy(np.stack([target_vector(r) for r in rows]))
        self.encodings = tokenizer(
            [r["prompt"] for r in rows],
            padding="max_length",
            truncation=True,
            max_length=max_length,
            return_tensors="pt",
        )

    def __len__(self) -> int:
        return len(self.targets)

    def __getitem__(self, i: int):
        return {
            "input_ids": self.encodings["input_ids"][i],
            "attention_mask": self.encodings["attention_mask"][i],
            "token_type_ids": self.encodings["token_type_ids"][i],
            "labels": self.targets[i],
        }


@torch.no_grad()
def eval_mae(model: nn.Module, loader: DataLoader, device: torch.device) -> dict[str, float]:
    model.eval()
    mae = np.zeros(6, dtype=np.float64)
    count = 0
    for batch in loader:
        preds = model(
            input_ids=batch["input_ids"].to(device),
            attention_mask=batch["attention_mask"].to(device),
            token_type_ids=batch["token_type_ids"].to(device),
        ).cpu().numpy() * 100.0
        mae += np.abs(preds - batch["labels"].numpy() * 100.0).sum(axis=0)
        count += len(batch["labels"])
    mae /= max(count, 1)
    names = ["overall"] + DIM_ORDER
    return {n: float(v) for n, v in zip(names, mae, strict=True)} | {"mean": float(mae.mean())}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train", default="ml/data/corpus.jsonl")
    parser.add_argument("--eval", default="ml/data/eval.jsonl")
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--lr", type=float, default=2e-5)
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--patience", type=int, default=3)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", default="ml/models/prompt-scorer-v1")
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    device = torch.device("cpu")
    train_rows = load_rows(args.train)
    eval_rows = load_rows(args.eval)
    print(f"[train] device={device} base={BASE_MODEL} train={len(train_rows)} eval={len(eval_rows)}")

    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    backbone = AutoModel.from_pretrained(BASE_MODEL)
    model = MeanPooledScorer(backbone).to(device)

    train_ds = PromptDataset(train_rows, tokenizer, args.max_length)
    eval_ds = PromptDataset(eval_rows, tokenizer, args.max_length)
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True)
    eval_loader = DataLoader(eval_ds, batch_size=args.batch_size, shuffle=False)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    steps_per_epoch = len(train_loader)
    total_steps = steps_per_epoch * args.epochs
    from transformers import get_linear_schedule_with_warmup

    scheduler = get_linear_schedule_with_warmup(
        optimizer, num_warmup_steps=int(0.1 * total_steps), num_training_steps=total_steps
    )

    best = {"mae": float("inf"), "state": None}
    patience_left = args.patience
    for epoch in range(1, args.epochs + 1):
        model.train()
        running = 0.0
        n = 0
        t0 = time.time()
        for batch in train_loader:
            labels = batch["labels"].to(device)
            preds = model(
                input_ids=batch["input_ids"].to(device),
                attention_mask=batch["attention_mask"].to(device),
                token_type_ids=batch["token_type_ids"].to(device),
            )
            loss = nn.functional.mse_loss(preds, labels)
            loss.backward()
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad()
            running += loss.item() * len(labels)
            n += len(labels)
        metrics = eval_mae(model, eval_loader, device)
        train_mse = running / max(n, 1)
        print(
            f"[train] epoch {epoch}/{args.epochs} train_mse={train_mse:.5f} "
            f"eval_mean_mae={metrics['mean']:.2f} overall_mae={metrics['overall']:.2f} "
            f"({time.time() - t0:.0f}s)"
        )
        if metrics["mean"] < best["mae"]:
            best = {"mae": metrics["mean"], "state": {k: v.clone() for k, v in model.state_dict().items()}}
            patience_left = args.patience
            print(f"[train] new best eval mean MAE = {best['mae']:.2f} pts")
        else:
            patience_left -= 1
            if patience_left <= 0:
                print(f"[train] early stop after {epoch} epochs")
                break

    assert best["state"] is not None
    model.load_state_dict(best["state"])
    final = eval_mae(model, eval_loader, device)
    print(f"[train] best checkpoint eval: mean_mae={final['mean']:.2f} overall={final['overall']:.2f}")

    # Persist: head.json (runtime artifact) + fine-tuned backbone (for ONNX re-export).
    # rules_rev MUST match RULES_REVISION in packages/scoring/src/rules.ts — the
    # OnnxScoringAdapter rejects a head whose rules_rev is stale, so a model
    # retrained against the current heuristics is the only one that runs.
    # Rev 4: business-genre task kind + vague-object detection (see rules.ts).
    head = {
        "weight": model.head.weight.detach().cpu().numpy().tolist(),
        "bias": model.head.bias.detach().cpu().numpy().tolist(),
        "pooling": "mean",
        "activation": "sigmoid",
        "dim_names": ["overall"] + DIM_ORDER,
        "rules_rev": 4,
    }
    head_path = f"{args.output}/head.json"
    with open(head_path, "w", encoding="utf-8") as f:
        json.dump(head, f)
    print(f"[train] wrote {head_path}")

    backbone_dir = f"{args.output}/checkpoint/backbone"
    model.backbone.save_pretrained(backbone_dir)
    tokenizer.save_pretrained(backbone_dir)
    print(f"[train] saved fine-tuned backbone -> {backbone_dir}")
    print("[train] done")


if __name__ == "__main__":
    main()
