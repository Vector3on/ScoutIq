# predict/run_tft_predictor.py
#
# Part of the PREDICT LAYER
#
# Objective:
# 1. Load the prepared time-series data.
# 2. Define and train a Temporal Fusion Transformer model.
# 3. Generate predictions for future star growth.
# 4. Save the predictions as a JSON artifact.

import os
import polars as pl
import pytorch_lightning as pl_trainer
from pytorch_forecasting import TemporalFusionTransformer, TimeSeriesDataSet
from pytorch_forecasting.data import GroupNormalizer
import torch
import json

# --- Configuration ---
INPUT_DATA_PATH = "artifacts/timeseries_data.parquet"
OUTPUT_PREDICTIONS_PATH = "results/tft_predictions.json"
PREDICTION_HORIZON = 7 # Predict 7 days into the future
ENCODER_LENGTH = 30 # Use 30 days of history to make a prediction

def run_tft_predictor():
    """
    Trains a TFT model and generates forecasts.
    """
    print("--- Starting Temporal Fusion Transformer Predictor ---")

    # 1. Load Data
    print(f"Loading time-series data from {INPUT_DATA_PATH}...")
    try:
        data = pl.read_parquet(INPUT_DATA_PATH)
    except FileNotFoundError:
        print(f"Error: Time-series data not found at {INPUT_DATA_PATH}. Please run prepare_tft_data.py first.")
        return

    # 2. Create TimeSeriesDataSet
    # This is a special PyTorch Forecasting class for handling time series.
    print("Creating TimeSeriesDataSet...")
    training_cutoff = data["time_idx"].max() - PREDICTION_HORIZON
    
    dataset = TimeSeriesDataSet(
        data.to_pandas(), # Library requires pandas DataFrame
        time_idx="time_idx",
        target="star_count",
        group_ids=["series_id"],
        max_encoder_length=ENCODER_LENGTH,
        max_prediction_length=PREDICTION_HORIZON,
        static_categoricals=[],
        time_varying_known_reals=["time_idx"],
        time_varying_unknown_reals=["star_count"],
        target_normalizer=GroupNormalizer(groups=["series_id"], transformation="softplus"),
    )

    # 3. Create Dataloader
    dataloader = dataset.to_dataloader(train=True, batch_size=64, num_workers=0)

    # 4. Define and Train the TFT Model
    print("Defining TFT model...")
    # Using a small, fast configuration for the CI environment
    tft = TemporalFusionTransformer.from_dataset(
        dataset,
        learning_rate=0.03,
        hidden_size=8,
        attention_head_size=1,
        dropout=0.1,
        hidden_continuous_size=8,
    )
    
    print(f"Training model for {tft.hparams.max_epochs} epochs...")
    trainer = pl_trainer.Trainer(
        max_epochs=5, # Keep epochs low for fast CI runs
        accelerator="cpu",
        gradient_clip_val=0.1,
    )
    trainer.fit(tft, train_dataloaders=dataloader)
    
    print("Training complete.")

    # 5. Generate Predictions
    print("Generating future predictions...")
    # Get the latest data for each series to predict from
    encoder_data = data.filter(pl.col("time_idx") > data["time_idx"].max() - ENCODER_LENGTH)
    
    # Predict the next 7 days
    raw_predictions = tft.predict(encoder_data.to_pandas())
    
    # 6. Format and Save Predictions
    predictions = {}
    # Get unique series IDs from the original data
    all_series = data["series_id"].unique().to_list()
    for i, series_id in enumerate(all_series):
        # The output is a tensor, get the predictions for this specific series
        series_prediction = raw_predictions[i].tolist()
        predictions[series_id] = {
            'predicted_star_growth_7d': series_prediction
        }

    os.makedirs(os.path.dirname(OUTPUT_PREDICTIONS_PATH), exist_ok=True)
    with open(OUTPUT_PREDICTIONS_PATH, 'w') as f:
        json.dump(predictions, f, indent=2)

    print(f"TFT predictions saved to {OUTPUT_PREDICTIONS_PATH}")

if __name__ == "__main__":
    run_tft_predictor()

