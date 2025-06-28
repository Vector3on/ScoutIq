# predict/train_tft_model.py

import pandas as pd
import torch
from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer, Baseline, QuantileLoss
from pytorch_forecasting.data import GroupNormalizer
from pytorch_forecasting.metrics import SMAPE
from pytorch_lightning import Trainer
from pytorch_lightning.loggers import CSVLogger
from pytorch_lightning.callbacks import EarlyStopping, ModelCheckpoint
import os

def train_tft_model():
    print("🚀 Starting TFT model training...")

    df = pd.read_parquet("artifacts/timeseries_data.parquet")
    df["star_count"] = df["star_count"].astype("float32")

    print("📥 Loading data from artifacts/timeseries_data.parquet...")
    training_cutoff = df["time_idx"].max() - 6

    training = TimeSeriesDataSet(
        df[lambda x: x.time_idx <= training_cutoff],
        time_idx="time_idx",
        target="star_count",
        group_ids=["series_id"],
        max_encoder_length=30,
        max_prediction_length=6,
        time_varying_known_reals=["time_idx"],
        time_varying_unknown_reals=["star_count"],
        target_normalizer=GroupNormalizer(groups=["series_id"]),
    )

    validation = TimeSeriesDataSet.from_dataset(training, df, predict=True, stop_randomization=True)

    train_dataloader = training.to_dataloader(train=True, batch_size=32, num_workers=0)
    val_dataloader = validation.to_dataloader(train=False, batch_size=32, num_workers=0)

    print("⚙️ Configuring and training the TFT model...")
    tft = TemporalFusionTransformer.from_dataset(
        training,
        learning_rate=0.03,
        hidden_size=16,
        attention_head_size=1,
        dropout=0.1,
        loss=QuantileLoss(),
        log_interval=10,
        log_val_interval=1,
        reduce_on_plateau_patience=4,
    )

    # Setup logger and checkpointing
    checkpoint_callback = ModelCheckpoint(
        dirpath="artifacts",
        filename="tft_model",
        monitor="val_loss",
        save_top_k=1,
        mode="min"
    )
    logger = CSVLogger("logs", name="tft")

    trainer = Trainer(
        max_epochs=5,
        gradient_clip_val=0.1,
        limit_train_batches=30,  # quick training
        callbacks=[checkpoint_callback],
        logger=logger,
        enable_checkpointing=True
    )

    trainer.fit(tft, train_dataloaders=train_dataloader, val_dataloaders=val_dataloader)

    print("✅ Model training complete. Checkpoint saved to artifacts/tft_model.ckpt")

if __name__ == "__main__":
    train_tft_model()
