# predict/run_tabpfn_scorer.py
#
# FINAL FIXED VERSION – COMPATIBLE WITH BOTH STABLE & DEV BUILDS

import os
import pickle
import polars as pl
import torch
from tabpfn import TabPFNClassifier
import json
import tabpfn

print("TabPFN version:", tabpfn.__version__)

# --- Configuration ---
INPUT_GRAPH_PATH = "artifacts/hetero_graph_with_embeddings.gpickle"
OUTPUT_SCORES_PATH = "results/hype_scores.json"

def run_tabpfn_scorer():
    print("--- Starting TabPFN Hype Scorer ---")

    # 1. Load the graph
    print(f"Loading graph from {INPUT_GRAPH_PATH}...")
    try:
        with open(INPUT_GRAPH_PATH, 'rb') as f:
            G = pickle.load(f)
    except FileNotFoundError:
        print(f"Error: Graph file not found at {INPUT_GRAPH_PATH}. Please run the Observe workflow first.")
        return

    # 2. Extract Tabular Features
    print("Extracting tabular features from graph...")
    project_features = []
    project_ids = []
    for node_id, data in G.nodes(data=True):
        if data.get('node_type') == 'Project':
            features = {
                'stars': data.get('stars', 0) or 0,
                'description_length': len(data.get('description', '')),
                'signal_count': G.degree(node_id),
                'mock_target': 1  # Placeholder target
            }
            project_features.append(features)
            project_ids.append(node_id)

    if not project_features:
        print("No projects found in graph to score. Aborting.")
        return

    df_features = pl.DataFrame(project_features)
    X = df_features.drop('mock_target').to_numpy()
    y = df_features.select('mock_target').to_numpy().flatten()

    print(f"Created feature matrix with shape: {X.shape}")

    # 3. Run TabPFN Inference
    print("Loading TabPFN model and running inference...")

    # Detect whether dev version supports n_ensemble_configurations
    try:
        classifier = TabPFNClassifier(device='cpu', n_ensemble_configurations=4)
    except TypeError:
        classifier = TabPFNClassifier(device='cpu')  # fallback

    classifier.fit(X, y, overwrite_warning=True)
    y_eval, p_eval = classifier.predict_proba(X, return_winning_probability=True)

    hype_scores = p_eval.tolist()

    # 4. Save the scores
    results = {
        project_ids[i]: {'hype_score': round(hype_scores[i], 4)}
        for i in range(len(project_ids))
    }

    os.makedirs(os.path.dirname(OUTPUT_SCORES_PATH), exist_ok=True)
    with open(OUTPUT_SCORES_PATH, 'w') as f:
        json.dump(results, f, indent=2)

    print(f"Hype scores saved to {OUTPUT_SCORES_PATH}")

if __name__ == "__main__":
    run_tabpfn_scorer()
