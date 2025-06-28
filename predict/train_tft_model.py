# predict/train_tft_model.py

import os
import torch
import pandas as pd
from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer, Baseline, QuantileLoss
from pytorch_lightning import Trainer
from pytorch_lightning.callbacks import EarlyStopping, ModelCheckpoint
from pytorch_lightning.loggers import CSVLogger

def train_tft_model():
    print("🚀 Starting TFT model training...")

    # Load preprocessed data
    data_path = "artifacts/timeseries_data.parquet"
    print(f"📥 Loading data from {data_path}...")
    df = pd.read_parquet(data_path)

    print("📊 Available columns:", df.columns.tolist())
    required_columns = ["project_id", "time_idx", "star_count"]
    missing = [col for col in required_columns if col not in df.columns]
    if missing:
        raise ValueError(f"❌ Missing required columns: {missing}")

    df["star_count"] = df["star_count"].astype("float32")

    print("📦 Creating TimeSeriesDataSet for training...")
    training = TimeSeriesDataSet(
        df,
        time_idx="time_idx",
        target="star_count",
        group_ids=["project_id"],
        max_encoder_length=10,
        max_prediction_length=3,
        static_categoricals=["project_id"],
        time_varying_unknown_reals=["star_count"],
        time_varying_known_reals=["time_idx"]
    )

    train_dataloader = training.to_dataloader(train=True, batch_size=64)
    val_dataloader = training.to_dataloader(train=False, batch_size=64)

    print("⚙️ Configuring and training the TFT model...")
    tft = TemporalFusionTransformer.from_dataset(
        training,
        learning_rate=0.03,
        hidden_size=16,
        attention_head_size=1,
        dropout=0.1,
        loss=QuantileLoss(),
        log_interval=10,
        reduce_on_plateau_patience=4
    )

    logger = CSVLogger("logs", name="tft")

    early_stop_callback = EarlyStopping(monitor="val_loss", min_delta=1e-4, patience=5, verbose=False, mode="min")

    checkpoint_callback = ModelCheckpoint(
        monitor="val_loss",
        dirpath="artifacts/",
        filename="tft_model",
        save_top_k=1,
        mode="min"
    )

    trainer = Trainer(
        max_epochs=30,
        gpus=0 if not torch.cuda.is_available() else 1,
        gradient_clip_val=0.1,
        limit_train_batches=1.0,
        limit_val_batches=1.0,
        logger=logger,
        callbacks=[early_stop_callback, checkpoint_callback]
    )

    trainer.fit(tft, train_dataloader, val_dataloader)

    print("✅ TFT training complete.")

if __name__ == "__main__":
    train_tft_model()
