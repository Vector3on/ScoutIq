# predict/train_tft_model.py
#
# Weekly OPAL trainer — builds Temporal Fusion Transformer on GitHub star data.
# Output: checkpoints/tft_model.ckpt

import os
import polars as pl
import torch
import pandas as pd
from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer
from pytorch_forecasting.data import GroupNormalizer
from pytorch_lightning import Trainer
from pytorch_lightning.callbacks import EarlyStopping, LearningRateMonitor
from pytorch_lightning.loggers import TensorBoardLogger

def train_tft_model():
    print("\n🚀 Starting TFT model training (weekly)")

    # Load time-series data
    print("📥 Reading artifacts/timeseries_data.parquet...")
    df = pl.read_parquet("artifacts/timeseries_data.parquet")
    data = df.to_pandas()

    # Validate schema
    if "star_count" not in data.columns:
        raise ValueError("❌ Missing 'star_count' in dataset.")
    if not pd.api.types.is_float_dtype(data["star_count"]):
        print("🔁 Converting 'star_count' to float32...")
        data["star_count"] = data["star_count"].astype("float32")

    # Time series settings
    max_encoder_length = 24
    max_prediction_length = 12
    training_cutoff = data["time_idx"].max() - max_prediction_length

    # Build dataset
    print("🧱 Building TimeSeriesDataSet...")
    training = TimeSeriesDataSet(
        data[data.time_idx <= training_cutoff],
        time_idx="time_idx",
        target="star_count",
        group_ids=["series_id"],
        max_encoder_length=max_encoder_length,
        max_prediction_length=max_prediction_length,
        static_categoricals=[],
        static_reals=[],
        time_varying_known_categoricals=[],
        time_varying_known_reals=["time_idx"],
        time_varying_unknown_categoricals=[],
        time_varying_unknown_reals=["star_count"],
        target_normalizer=GroupNormalizer(groups=["series_id"]),
        add_relative_time_idx=True,
        add_target_scales=True,
        add_encoder_length=True,
    )

    validation = TimeSeriesDataSet.from_dataset(training, data, predict=True, stop_randomization=True)

    # Dataloaders
    print("📦 Creating dataloaders...")
    train_dataloader = training.to_dataloader(train=True, batch_size=64, num_workers=0)
    val_dataloader = validation.to_dataloader(train=False, batch_size=64, num_workers=0)

    # Model config
    print("🧠 Initializing TFT...")
    tft = TemporalFusionTransformer.from_dataset(
        training,
        learning_rate=1e-3,
        hidden_size=16,
        attention_head_size=1,
        dropout=0.1,
        hidden_continuous_size=8,
        output_size=1,
        loss=torch.nn.MSELoss(),
        log_interval=10,
        reduce_on_plateau_patience=4,
    )

    # Training setup
    early_stop_callback = EarlyStopping(monitor="val_loss", patience=5, mode="min")
    lr_logger = LearningRateMonitor()
    logger = TensorBoardLogger("lightning_logs", name="tft")

    trainer = Trainer(
        max_epochs=30,
        gradient_clip_val=0.1,
        callbacks=[early_stop_callback, lr_logger],
        logger=logger,
        enable_checkpointing=True,
        default_root_dir="checkpoints",
    )

    # Train model
    print("🎯 Training begins...")
    trainer.fit(tft, train_dataloaders=train_dataloader, val_dataloaders=val_dataloader)

    # Save checkpoint
    os.makedirs("checkpoints", exist_ok=True)
    trainer.save_checkpoint("checkpoints/tft_model.ckpt")
    print("✅ Saved model to checkpoints/tft_model.ckpt")

if __name__ == "__main__":
    train_tft_model()
