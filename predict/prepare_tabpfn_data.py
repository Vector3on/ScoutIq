# predict/prepare_tabpfn_data.py
#
# Generates tabular features + target for TabPFN from graph embeddings.

import os
import pickle
import pandas as pd
import polars as pl

GRAPH_PATH = "artifacts/hetero_graph_with_embeddings.gpickle"
FEATURES_PATH = "artifacts/tabpfn_features.parquet"

def prepare_tabpfn_data():
    print("🔧 Generating TabPFN features from graph node embeddings...")

    if not os.path.exists(GRAPH_PATH):
        raise FileNotFoundError(f"Missing graph: {GRAPH_PATH}")

    with open(GRAPH_PATH, "rb") as f:
        G = pickle.load(f)

    rows = []
    for node_id, data in G.nodes(data=True):
        if data.get("node_type") == "Project":
            embed = data.get("embedding")
            stars = data.get("stars", 0)
            if embed is not None:
                row = {f"f{i}": float(val) for i, val in enumerate(embed)}
                row["target"] = int(stars)  # ✅ this is the fix: rename 'stars' → 'target'
                row["project_id"] = node_id
                rows.append(row)

    if not rows:
        raise RuntimeError("No project nodes with embeddings found.")

    df = pd.DataFrame(rows)
    pl_df = pl.DataFrame(df)

    os.makedirs(os.path.dirname(FEATURES_PATH), exist_ok=True)
    pl_df.write_parquet(FEATURES_PATH)

    print(f"✅ TabPFN features saved to: {FEATURES_PATH} with shape {pl_df.shape}")

if __name__ == "__main__":
    prepare_tabpfn_data()
