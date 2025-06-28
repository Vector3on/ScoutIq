# predict/train_tft_model.py

import os
import pandas as pd
from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer
from pytorch_lightning import Trainer
from pytorch_lightning.callbacks import EarlyStopping, ModelCheckpoint
from pytorch_forecasting.metrics import QuantileLoss

from predict.prepare_tft_data import prepare_timeseries_data

DATA_PATH = "artifacts/timeseries_data.parquet"

def train_tft_model():
    print("🚀 Starting TFT model training...")

    # ✅ Auto-generate data if not present
    if not os.path.exists(DATA_PATH):
        print(f"📂 {DATA_PATH} not found. Generating it...")
        prepare_timeseries_data()

    print(f"📥 Loading data from {DATA_PATH}...")
    df = pd.read_parquet(DATA_PATH)

    # ⚙️ TFT DataSet creation
    print("📦 Creating TimeSeriesDataSet for training...")
    max_encoder_length = 30
    max_prediction_length = 7

    training = TimeSeriesDataSet(
        df,
        time_idx="time_idx",
        target="star_count",
        group_ids=["project_id"],
        max_encoder_length=max_encoder_length,
        max_prediction_length=max_prediction_length,
        time_varying_unknown_reals=["star_count"],
        time_varying_known_reals=["time_idx"],
    )

    train_dataloader = training.to_dataloader(train=True, batch_size=64, num_workers=0)
    val_dataloader = training.to_dataloader(train=False, batch_size=64, num_workers=0)

    # 🧠 TFT model config
    print("⚙️ Configuring and training the TFT model...")
    tft = TemporalFusionTransformer.from_dataset(
        training,
        learning_rate=1e-3,
        hidden_size=16,
        attention_head_size=1,
        dropout=0.1,
        loss=QuantileLoss(),
        log_interval=10,
        log_val_interval=1,
    )

    # ⏱ Callbacks
    early_stop_callback = EarlyStopping(monitor="val_loss", patience=3, mode="min")
    checkpoint_callback = ModelCheckpoint(dirpath="artifacts", filename="tft", monitor="val_loss")

    trainer = Trainer(
        max_epochs=15,
        callbacks=[early_stop_callback, checkpoint_callback],
        gradient_clip_val=0.1,
        logger=False,
        enable_progress_bar=True,
    )

    trainer.fit(tft, train_dataloaders=train_dataloader, val_dataloaders=val_dataloader)

    print("✅ TFT model training complete.")

if __name__ == "__main__":
    train_tft_model()
