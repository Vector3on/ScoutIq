# predict/train_tft_model.py (Final Syntax Correction)
import os
import pandas as pd
import pytorch_lightning as pl
from pytorch_lightning.callbacks import EarlyStopping, LearningRateMonitor
from pytorch_forecasting import TemporalFusionTransformer, TimeSeriesDataSet
from pytorch_forecasting.data import GroupNormalizer
import torch
import pytorch_forecasting

# --- Configuration ---
DATA_PATH = "artifacts/real_timeseries_data.parquet"
MODEL_PATH = "artifacts/tft_model.ckpt"
MAX_ENCODER_LENGTH = 30
MAX_PREDICTION_LENGTH = 7

def train_model():
    """Trains the TFT model on the real time-series data."""
    if not os.path.exists(DATA_PATH):
        print(f"  - ERROR: Data file not found at {DATA_PATH}. Run prepare_opal_data.py first.")
        return

    print("--- Training OPAL Temporal Fusion Transformer ---")
    df = pd.read_parquet(DATA_PATH)
    
    # Create the TimeSeriesDataSet
    training_cutoff = df["time_idx"].max() - MAX_PREDICTION_LENGTH
    dataset = TimeSeriesDataSet(
        df[lambda x: x.time_idx <= training_cutoff],
        time_idx="time_idx",
        target="mention_count",
        group_ids=["project_id"],
        max_encoder_length=MAX_ENCODER_LENGTH,
        max_prediction_length=MAX_PREDICTION_LENGTH,
        static_categoricals=["project_id"],
        time_varying_known_reals=["time_idx"],
        time_varying_unknown_reals=["mention_count", "daily_upvotes"],
        target_normalizer=GroupNormalizer(groups=["project_id"], transformation="softplus"),
        add_relative_time_idx=True,
        add_target_scales=True,
        add_encoder_length=True,
    )

    # Create validation set and dataloaders
    validation = TimeSeriesDataSet.from_dataset(dataset, df, predict=True, stop_randomization=True)
    train_dataloader = dataset.to_dataloader(train=True, batch_size=64, num_workers=0)
    val_dataloader = validation.to_dataloader(train=False, batch_size=64, num_workers=0)

    # Configure the trainer
    early_stop_callback = EarlyStopping(monitor="val_loss", min_delta=1e-4, patience=5, verbose=False, mode="min")
    lr_logger = LearningRateMonitor()
    trainer = pl.Trainer(
        max_epochs=30,
        accelerator="cpu",
        gradient_clip_val=0.1,
        limit_train_batches=30,
        callbacks=[lr_logger, early_stop_callback],
    )

    # Configure the model
    tft = TemporalFusionTransformer.from_dataset(
        dataset,
        learning_rate=0.03,
        hidden_size=32,
        attention_head_size=1,
        dropout=0.1,
        hidden_continuous_size=16,
        output_size=7,
        loss=pytorch_forecasting.metrics.QuantileLoss(),
        optimizer="Ranger",
    )
    
    print(f"  - Starting model training... This may take a few minutes.")
    
    # --- THIS IS THE FIX for the TypeError ---
    # Newer versions of PyTorch Lightning expect positional arguments, not keyword arguments.
    # OLD line: trainer.fit(tft, train_dataloader=train_dataloader, val_dataloaders=val_dataloader)
    trainer.fit(tft, train_dataloader, val_dataloader)

    # Save best model by renaming it
    best_model_path = trainer.checkpoint_callback.best_model_path
    if os.path.exists(MODEL_PATH):
        os.remove(MODEL_PATH)
    os.rename(best_model_path, MODEL_PATH)
    print(f"✅ TFT model training complete. Model saved to {MODEL_PATH}")

if __name__ == "__main__":
    train_model()
