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
from pytorch_lightning import Trainer
from pytorch_lightning.callbacks import EarlyStopping
import pandas as pd

# --- Configuration ---
INPUT_DATA_PATH = "artifacts/timeseries_data.parquet"
OUTPUT_MODEL_PATH = "artifacts/tft_model.ckpt"

def train_tft_model():
    """
    Trains and saves a TFT model.
    """
    print("\n🚀 Starting TFT model training on GitHub star trends...")

    # 1. Load and prepare data
    print(f"📥 Loading data from {INPUT_DATA_PATH}...")
    try:
        df = pl.read_parquet(INPUT_DATA_PATH)
        data = df.to_pandas()
    except Exception as e:
        print(f"❌ Error loading data: {e}. Please ensure the 'Observe' job ran successfully.")
        return

    # Add a month column for time-varying known categoricals
    data["month"] = data["time_idx"].mod(30).astype(str).astype("category")

    # 2. Define dataset parameters
    max_prediction_length = 7  # Predict 7 days ahead
    max_encoder_length = 30    # Use 30 days of history
    training_cutoff = data["time_idx"].max() - max_prediction_length

    # 3. Create the training dataset
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
        time_varying_known_categoricals=["month"], # Added month as a feature
        target_normalizer=GroupNormalizer(groups=["series_id"], transformation="softplus"),
    )
    
    # 4. Create a validation dataset to prevent overfitting
    validation_dataset = TimeSeriesDataSet.from_dataset(training_dataset, data, predict=True, stop_randomization=True)
    
    # Create dataloaders
    train_dataloader = training_dataset.to_dataloader(train=True, batch_size=64, num_workers=0)
    val_dataloader = validation_dataset.to_dataloader(train=False, batch_size=64, num_workers=0)

    # 5. Configure and train the model
    print("⚙️ Configuring and training the TFT model...")
    early_stop_callback = EarlyStopping(monitor="val_loss", min_delta=1e-4, patience=5, verbose=False, mode="min")
    
    trainer = Trainer(
        max_epochs=20, # A reasonable number of epochs for a weekly run
        accelerator="cpu",
        enable_model_summary=True,
        gradient_clip_val=0.1,
        callbacks=[early_stop_callback],
    )

    tft = TemporalFusionTransformer.from_dataset(
        training_dataset,
        learning_rate=0.03,
        hidden_size=16,
        attention_head_size=2,
        dropout=0.1,
        hidden_continuous_size=8,
    )

    print(f"Found {tft.size()} parameters. Training...")
    trainer.fit(tft, train_dataloaders=train_dataloader, val_dataloaders=val_dataloader)

    # 6. Save the best model checkpoint
    print(f"💾 Saving best model to {OUTPUT_MODEL_PATH}...")
    trainer.save_checkpoint(OUTPUT_MODEL_PATH)
    print("✅ Training complete.")


if __name__ == "__main__":
    train_tft_model()

