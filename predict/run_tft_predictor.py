# predict/run_tft_predictor.py
#
# Final version — includes column inspection, dtype fix, and working Trainer call

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
        print("\n❌ ERROR: 'target' column not
