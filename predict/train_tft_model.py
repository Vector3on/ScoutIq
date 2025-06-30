# predict/train_tft_model.py (Final Version with Modern Syntax)

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
MAX_ENCODER_LENGTH = 60
MAX_PREDICTION_LENGTH = 14
BATCH_SIZE = 128

def train_model():
    """
    Trains the TFT model using modern syntax compatible with newer versions
    of PyTorch Lightning that are being installed in the Colab environment.
    """
    if not os.path.exists(DATA_PATH):
        print(f"❌ ERROR: Data file not found at {DATA_PATH}. Run prepare_opal_data.py first.")
        return

    print("--- Training OPAL Temporal Fusion Transformer (Modern Syntax) ---")
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
    )

    # --- Create validation set and dataloaders ---
    validation_dataset = TimeSeriesDataSet.from_dataset(training_dataset, df, predict=True, stop_randomization=True)
    train_dataloader = training_dataset.to_dataloader(train=True, batch_size=BATCH_SIZE, num_workers=0)
    val_dataloader = validation_dataset.to_dataloader(train=False, batch_size=BATCH_SIZE, num_workers=0)

    # --- Configure the Trainer with Modern Syntax ---
    early_stop_callback = EarlyStopping(monitor="val_loss", min_delta=1e-4, patience=5, verbose=False, mode="min")
    lr_logger = LearningRateMonitor()
    
    # Use 'accelerator' and 'devices' for modern PyTorch Lightning
    accelerator = "gpu" if torch.cuda.is_available() else "cpu"
    
    trainer = pl.Trainer(
        max_epochs=30,
        accelerator=accelerator,
        devices=1,
        gradient_clip_val=0.1,
        limit_train_batches=50,
        callbacks=[lr_logger, early_stop_callback],
    )

    # --- Configure the Model ---
    tft = TemporalFusionTransformer.from_dataset(
        training_dataset,
        learning_rate=0.03,
        hidden_size=16,
        attention_head_size=4,
        dropout=0.1,
        hidden_continuous_size=8,
        loss=QuantileLoss(),
        log_interval=10,
        reduce_on_plateau_patience=4,
    )
    
    print(f"  - Starting model training on {accelerator.upper()}...")
    
    # Use positional arguments for .fit() in modern versions
    trainer.fit(
        tft,
        train_dataloader,
        val_dataloader,
    )
    
    # --- Save the best model checkpoint ---
    best_model_path = trainer.checkpoint_callback.best_model_path
    if best_model_path and os.path.exists(best_model_path):
        if os.path.exists(MODEL_PATH):
            os.remove(MODEL_PATH)
        os.rename(best_model_path, MODEL_PATH)
        print(f"✅ TFT model training complete. Best model saved to {MODEL_PATH}")
    else:
        print("⚠️ Could not find best model checkpoint. Saving last model state instead.")
        trainer.save_checkpoint(MODEL_PATH)
        print(f"✅ TFT model training complete. Last model state saved to {MODEL_PATH}")

if __name__ == "__main__":
    train_model()
