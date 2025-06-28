# predict/run_tft_predictor.py

import os
import sys
import pandas as pd
import json

# Add current folder to sys.path for local import
sys.path.append(os.path.dirname(__file__))

from prepare_tft_data import prepare_timeseries_data

DATA_PATH = "artifacts/timeseries_data.parquet"
MODEL_PATH = "artifacts/tft-model.ckpt"
PREDICT_OUT = "results/tft_predictions.parquet"

# Stub for TFT prediction output
def run_dummy_tft_predict(df):
    # Replace this with your real model inference
    df_out = df.groupby("series_id").tail(1)[["series_id", "star_count"]].copy()
    df_out["tft_score"] = df_out["star_count"] * 1.03  # dummy growth
    return df_out[["series_id", "tft_score"]]

def prepare_data_if_missing():
    if not os.path.exists(DATA_PATH):
        print(f"📥 {DATA_PATH} not found. Running data preparation...")
        prepare_timeseries_data()

def run_inference():
    print("🔍 Starting TFT inference...")
    prepare_data_if_missing()

    df = pd.read_parquet(DATA_PATH)
    print(f"✅ Loaded {len(df)} rows for prediction")

    df_preds = run_dummy_tft_predict(df)
    os.makedirs(os.path.dirname(PREDICT_OUT), exist_ok=True)
    df_preds.to_parquet(PREDICT_OUT)
    print(f"📈 TFT predictions saved to {PREDICT_OUT} with {len(df_preds)} rows.")

    # Save as hype_scores.json for Slack
    scores = df_preds.sort_values("tft_score", ascending=False).head(10).to_dict(orient="records")
    with open("results/hype_scores.json", "w") as f:
        json.dump(scores, f, indent=2)
    print("📤 hype_scores.json written for Slack output")

if __name__ == "__main__":
    run_inference()
