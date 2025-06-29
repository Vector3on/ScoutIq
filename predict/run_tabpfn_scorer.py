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
HYPE_JSON_PATH = "results/hype_scores.json"

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
    with open(HYPE_JSON_PATH, "w") as f:
        json.dump({"projects": scores}, f, indent=2)
    print("📤 hype_scores.json written for Slack output")

if __name__ == "__main__":
    run_inference()


# predict/run_tabpfn_scorer.py

import os
import pandas as pd
from tabpfn import TabPFNClassifier

FEATURES_PATH = "artifacts/tabpfn_features.parquet"
TABPFN_OUT = "results/tabpfn_scores.parquet"


def run_tabpfn_scorer():
    print("⚙️  Running TabPFN scorer...")

    if not os.path.exists(FEATURES_PATH):
        raise FileNotFoundError(
            f"Feature file not found: {FEATURES_PATH}\n"
            "Please generate it by running `predict/prepare_tabpfn_data.py` or ensure it exists."
        )

    df = pd.read_parquet(FEATURES_PATH)
    if "target" not in df.columns:
        raise ValueError("Column 'target' missing from features DataFrame.")

    X = df[[col for col in df.columns if col.startswith("f")]].values
    y = df["target"].values

    model = TabPFNClassifier(device="cpu")
    model.fit(X, y)

    probs = model.predict_proba(X)
    preds = model.predict(X)

    df_out = df.copy()
    df_out["tabpfn_pred"] = preds

    os.makedirs(os.path.dirname(TABPFN_OUT), exist_ok=True)
    df_out.to_parquet(TABPFN_OUT)
    print(f"✅ TabPFN predictions saved to {TABPFN_OUT} with {len(df_out)} rows.")

if __name__ == "__main__":
    run_tabpfn_scorer()
