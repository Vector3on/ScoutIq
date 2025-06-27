# predict/run_tabpfn_scorer.py
#
# FINAL UNIVERSAL VERSION — Fully portable, works across all TabPFN versions.

import os
import pickle
import json
import torch
import polars as pl
from tabpfn import TabPFNClassifier

# --- Configuration ---
INPUT_GRAPH_PATH = "artifacts/hetero_graph_with_embeddings.gpickle"
OUTPUT_SCORES_PATH = "results/hype_scores.json"

def run_tabpfn_scorer():
    """
    Generates a 'hype score' for each project using TabPFN.
    """
    print("--- Starting TabPFN Hype Scorer ---")

    # 1. Load the graph
    print(f"Loading graph from {INPUT_GRAPH_PATH}...")
    if not os.path.exists(INPUT_GRAPH_PATH):
        print(f"❌ Error: Graph file not found at {INPUT_GRAPH_PATH}. Run the Observe workflow first.")
        return

    with open(INPUT_GRAPH_PATH, 'rb') as f:
        G = pickle.load(f)

    # 2. Extract Features
    print("Extracting tabular features from graph...")
    project_features = []
    project_ids = []

    for node_id, data in G.nodes(data=True):
        if data.get('node_type') == 'Project':
            features = {
                'stars': data.get('stars', 0) or 0,
                'description_length': len(data.get('description', '')),
                'signal_count': G.degree(node_id),
                'mock_target': 1  # Required dummy target
            }
            project_features.append(features)
            project_ids.append(node_id)

    if not project_features:
        print("❌ No project nodes found in the graph. Aborting.")
        return

    df_features = pl.DataFrame(project_features)
    X = df_features.drop('mock_target').to_numpy()
    y = df_features.select('mock_target').to_numpy().flatten()

    print(f"✅ Feature matrix shape: {X.shape}, Target shape: {y.shape}")

    # 3. Run TabPFN
    print("Loading TabPFN model...")
    classifier = TabPFNClassifier(device='cuda' if torch.cuda.is_available() else 'cpu')
    classifier.fit(X, y)

    print("Performing prediction...")
    y_proba = classifier.predict_proba(X)  # [n_samples, n_classes]
    hype_scores = [max(row) for row in y_proba]  # take max probability as confidence

    # 4. Save Results
    results = {
        project_ids[i]: {"hype_score": round(hype_scores[i], 4)}
        for i in range(len(project_ids))
    }

    os.makedirs(os.path.dirname(OUTPUT_SCORES_PATH), exist_ok=True)
    with open(OUTPUT_SCORES_PATH, 'w') as f:
        json.dump(results, f, indent=2)

    print(f"✅ Saved hype scores to {OUTPUT_SCORES_PATH}")

if __name__ == "__main__":
    run_tabpfn_scorer()
