# predict/run_tft_predictor.py
# Temporal Fusion Transformer Predictor
# Fixed: dtype issue + GroupNormalizer crash

import os
import polars as pl
import torch
from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer
from pytorch_forecasting.data import GroupNormalizer
from pytorch_lightning import Trainer
from pytorch_lightning.callbacks.early_stopping import EarlyStopping
import pandas as pd

def run_tft_predictor():
    print("\n--- Starting Temporal Fusion Transformer Predictor ---")

    # Load time series data
    print("Loading time-series data from artifacts/timeseries_data.parquet...")
    df = pl.read_parquet("artifacts/timeseries_data.parquet")
    data = df.to_pandas()  # polars -> pandas for Pytorch Forecasting

    # Convert target to float
    print("Converting 'target' column to float32 to avoid torch.finfo crash...")
    if not pd.api.types.is_float_dtype(data["target"]):
        data["target"] = data["target"].astype("float32")

    # Define dataset
    print("Creating TimeSeriesDataSet...")
    dataset = TimeSeriesDataSet(
        data,
        time_idx="time_idx",
        target="target",
        group_ids=["series_id"],
        max_encoder_length=24,
        max_prediction_length=12,
        static_categoricals=[],
        static_reals=[],
        time_varying_known_categoricals=[],
        time_varying_known_reals=["time_idx"],
        time_varying_unknown_categoricals=[],
        time_varying_unknown_reals=["target"],
        target_normalizer=GroupNormalizer(groups=["series_id"]),
        add_relative_time_idx=True,
        add_target_scales=True,
        add_encoder_length=True
    )

    # Create dataloader
    print("Creating validation dataloader...")
    val_dataloader = dataset.to_dataloader(train=False, batch_size=64, num_workers=0)

    # Load model (assumes you've trained one before)
    print("Loading trained TFT model...")
    model_path = "checkpoints/tft_model.ckpt"
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Model checkpoint not found at {model_path}")

    model = TemporalFusionTransformer.load_from_checkpoint(model_path)

    # Predict
    print("Running predictions...")
    trainer = Trainer(logger=False, enable_checkpointing=False, max_epochs=1)
    predictions = trainer.predict(model, dataloaders=val_dataloader)

    # Store predictions
    print("Saving predictions to results/tft_predictions.pt...")
    os.makedirs("results", exist_ok=True)
    torch.save(predictions, "results/tft_predictions.pt")

    print("✅ TFT Prediction Completed.")

if __name__ == "__main__":
    run_tft_predictor()
