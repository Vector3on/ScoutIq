# predict/run_tft_predictor.py
#
# Part of the PREDICT LAYER (run daily)
#
# FINAL CORRECTED VERSION: This version fixes the FileNotFoundError by
# pointing to the correct model checkpoint path in the 'artifacts' directory.

import os
import polars as pl
from pytorch_forecasting import TemporalFusionTransformer
import torch
import json
import pandas as pd

# --- Configuration ---
INPUT_DATA_PATH = "artifacts/timeseries_data.parquet"
# --- THE FIX IS HERE ---
# The path now correctly points to the 'artifacts' directory where the
# training workflow saves the model.
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
        # Load the model from the corrected path
        model = TemporalFusionTransformer.load_from_checkpoint(MODEL_CHECKPOINT_PATH)
    except FileNotFoundError:
        print(f"❌ Model checkpoint not found at {MODEL_CHECKPOINT_PATH}.")
        print("   Please ensure the 'OPAL - Weekly Model Training' workflow has been run successfully at least once.")
        return
        
    # 2. Load the latest timeseries data for inference
    print(f"📥 Loading latest time-series data from {INPUT_DATA_PATH}...")
    try:
        df = pl.read_parquet(INPUT_DATA_PATH)
        data = df.to_pandas()
        data["month"] = data["time_idx"].mod(30).astype(str).astype("category")
    except Exception as e:
        print(f"❌ Error loading data for prediction: {e}.")
        return

    # 3. Generate predictions
    print(f"Forecasting future star counts for {len(data['series_id'].unique())} projects...")
    
    # The `predict` method can take the full dataset; it will automatically
    # use the last available data for each series as input.
    raw_predictions = model.predict(data, mode="prediction")

    # 4. Format and save the predictions
    predictions = {}
    unique_series = data["series_id"].unique()

    for i, series_id in enumerate(unique_series):
        # The predictions are for the next 7 days from the last data point.
        series_prediction = raw_predictions[i].tolist()
        predictions[series_id] = {
            'predicted_star_growth_next_7_days': [round(p) for p in series_prediction]
        }
        
    os.makedirs(os.path.dirname(OUTPUT_PREDICTIONS_PATH), exist_ok=True)
    with open(OUTPUT_PREDICTIONS_PATH, 'w') as f:
        json.dump(predictions, f, indent=2)

    print(f"✅ TFT predictions saved to {OUTPUT_PREDICTIONS_PATH}")

if __name__ == "__main__":
    run_tft_predictor()
