import os
import pandas as pd
import torch
from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer
from pytorch_forecasting.metrics import QuantileLoss
from pytorch_lightning import Trainer, seed_everything, LightningModule
from pytorch_lightning.callbacks import ModelCheckpoint, EarlyStopping
from pytorch_lightning.loggers import CSVLogger
from torch.utils.data import DataLoader

class TFTLightningModel(LightningModule):
    def __init__(self, tft):
        super().__init__()
        self.tft = tft

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

def train_tft_model():
    print("🚀 Starting TFT model training...")

    df = pd.read_parquet("artifacts/timeseries_data.parquet")
    print("📥 Loaded data.")

    df["star_count"] = df["star_count"].astype("float32")
    print("✅ Converted 'star_count' to Float32.")

    # Create TimeSeriesDataSet
    training_cutoff = df["time_idx"].max() - 6
    training = TimeSeriesDataSet(
        df[lambda x: x.time_idx <= training_cutoff],
        time_idx="time_idx",
        target="star_count",
        group_ids=["project_id"],
        max_encoder_length=12,
        max_prediction_length=6,
        time_varying_unknown_reals=["star_count"],
        time_varying_known_reals=["time_idx"],
        static_categoricals=["project_id"],
    )

    print("📦 Created TimeSeriesDataSet for training...")

    validation = TimeSeriesDataSet.from_dataset(training, df, predict=True, stop_randomization=True)
    train_dataloader = training.to_dataloader(train=True, batch_size=32, num_workers=4)
    val_dataloader = validation.to_dataloader(train=False, batch_size=32, num_workers=4)

    tft = TemporalFusionTransformer.from_dataset(
        training,
        learning_rate=0.03,
        hidden_size=16,
        attention_head_size=1,
        dropout=0.1,
        loss=QuantileLoss(),
        output_size=7,
        logging_metrics=[],
    )

    print("⚙️ Configuring and training the TFT model...")

    model = TFTLightningModel(tft)

    checkpoint_callback = ModelCheckpoint(
        monitor="val_loss",
        dirpath="artifacts/",
        filename="tft_model",
        save_top_k=1,
        mode="min",
    )

    early_stop_callback = EarlyStopping(
        monitor="val_loss",
        patience=3,
        mode="min"
    )

    trainer = Trainer(
        max_epochs=30,
        gpus=0 if not torch.cuda.is_available() else 1,
        gradient_clip_val=0.1,
        callbacks=[checkpoint_callback, early_stop_callback],
        logger=CSVLogger("logs", name="tft"),
        enable_progress_bar=True,
        deterministic=True
    )

    trainer.fit(model, train_dataloaders=train_dataloader, val_dataloaders=val_dataloader)
    print("✅ Training completed. Model checkpoint saved.")

if __name__ == "__main__":
    train_tft_model()
