# predict/run_tft_predictor.py

import os
import sys
import pandas as pd
import json
import torch
from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer
from pytorch_forecasting.data import GroupNormalizer

# Add current folder to sys.path for local import
sys.path.append(os.path.dirname(__file__))
from prepare_tft_data import prepare_timeseries_data

DATA_PATH = "artifacts/timeseries_data.parquet"
MODEL_PATH = "artifacts/tft-model.ckpt"
PREDICT_OUT = "results/tft_predictions.parquet"
HYPE_JSON_PATH = "results/hype_scores.json"

# Load trained TFT model and make predictions
def run_real_tft_predict(df):
    cutoff = df['time_idx'].max() - 12
    predict_dataset = TimeSeriesDataSet(
        df[df.time_idx > cutoff],
        time_idx="time_idx",
        target="star_count",
        group_ids=["project_id"],
        max_encoder_length=24,
        max_prediction_length=12,
        time_varying_known_reals=["time_idx"],
        time_varying_unknown_reals=["star_count"],
        target_normalizer=GroupNormalizer(groups=["project_id"]),
        add_relative_time_idx=True,
        add_target_scales=True,
        add_encoder_length=True,
    )

    predict_dataloader = predict_dataset.to_dataloader(train=False, batch_size=64, num_workers=0)
    model = TemporalFusionTransformer.load_from_checkpoint(MODEL_PATH)
    preds = model.predict(predict_dataloader, return_index=True, return_decoder_lengths=True)
    return preds

def prepare_data_if_missing():
    if not os.path.exists(DATA_PATH):
        print(f"📥 {DATA_PATH} not found. Running data preparation...")
        prepare_timeseries_data()

def run_inference():
    print("🔍 Starting TFT inference...")
    prepare_data_if_missing()

    df = pd.read_parquet(DATA_PATH)
    print(f"✅ Loaded {len(df)} rows for prediction")

    preds = run_real_tft_predict(df)
    preds.to_parquet(PREDICT_OUT)
    print(f"📈 TFT predictions saved to {PREDICT_OUT} with {len(preds)} rows.")

    # Save as hype_scores.json for Slack
    scores = preds.sort_values("prediction", ascending=False)[["series_id", "prediction"]].head(10).to_dict(orient="records")
    with open(HYPE_JSON_PATH, "w") as f:
        json.dump({"projects": scores}, f, indent=2)
    print("📤 hype_scores.json written for Slack output")

if __name__ == "__main__":
    run_inference()
