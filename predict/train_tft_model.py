# predict/train_tft_model.py
#
# THE ALL-IN-ONE, BULLETPROOF TFT TRAINING SCRIPT
# – Loads your graph, simulates time-series,
# – Builds & trains a TemporalFusionTransformer,
# – No external dependencies beyond requirements.txt

import os
import pickle
import random
import pandas as pd
import torch

from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer
from pytorch_forecasting.metrics import QuantileLoss
from pytorch_forecasting.data import GroupNormalizer
from pytorch_lightning import Trainer
from pytorch_lightning.callbacks import EarlyStopping, ModelCheckpoint

# ─── CONFIGURATION ───────────────────────────────────────────────────────────
GRAPH_PATH      = "artifacts/hetero_graph_with_embeddings.gpickle"
HISTORICAL_DAYS = 90
MAX_ENCODER_LEN = 24
MAX_PRED_LEN    = 12
BATCH_SIZE      = 64
MAX_EPOCHS      = 15
TARGET_COL      = "star_count"
TIME_COL        = "time_idx"
GROUP_COL       = "project_id"
OUTPUT_DIR      = "artifacts"
CHECKPOINT_FN   = "tft_model.ckpt"
# ──────────────────────────────────────────────────────────────────────────────

def prepare_timeseries_df():
    """Load graph; simulate per-project star history; return a tidy Pandas DataFrame."""
    if not os.path.exists(GRAPH_PATH):
        raise FileNotFoundError(f"Graph not found at {GRAPH_PATH}")
    with open(GRAPH_PATH, "rb") as f:
        G = pickle.load(f)
    records = []
    for node_id, data in G.nodes(data=True):
        if data.get("node_type") != "Project":
            continue
        # simulate backward growth
        base = data.get("stars", 1000) or 1000
        rate = random.uniform(1.005, 1.02)
        cur = float(base)
        hist = []
        for _ in range(HISTORICAL_DAYS):
            hist.append(cur)
            cur /= (rate + random.uniform(-0.001, 0.001))
        for idx, val in enumerate(reversed(hist)):
            records.append({
                GROUP_COL: str(node_id),
                TIME_COL: idx,
                TARGET_COL: float(val),
            })
    if not records:
        raise RuntimeError("No Project nodes found to simulate.")
    df = pd.DataFrame(records)
    # enforce types
    df[GROUP_COL] = df[GROUP_COL].astype("category")
    df[TIME_COL]  = df[TIME_COL].astype("int32")
    df[TARGET_COL] = df[TARGET_COL].astype("float32")
    return df

def train_tft(df: pd.DataFrame):
    """Given a time-series DataFrame, build and train the TFT model."""
    # build dataset
    cutoff = df[TIME_COL].max() - MAX_PRED_LEN
    training = TimeSeriesDataSet(
        df[df[TIME_COL] <= cutoff],
        time_idx=TIME_COL,
        target=TARGET_COL,
        group_ids=[GROUP_COL],
        max_encoder_length=MAX_ENCODER_LEN,
        max_prediction_length=MAX_PRED_LEN,
        time_varying_known_reals=[TIME_COL],
        time_varying_unknown_reals=[TARGET_COL],
        target_normalizer=GroupNormalizer(groups=[GROUP_COL]),
        add_relative_time_idx=True,
        add_target_scales=True,
        add_encoder_length=True,
    )
    validation = TimeSeriesDataSet.from_dataset(training, df, predict=True, stop_randomization=True)

    train_dl = training.to_dataloader(train=True, batch_size=BATCH_SIZE, num_workers=0)
    val_dl   = validation.to_dataloader(train=False, batch_size=BATCH_SIZE, num_workers=0)

    # instantiate model
    tft = TemporalFusionTransformer.from_dataset(
        training,
        learning_rate=1e-3,
        hidden_size=16,
        attention_head_size=1,
        dropout=0.1,
        loss=QuantileLoss(),
        log_interval=10,
        reduce_on_plateau_patience=4,
    )

    # callbacks
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    ckpt_path = os.path.join(OUTPUT_DIR, CHECKPOINT_FN)
    checkpoint_cb = ModelCheckpoint(
        dirpath=OUTPUT_DIR,
        filename=os.path.splitext(CHECKPOINT_FN)[0],
        save_top_k=1,
        monitor="val_loss",
        mode="min"
    )
    early_stop_cb = EarlyStopping(monitor="val_loss", patience=3, mode="min")

    # trainer
    trainer = Trainer(
        max_epochs=MAX_EPOCHS,
        accelerator="cpu",
        logger=False,
        callbacks=[checkpoint_cb, early_stop_cb],
        enable_progress_bar=True,
        gradient_clip_val=0.1
    )

    trainer.fit(tft, train_dataloaders=train_dl, val_dataloaders=val_dl)
    print(f"✅ Training complete. Checkpoint saved to {ckpt_path}")

if __name__ == "__main__":
    print("🚀 OPAL TFT Training Starting")
    df = prepare_timeseries_df()
    print(f"📊 Prepared {len(df)} rows.")
    train_tft(df)
