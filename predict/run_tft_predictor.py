# predict/run_tft_predictor.py
#
# Temporal Fusion Transformer Predictor
# Fixed: dtype issue + GroupNormalizer crash

import os
import polars as pl
import torch
from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer
from pytorch_forecasting.data import GroupNormalizer
from pytorch_lightning import Trainer
from pytorch_lightning.callbacks.early_stopping import EarlyStopping
import pandas as pd

def run_tft_predictor():
    print("\n--- Starting Temporal Fusion Transformer Predictor ---")

    # Load time series data
    print("Loading time-series data from artifacts/timeseries_data.parquet...")
    df = pl.read_parquet("artifacts/timeseries_data.parquet")
    data = df.to_pandas()  # polars -> pandas for Pytorch Forecasting

    print("Converting 'target' column to float32 to avoid torch.finfo crash...")
    if not pd.api.
