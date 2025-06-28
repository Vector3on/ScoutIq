# predict/run_tft_predictor.py

import os
import sys
import pandas as pd

# Add current folder to sys.path for local import
sys.path.append(os.path.dirname(__file__))

from prepare_tft_data import prepare_timeseries_data

DATA_PATH = "artifacts/timeseries_data.parquet"
MODEL_PATH = "artifacts/tft-model.ckpt"
RESULT_PATH = "results/tft_predictions.parquet"

def prepare_data_if_missing():
    if not os.path.exists(DATA_PATH):
        print(f"📥 {DATA_PATH} not found. Running data preparation...")
        prepare_timeseries_data()

def run_inference():
    print("🔍 Starting TFT inference...")
    prepare_data_if_missing()

    # Load data and run inference (stub below, replace with your actual logic)
    df = pd.read_parquet(DATA_PATH)
    print(f"✅ Loaded {len(df)} rows for prediction")
    # TODO: Add model loading + prediction logic here

if __name__ == "__main__":
    run_inference()
