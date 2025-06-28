# predict/run_tft_predictor.py
#
# Debug Version — shows actual columns + prevents blind errors

import os
import polars as pl
import torch
from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer
from pytorch_forecasting.data import GroupNormalizer
from pytorch_lightning import Trainer
import pandas as pd

def run_tft_predictor():
    print("\n--- Starting Temporal Fusion Transformer Predictor ---")

    # Step 1: Load data
    print("Loading time-series data from artifacts/timeseries_data.parquet...")
    df = pl.read_parquet("artifacts/timeseries_data.parquet")
    data = df.to_pandas()

    # Step 2: DEBUG actual columns
    print("📊 DEBUG: Columns in DataFrame:", data.columns.tolist())
    print("🔎 DEBUG: First 5 rows:")
    print(data.head(5))

    # Step 3: Fail-safe if 'target' column is missing
    if "target" not in data.columns:
        print("\n❌ ERROR: 'target' column not found in dataset!")
        print("🧪 Available columns:", data.columns.tolist())
        print("🛠️  You likely need to rename your actual target column in this script.")
        raise KeyError("Missing 'target' column in input dataset. Fix this in run_tft_predictor.py")

    # Step 4: Safe dtype cast to float32
    print("✅ Converting 'target' to float32...")
    if not pd.api.types.is_float_dtype(data["target"]):
        data["target"] = data["target"].astype("float32")

    # Step 5: Build dataset
    print("⚙️ Creating TimeSeriesDataSet...")
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

    # Step 6: Dataloader
    print("📦 Creating dataloader...")
    val_dataloader = dataset.to_dataloader(train=False, batch_size=64, num_workers=0)

    # Step 7: Load model
    model_path = "checkpoints/tft_model.ckpt"
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"❌ Model checkpoint not found at {model_path}")
    print("📥 Loading trained model from:", model_path)
    model = TemporalFusionTransformer.load_from_checkpoint(model_path)

    # Step 8: Run prediction
    print("🤖 Running predictions...")
    trainer = Trainer(logger=False, enable_checkpointing=False, max_epoch
