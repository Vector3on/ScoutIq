# predict/prepare_tft_data.py
#
# Part of the PREDICT LAYER
#
# Objective:
# 1. Load the processed graph artifact.
# 2. Simulate historical star count data for each project.
# 3. Save the time-series DataFrame as a Parquet file.

import os
import pickle
import polars as pl
import random

# --- Configuration ---
INPUT_GRAPH_PATH = "artifacts/hetero_graph_with_embeddings.gpickle"
OUTPUT_DATA_PATH = "artifacts/timeseries_data.parquet"
HISTORICAL_DAYS = 90

def prepare_timeseries_data():
    """
    Extracts and formats time-series data from the graph.
    """
    print("--- Preparing Time-Series Data for TFT ---")

    # 1. Load the graph
    print(f"📦 Loading graph from {INPUT_GRAPH_PATH}...")
    with open(INPUT_GRAPH_PATH, 'rb') as f:
        G = pickle.load(f)

    # 2. Find Project Nodes
    project_nodes = [(node_id, data) for node_id, data in G.nodes(data=True) if data.get("node_type") == "Project"]
    if not project_nodes:
        raise ValueError("❌ No 'Project' nodes found in the graph!")

    # 3. Simulate Star Count History
    print(f"🔄 Generating synthetic star count history for {len(project_nodes)} projects...")
    all_series_data = []

    for project_id, data in project_nodes:
        base_stars = data.get("stars", 1000) or 1000
        growth_rate = random.uniform(1.005, 1.02)
        
        current_stars = float(base_stars)
        temp_history = []
        for _ in range(HISTORICAL_DAYS):
            temp_history.append(current_stars)
            current_stars /= (growth_rate + random.uniform(-0.001, 0.001))

        for i, star_count in enumerate(reversed(temp_history)):
            all_series_data.append({
                "series_id": str(project_id),
                "time_idx": i,
                "star_count": int(star_count)
            })

    # 4. Save to Parquet
    df_timeseries = pl.DataFrame(all_series_data)
    os.makedirs(os.path.dirname(OUTPUT_DATA_PATH), exist_ok=True)
    df_timeseries.write_parquet(OUTPUT_DATA_PATH)
    print(f"✅ Time-series data saved: {OUTPUT_DATA_PATH} with {len(df_timeseries)} rows.")

if __name__ == "__main__":
    prepare_timeseries_data()
