# predict/prepare_tft_data.py
#
# Part of the PREDICT LAYER
#
# Objective:
# 1. Load the processed graph artifact.
# 2. For each project, simulate historical star count data.
# 3. Format this data into a Polars DataFrame suitable for pytorch-forecasting.
# 4. Save the time-series DataFrame as a Parquet file.

import os
import pickle
import polars as pl
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
        print(f"Error: Graph file not found at {INPUT_GRAPH_PATH}. Aborting.")
        return

    # 2. Simulate historical data for each project
    print("Generating mock historical data for projects...")
    all_series_data = []
    
    project_nodes = [
        (node_id, data) for node_id, data in G.nodes(data=True) 
        if data.get('node_type') == 'Project'
    ]

    for project_id, data in project_nodes:
        # Create 90 days of historical data for each project
        days = 90
        base_stars = data.get('stars', 1000) or 1000
        growth_rate = random.uniform(1.005, 1.02)
        
        # Work backwards to generate the series
        current_stars = base_stars
        temp_history = []
        for _ in range(days):
            temp_history.append(current_stars)
            current_stars /= (growth_rate + random.uniform(-0.001, 0.001))

        # Add to the main list in chronological order
        for i, star_count in enumerate(reversed(temp_history)):
            all_series_data.append({
                "series_id": project_id,
                "time_idx": i,
                "star_count": int(star_count),
            })

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
