# predict/train_tft_model.py (Corrected for older, stable libraries)

import os
import pandas as pd
import torch
import pytorch_lightning as pl
from pytorch_lightning.callbacks import EarlyStopping, LearningRateMonitor
from pytorch_forecasting import TemporalFusionTransformer, TimeSeriesDataSet
from pytorch_forecasting.data import GroupNormalizer
from pytorch_forecasting.metrics import QuantileLoss

# --- Configuration ---
DATA_PATH = "artifacts/real_timeseries_data.parquet"
MODEL_PATH = "artifacts/tft_model.ckpt"
MAX_ENCODER_LENGTH = 60  # Look back further
MAX_PREDICTION_LENGTH = 14 # Predict further
BATCH_SIZE = 128

def train_model():
    """
    Trains the TFT model using a stable, specified set of library versions.
    This version includes best practices for training and GPU support.
    """
    if not os.path.exists(DATA_PATH):
        print(f"❌ ERROR: Data file not found at {DATA_PATH}. Run prepare_opal_data.py first.")
        return

    print("--- Training OPAL Temporal Fusion Transformer (Stable Version) ---")
    df = pd.read_parquet(DATA_PATH)
    
    # --- Create the TimeSeriesDataSet ---
    training_cutoff = df["time_idx"].max() - MAX_PREDICTION_LENGTH
    training_dataset = TimeSeriesDataSet(
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
    validation_dataset = TimeSeriesDataSet.from_dataset(training_dataset, df, predict=True, stop_randomization=True)
    train_dataloader = training_dataset.to_dataloader(train=True, batch_size=BATCH_SIZE, num_workers=0)
    val_dataloader = validation_dataset.to_dataloader(train=False, batch_size=BATCH_SIZE, num_workers=0)

    # --- Configure the Trainer (with GPU fallback) ---
    # Best practice: stop training once validation loss stops improving.
    early_stop_callback = EarlyStopping(monitor="val_loss", min_delta=1e-4, patience=5, verbose=False, mode="min")
    lr_logger = LearningRateMonitor()
    
    # Determine accelerator based on GPU availability
    accelerator = "gpu" if torch.cuda.is_available() else "cpu"
    
    trainer = pl.Trainer(
        max_epochs=50, # Train for more epochs with early stopping
        accelerator=accelerator,
        devices=1, # Use 1 device (GPU or CPU)
        gradient_clip_val=0.1,
        callbacks=[lr_logger, early_stop_callback],
    )

    # --- Configure the Model using from_dataset ---
    tft = TemporalFusionTransformer.from_dataset(
        training_dataset,
        learning_rate=0.01, # A slightly lower learning rate for stability
        hidden_size=32,
        attention_head_size=2,
        dropout=0.1,
        hidden_continuous_size=16,
        output_size=7,  # 7 quantiles by default
        loss=QuantileLoss(),
        log_interval=10,
        reduce_on_plateau_patience=4,
    )
    
    print(f"  - Starting model training on {accelerator.upper()}...")
    
    # --- Correct trainer.fit() call for this library version ---
    trainer.fit(
        tft,
        train_dataloaders=train_dataloader,
        val_dataloaders=val_dataloader,
    )
    
    # --- Save the best model checkpoint ---
    best_model_path = trainer.checkpoint_callback.best_model_path
    if best_model_path and os.path.exists(best_model_path):
        if os.path.exists(MODEL_PATH):
            os.remove(MODEL_PATH)
        os.rename(best_model_path, MODEL_PATH)
        print(f"✅ TFT model training complete. Best model saved to {MODEL_PATH}")
    else:
        print("❌ ERROR: Training finished but could not find best model checkpoint.")


if __name__ == "__main__":
    train_model()

