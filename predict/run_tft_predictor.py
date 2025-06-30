# predict/run_tft_predictor.py
#
# Part of the PREDICT LAYER (run daily)
#
# This script loads the trained TFT model and makes a forecast.

import os
import pandas as pd
import json
from pytorch_forecasting import TemporalFusionTransformer

# --- Configuration ---
DATA_PATH = "artifacts/timeseries_data.parquet"
MODEL_PATH = "artifacts/tft_model.ckpt"
PREDICTIONS_OUT = "results/tft_predictions.json"

def run_tft_predictor():
    print("🔮 Starting TFT inference...")
    
    # 1. Load the trained model
    if not os.path.exists(MODEL_PATH):
        print(f"⚠️ Model checkpoint not found at {MODEL_PATH}. Skipping TFT prediction.")
        # Create an empty file to ensure the 'act' job doesn't fail
        os.makedirs(os.path.dirname(PREDICTIONS_OUT), exist_ok=True)
        with open(PREDICTIONS_OUT, "w") as f:
            json.dump({}, f)
        return

    print(f"📥 Loading trained model from {MODEL_PATH}...")
    model = TemporalFusionTransformer.load_from_checkpoint(MODEL_PATH)
    
    # 2. Load the full dataset for prediction context
    df = pd.read_parquet(DATA_PATH)
    df["star_count"] = df["star_count"].astype("float32")
    
    # 3. Generate predictions
    print(f"Forecasting for {len(df['series_id'].unique())} projects...")
    # The `predict` method will automatically use the last available data for each series
    raw_predictions = model.predict(df)
    
    # 4. Format and save the predictions
    predictions = {}
    unique_series = df["series_id"].unique()
    
    for i, series_id in enumerate(unique_series):
        # The output is a tensor of shape [prediction_length]
        # These are the predicted star counts for the next 7 days
        series_prediction = raw_predictions[i].tolist()
        predictions[series_id] = {
            'predicted_star_values_next_7_days': [round(p, 2) for p in series_prediction]
        }

    with open(PREDICTIONS_OUT, "w") as f:
        json.dump(predictions, f, indent=2)
        
    print(f"📈 TFT predictions saved to {PREDICTIONS_OUT}")

if __name__ == "__main__":
    run_tft_predictor()
