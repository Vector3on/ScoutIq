# predict/prepare_tabpfn_data.py
#
# Part of the PREDICT LAYER
#
# Objective:
# 1. Load the processed graph artifact from the Observe layer.
# 2. Extract tabular features for each project node.
# 3. Save the features as a Parquet file for the TabPFN scorer.

import os
import pickle
import polars as pl

# --- Configuration ---
GRAPH_PATH = "artifacts/hetero_graph_with_embeddings.gpickle"
FEATURES_PATH = "artifacts/tabpfn_features.parquet"

def prepare_tabpfn_data():
    """
    Extracts tabular features from the graph for TabPFN inference.
    """
    print("--- Preparing Tabular Features for TabPFN ---")

    # 1. Load the graph
    print(f"Loading graph from {GRAPH_PATH}...")
    try:
        with open(GRAPH_PATH, "rb") as f:
            G = pickle.load(f)
    except FileNotFoundError:
        raise FileNotFoundError(f"Missing graph: {GRAPH_PATH}. Please ensure the Observe job ran successfully.")

    # 2. Extract features
    rows = []
    for node_id, data in G.nodes(data=True):
        if data.get("node_type") == "Project":
            # The user's version used embeddings as features, which is a great idea.
            # However, for the MVP, we will stick to simpler tabular features.
            # This can be easily extended later.
            row = {
                'project_id': node_id,
                'stars': data.get("stars", 0) or 0,
                'description_length': len(data.get("description", "")),
                'signal_count': G.degree(node_id),
                'target': 1 # Mock target for "hype" prediction
            }
            rows.append(row)

    if not rows:
        raise RuntimeError("No project nodes found in the graph.")

    # 3. Save features to a Parquet file using Polars
    df_features = pl.DataFrame(rows)
    os.makedirs(os.path.dirname(FEATURES_PATH), exist_ok=True)
    df_features.write_parquet(FEATURES_PATH)

    print(f"✅ TabPFN features saved to: {FEATURES_PATH} with shape {df_features.shape}")

if __name__ == "__main__":
    prepare_tabpfn_data()
