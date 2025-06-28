# predict/prepare_tft_data.py
#
# Part of the PREDICT LAYER
#
# Bulletproof version: Validates graph input, simulates project time series,
# aligns schema with TFT model expectations, and ensures all required fields.

import os
import pickle
import polars as pl
import random
import pandas as pd

# --- Configuration ---
INPUT_GRAPH_PATH = "artifacts/hetero_graph_with_embeddings.gpickle"
OUTPUT_DATA_PATH = "artifacts/timeseries_data.parquet"
HISTORICAL_DAYS = 90

def prepare_timeseries_data():
    """
    Extracts and formats time-series data from the graph into Parquet.
    """
    print("🧠 Starting Time-Series Data Preparation for TFT")

    # 1. Load the graph
    print(f"📦 Loading graph from {INPUT_GRAPH_PATH}...")
    try:
        with open(INPUT_GRAPH_PATH, 'rb') as f:
            G = pickle.load(f)
    except FileNotFoundError:
        raise RuntimeError(f"❌ Graph file not found at {INPUT_GRAPH_PATH}")

    # 2. Simulate historical star count data per project
    print("🔄 Generating synthetic star count history...")
    project_nodes = [
        (node_id, data) for node_id, data in G.nodes(data=True)
        if data.get("node_type") == "Project"
    ]

    all_series_data = []
    for project_id, data in project_nodes:
        stars = data.get("stars", 1000) or 1000
        growth = random.uniform(1.005, 1.02)

        # Reverse simulates 90-day history
        star_history = []
        current = stars
        for _ in range(HISTORICAL_DAYS):
            star_history.append(current)
            current /= (growth + random.uniform(-0.001, 0.001))

        # Chronological + consistent schema
        for i, star_count in enumerate(reversed(star_history)):
            all_series_data.append({
                "project_id": str(project_id),         # group_id
                "time_idx": i,                         # time index
                "star_count": float(star_count),       # target
            })

    if not all_series_data:
        raise RuntimeError("❌ No valid time-series project data found.")

    # 3. Convert to DataFrame and validate schema
