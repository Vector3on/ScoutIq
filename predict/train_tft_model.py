# predict/train_tft_model.py
#
# Part of the LEARN LAYER (run weekly)
#
# Objective:
# 1. Load all historical time-series data.
# 2. Train a Temporal Fusion Transformer model on this data.
# 3. Save the trained model checkpoint as an artifact.

import os
import polars as pl
import torch
from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer
from pytorch_forecasting.data import GroupNormalizer
import pytorch_lightning as pl_trainer
from pytorch_lightning.callbacks import EarlyStopping

# --- Configuration ---
INPUT_DATA_PATH = "artifacts/timeseries_data.parquet"
OUTPUT_MODEL_PATH = "artifacts/tft_model.ckpt"

def train_tft_model():
    """
    Trains and saves a TFT model.
    """
    print("\n🚀 Starting TFT model training...")

    # 1. Load and prepare data
    print(f"📥 Loading data from {INPUT_DATA_PATH}...")
    df = pl.read_parquet(INPUT_DATA_PATH)
    data = df.to_pandas()
    data["month"] = data["time_idx"].mod(30).astype(str).astype("category")

    # 2. Define dataset parameters
    max_prediction_length = 7
    max_encoder_length = 30
    training_cutoff = data["time_idx"].max() - max_prediction_length

    # 3. Create training and validation datasets
    print("📦 Creating TimeSeriesDataSet for training...")
    training_dataset = TimeSeriesDataSet(
        data[lambda x: x.time_idx <= training_cutoff],
        time_idx="time_idx",
        target="star_count",
        group_ids=["series_id"],
        max_encoder_length=max_encoder_length,
        max_prediction_length=max_prediction_length,
        time_varying_known_reals=["time_idx"],
        time_varying_unknown_reals=["star_count"],
        time_varying_known_categoricals=["month"],
        target_normalizer=GroupNormalizer(groups=["series_id"], transformation="softplus"),
    )
    
    validation_dataset = TimeSeriesDataSet.from_dataset(training_dataset, data, predict=True, stop_randomization=True)
    train_dataloader = training_dataset.to_dataloader(train=True, batch_size=16, num_workers=0)
    val_dataloader = validation_dataset.to_dataloader(train=False, batch_size=16, num_workers=0)

    # 4. Configure and train the model
    print("⚙️ Configuring and training the TFT model...")
    early_stop_callback = EarlyStopping(monitor="val_loss", min_delta=1e-4, patience=5, verbose=False, mode="min")
    
    trainer = pl_trainer.Trainer(
        max_epochs=15,
        accelerator="cpu",
        gradient_clip_val=0.1,
        callbacks=[early_stop_callback],
    )

    tft = TemporalFusionTransformer.from_dataset(
        training_dataset,
        learning_rate=0.03, hidden_size=8, attention_head_size=1, dropout=0.1, hidden_continuous_size=4,
    )

    print(f"Found {tft.size()} parameters. Training...")
    trainer.fit(tft, train_dataloaders=train_dataloader, val_dataloaders=val_dataloader)

    # 5. Save the best model checkpoint
    print(f"💾 Saving best model to {OUTPUT_MODEL_PATH}...")
    os.makedirs(os.path.dirname(OUTPUT_MODEL_PATH), exist_ok=True)
    trainer.save_checkpoint(OUTPUT_MODEL_PATH)
    print("✅ Training complete.")

if __name__ == "__main__":
    train_tft_model()
