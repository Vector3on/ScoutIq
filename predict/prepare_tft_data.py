# predict/prepare_tft_data.py

import os
import pickle
import polars as pl
import random

INPUT_GRAPH_PATH = "artifacts/hetero_graph_with_embeddings.gpickle"
OUTPUT_DATA_PATH = "artifacts/timeseries_data.parquet"

def prepare_timeseries_data():
    print("🧠 Starting Time-Series Data Preparation for TFT")

    # --- Step 1: Load Graph ---
    if not os.path.exists(INPUT_GRAPH_PATH):
        raise FileNotFoundError(f"❌ Graph file not found: {INPUT_GRAPH_PATH}")

    print(f"📦 Loading graph from {INPUT_GRAPH_PATH}...")
    with open(INPUT_GRAPH_PATH, 'rb') as f:
        G = pickle.load(f)

    # --- Step 2: Find Project Nodes ---
    project_nodes = [
        (node_id, data) for node_id, data in G.nodes(data=True)
        if data.get("node_type") == "Project"
    ]

    if not project_nodes:
        raise ValueError("❌ No 'Project' nodes found in the graph!")

    print(f"✅ Found {len(project_nodes)} Project nodes.")

    # --- Step 3: Simulate Star Count History ---
    print("🔄 Generating synthetic star count history...")
    all_series_data = []

    for project_id, data in project_nodes:
        base_stars = data.get("stars", 1000) or 1000
        growth_rate = random.uniform(1.005, 1.02)
        days = 90
        current_stars = base_stars
        temp_history = []

        for _ in range(days):
            temp_history.append(current_stars)
            current_stars /= (growth_rate + random.uniform(-0.001, 0.001))

        for i, star_count in enumerate(reversed(temp_history)):
            all_series_data.append({
                "series_id": str(project_id),
                "time_idx": i,
                "star_count": int(star_count)
            })

    if not all_series_data:
        raise ValueError("❌ Time-series generation failed: no data produced.")

    df_timeseries = pl.DataFrame(all_series_data)

    # --- Step 4: Save ---
    os.makedirs(os.path.dirname(OUTPUT_DATA_PATH), exist_ok=True)
    df_timeseries.write_parquet(OUTPUT_DATA_PATH)
    print(f"✅ Time-series data saved: {OUTPUT_DATA_PATH} with {len(df_timeseries)} rows.")

if __name__ == "__main__":
    prepare_timeseries_data()
