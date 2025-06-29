# predict/train_tft_model.py
#
# FINAL BULLETPROOF TFT TRAINER
# Now wraps the TFT in a LightningModule so Trainer accepts it directly

import os
import pickle
import random
import pandas as pd
import torch

from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer
from pytorch_forecasting.metrics import QuantileLoss
from pytorch_forecasting.data import GroupNormalizer
from pytorch_lightning import Trainer, LightningModule
from pytorch_lightning.callbacks import EarlyStopping, ModelCheckpoint

# ─── CONFIGURATION ───────────────────────────────────────────────────────────
GRAPH_PATH      = "artifacts/hetero_graph_with_embeddings.gpickle"
DATA_PATH       = "artifacts/timeseries_data.parquet"
OUTPUT_DIR      = "artifacts"
CHECKPOINT_FN   = "tft_model.ckpt"
HISTORICAL_DAYS = 90
MAX_ENCODER_LEN = 24
MAX_PRED_LEN    = 12
BATCH_SIZE      = 64
MAX_EPOCHS      = 15
TARGET_COL      = "star_count"
TIME_COL        = "time_idx"
GROUP_COL       = "series_id"  # ✅ FIXED
# ──────────────────────────────────────────────────────────────────────────────

def prepare_timeseries_df():
    """Load graph; simulate per-project star history; return a DataFrame."""
    if not os.path.exists(GRAPH_PATH):
        raise FileNotFoundError(f"Graph not found at {GRAPH_PATH}")
    with open(GRAPH_PATH, "rb") as f:
        G = pickle.load(f)
    records = []
    for node_id, data in G.nodes(data=True):
        if data.get("node_type") != "Project":
            continue
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
        raise RuntimeError("No project nodes found.")
    df = pd.DataFrame(records)
    df[GROUP_COL] = df[GROUP_COL].astype("category")
    df[TIME_COL]  = df[TIME_COL].astype("int32")
    df[TARGET_COL] = df[TARGET_COL].astype("float32")
    df.to_parquet(DATA_PATH, index=False)
    return df

class TFTModule(LightningModule):
    def __init__(self, dataset):
        super().__init__()
        self.save_hyperparameters(ignore=['loss', 'logging_metrics'])
        self.tft = TemporalFusionTransformer.from_dataset(
            dataset,
            learning_rate=1e-3,
            hidden_size=16,
            attention_head_size=1,
            dropout=0.1,
            loss=QuantileLoss(),
            log_interval=10,
            reduce_on_plateau_patience=4,
        )

    def forward(self, x):
        return self.tft(x)

    def training_step(self, batch, batch_idx):
        x, y = batch
        out = self.tft(x)
        y_pred = out[0] if isinstance(out, tuple) else out
        loss = self.tft.loss(y_pred, y)
        self.log("train_loss", loss, prog_bar=True)
        return loss

    def validation_step(self, batch, batch_idx):
        x, y = batch
        out = self.tft(x)
        y_pred = out[0] if isinstance(out, tuple) else out
        loss = self.tft.loss(y_pred, y)
        self.log("val_loss", loss, prog_bar=True)
        return loss

    def configure_optimizers(self):
        return self.tft.configure_optimizers()

def train_tft_model():
    print("🚀 Starting TFT model training...")

    # prepare or load data
    if not os.path.exists(DATA_PATH):
        print(f"📂 {DATA_PATH} missing. Generating it from graph...")
        df = prepare_timeseries_df()
    else:
        print(f"📥 Loading existing time-series data from {DATA_PATH}")
        df = pd.read_parquet(DATA_PATH)

    # build datasets
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

    # wrap in LightningModule
    model = TFTModule(training)

    # callbacks
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    checkpoint_cb = ModelCheckpoint(
        dirpath=OUTPUT_DIR,
        filename=os.path.splitext(CHECKPOINT_FN)[0],
        monitor="val_loss",
        save_top_k=1,
        mode="min",
    )
    earlystop_cb = EarlyStopping(monitor="val_loss", patience=3, mode="min")

    # trainer
    trainer = Trainer(
        max_epochs=MAX_EPOCHS,
        accelerator="cpu",
        logger=False,
        callbacks=[earlystop_cb, checkpoint_cb],
        enable_progress_bar=True,
        gradient_clip_val=0.1
    )

    trainer.fit(model, train_dataloaders=train_dl, val_dataloaders=val_dl)
    print(f"✅ TFT training complete. Checkpoint in {OUTPUT_DIR}/{CHECKPOINT_FN}")

if __name__ == "__main__":
    train_tft_model()
