# predict/train_tft_model.py
#
# Part of the LEARN LAYER (run weekly)
#
# This is the definitive TFT trainer, based on your more robust LightningModule implementation.

import os
import pandas as pd
import torch
from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer
from pytorch_forecasting.metrics import QuantileLoss
from pytorch_forecasting.data import GroupNormalizer
from pytorch_lightning import Trainer, LightningModule
from pytorch_lightning.callbacks import EarlyStopping, ModelCheckpoint

# --- Configuration ---
DATA_PATH       = "artifacts/timeseries_data.parquet"
OUTPUT_DIR      = "artifacts"
CHECKPOINT_FN   = "tft_model.ckpt"
MAX_ENCODER_LEN = 30 # Days of history to use
MAX_PRED_LEN    = 7  # Days to predict ahead
BATCH_SIZE      = 128
MAX_EPOCHS      = 15
TARGET_COL      = "star_count"
TIME_COL        = "time_idx"
GROUP_COL       = "series_id"

class TFTLightningModule(LightningModule):
    """ Wraps the TFT model in a LightningModule for robust training. """
    def __init__(self, training_dataset):
        super().__init__()
        # `save_hyperparameters` is important for loading the model later
        self.save_hyperparameters()
        self.model = TemporalFusionTransformer.from_dataset(
            training_dataset,
            learning_rate=1e-3,
            hidden_size=16,
            attention_head_size=1,
            dropout=0.1,
            loss=QuantileLoss(),
        )

    def forward(self, x):
        return self.model(x)

    def training_step(self, batch, batch_idx):
        x, y = batch
        y_hat, _ = self.model(x)
        loss = self.model.loss(y_hat, y)
        self.log("train_loss", loss)
        return loss

    def validation_step(self, batch, batch_idx):
        x, y = batch
        y_hat, _ = self.model(x)
        loss = self.model.loss(y_hat, y)
        self.log("val_loss", loss, prog_bar=True)
        return loss

    def configure_optimizers(self):
        return self.model.configure_optimizers()

def train_tft_model():
    print("🚀 Starting TFT model training...")

    # 1. Load data
    print(f"📥 Loading time-series data from {DATA_PATH}")
    df = pd.read_parquet(DATA_PATH)
    df[TARGET_COL] = df[TARGET_COL].astype("float32") # Ensure correct type

    # 2. Create datasets
    print("📦 Creating TimeSeriesDataSet...")
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
    )
    validation = TimeSeriesDataSet.from_dataset(training, df, predict=True, stop_randomization=True)

    train_dl = training.to_dataloader(train=True, batch_size=BATCH_SIZE, num_workers=0)
    val_dl   = validation.to_dataloader(train=False, batch_size=BATCH_SIZE, num_workers=0)

    # 3. Set up trainer and callbacks
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    checkpoint_cb = ModelCheckpoint(dirpath=OUTPUT_DIR, filename=os.path.splitext(CHECKPOINT_FN)[0], monitor="val_loss", mode="min")
    early_stop_cb = EarlyStopping(monitor="val_loss", patience=3, mode="min")

    trainer = Trainer(
        max_epochs=MAX_EPOCHS,
        accelerator="cpu",
        logger=False,
        callbacks=[early_stop_cb, checkpoint_cb],
        gradient_clip_val=0.1
    )

    # 4. Train the model
    model = TFTLightningModule(training)
    print("⚙️ Training the model...")
    trainer.fit(model, train_dataloaders=train_dl, val_dataloaders=val_dl)
    
    print(f"✅ TFT training complete. Best model saved to {checkpoint_cb.best_model_path}")

if __name__ == "__main__":
    train_tft_model()
