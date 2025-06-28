# predict/prepare_tft_data.py
#
# Part of the PREDICT LAYER
#
# Objective:
# 1. Load the processed graph artifact.
# 2. For each project, extract its historical star count (simulated for now).
# 3. Format this data into a Polars DataFrame suitable for pytorch-forecasting.
# 4. Save the time-series DataFrame as a Parquet file.

import os
import pickle
import polars as pl
import numpy as np
import random

# --- Configuration ---
INPUT_GRAPH_PATH = "artifacts/hetero_graph_with_embeddings.gpickle"
OUTPUT_DATA_PATH = "artifacts/timeseries_data.parquet"

def prepare_timeseries_data():
    """
    Extracts and formats time-series data from the graph.
    """
    print("--- Starting Time-Series Data Preparation for TFT ---")

    # 1. Load the graph
    print(f"Loading graph from {INPUT_GRAPH_PATH}...")
    try:
        with open(INPUT_GRAPH_PATH, 'rb') as f:
            G = pickle.load(f)
    except FileNotFoundError:
        print(f"Error: Graph file not found at {INPUT_GRAPH_PATH}. Please run the Observe workflow first.")
        return

    # 2. Simulate historical data for each project
    # In a real system, this data would be collected daily and stored.
    # For this MVP, we generate a plausible-looking time series.
    print("Generating mock historical data for projects...")
    all_series_data = []
    time_idx_counter = 0

    project_nodes = [node_id for node_id, data in G.nodes(data=True) if data.get('node_type') == 'Project']

    for project_id in project_nodes:
        # Create 90 days of historical data for each project
        days = 90
        base_stars = G.nodes[project_id].get('stars', 1000) or 1000
        growth_rate = random.uniform(1.005, 1.02)
        
        current_stars = base_stars / (growth_rate ** days)
        
        for i in range(days):
            all_series_data.append({
                "series_id": project_id,
                "time_idx": time_idx_counter + i,
                "star_count": int(current_stars),
            })
            # Add some noise to the growth
            current_stars *= (growth_rate + random.uniform(-0.001, 0.002))
            
        time_idx_counter += days

    if not all_series_data:
        print("No project data to process. Aborting.")
        return

    df_timeseries = pl.DataFrame(all_series_data)
    
    print(f"Generated {len(df_timeseries)} total time-series records.")

    # 3. Save the formatted data
    os.makedirs(os.path.dirname(OUTPUT_DATA_PATH), exist_ok=True)
    df_timeseries.write_parquet(OUTPUT_DATA_PATH)
    
    print(f"Time-series data saved to {OUTPUT_DATA_PATH}")

if __name__ == "__main__":
    prepare_timeseries_data()

