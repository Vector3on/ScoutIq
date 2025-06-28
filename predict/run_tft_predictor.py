# predict/run_tft_predictor.py
#
# Part of the PREDICT LAYER (run daily)
#
# Objective:
# 1. Load the pre-trained TFT model checkpoint.
# 2. Load the latest time-series data for inference.
# 3. Generate a 7-day forecast for each project.
# 4. Save the predictions as a JSON artifact.

import os
import polars as pl
from pytorch_forecasting import TemporalFusionTransformer
import json
import pandas as pd

# --- Configuration ---
INPUT_DATA_PATH = "artifacts/timeseries_data.parquet"
MODEL_CHECKPOINT_PATH = "artifacts/tft_model.ckpt"
OUTPUT_PREDICTIONS_PATH = "results/tft_predictions.json"

def run_tft_predictor():
    """
    Loads a pre-trained TFT model and generates forecasts.
    """
    print("\n🔮 Starting TFT prediction run...")

    # 1. Load the pre-trained model
    print(f"📥 Loading trained TFT model from {MODEL_CHECKPOINT_PATH}...")
    try:
        model = TemporalFusionTransformer.load_from_checkpoint(MODEL_CHECKPOINT_PATH)
    except FileNotFoundError:
        print(f"❌ Model checkpoint not found at {MODEL_CHECKPOINT_PATH}. Please run the training workflow first.")
        return
        
    # 2. Load the latest timeseries data
    print(f"📥 Loading latest time-series data from {INPUT_DATA_PATH}...")
    df = pl.read_parquet(INPUT_DATA_PATH)
    data = df.to_pandas()
    data["month"] = data["time_idx"].mod(30).astype(str).astype("category")

    # 3. Generate predictions
    print(f"Forecasting future star counts for {len(data['series_id'].unique())} projects...")
    raw_predictions = model.predict(data, mode="prediction", return_x=True)

    # 4. Format and save the predictions
    predictions = {}
    unique_series = data["series_id"].unique()

    for i, series_id in enumerate(unique_series):
        # The output prediction tensor has shape (n_timesteps, n_quantiles)
        # We take the median forecast (index 3 of 7 quantiles)
        series_prediction = raw_predictions.output[i, :, 3].tolist() 
        predictions[series_id] = {
            'predicted_stars_next_7_days': [round(p) for p in series_prediction]
        }
        
    os.makedirs(os.path.dirname(OUTPUT_PREDICTIONS_PATH), exist_ok=True)
    with open(OUTPUT_PREDICTIONS_PATH, 'w') as f:
        json.dump(predictions, f, indent=2)

    print(f"✅ TFT predictions saved to {OUTPUT_PREDICTIONS_PATH}")

if __name__ == "__main__":
    run_tft_predictor()
