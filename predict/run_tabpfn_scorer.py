# predict/run_tabpfn_scorer.py
#
# Part of the PREDICT LAYER
#
# Objective:
# 1. Load the processed graph artifact.
# 2. Extract tabular features for each project (e.g., stars, velocity, signal count).
# 3. Use TabPFN in a zero-shot setting to predict a "hype" or "success" score.
# 4. Save the scores as a JSON artifact.
#
# Optimization: This uses a pre-trained TabPFN model and requires no GPU.
# It infers on the entire batch of projects at once.

import os
import pickle
import polars as pl
import torch
from tabpfn.scripts.load_data_for_inference import load_data
from tabpfn import TabPFNClassifier
import json

# --- Configuration ---
INPUT_GRAPH_PATH = "artifacts/hetero_graph_with_embeddings.gpickle"
OUTPUT_SCORES_PATH = "results/hype_scores.json"

def run_tabpfn_scorer():
    """
    Generates a "hype score" for each project using TabPFN.
    """
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
            # Create a feature vector for each project
            # In a real scenario, we'd have more features like issue counts, fork counts, etc.
            # We also need a mock "target" for TabPFN's inference process.
            features = {
                'stars': data.get('stars', 0),
                'description_length': len(data.get('description', '')),
                'signal_count': G.degree(node_id), # Number of connected signals
                'mock_target': 1 # A placeholder target variable (1 for "hype")
            }
            project_features.append(features)
            project_ids.append(node_id)
    
    if not project_features:
        print("No projects found in graph to score. Aborting.")
        return
        
    # Convert to Polars DataFrame, then to NumPy for TabPFN
    df_features = pl.DataFrame(project_features)
    X = df_features.drop('mock_target').to_numpy()
    y = df_features.select('mock_target').to_numpy().flatten()
    
    print(f"Created feature matrix with shape: {X.shape}")

    # 3. Run TabPFN Inference
    # N_ensemble_configurations controls the speed/accuracy trade-off. 4 is fast.
    print("Loading TabPFN model and running inference...")
    classifier = TabPFNClassifier(device='cpu', N_ensemble_configurations=4)

    # We "fit" the model on a small subset of the data to prime it.
    # In a zero-shot context, this isn't traditional training.
    # It just sets up the context for the transformer.
    classifier.fit(X, y)
    
    # Predict the probability of the "hype" class (1) for all projects
    y_eval, p_eval = classifier.predict_proba(X, return_winning_probability=True)

    # The returned probability is our "hype score"
    hype_scores = p_eval.tolist()
    
    print("Inference completed.")

    # 4. Save the scores
    results = {}
    for i, project_id in enumerate(project_ids):
        results[project_id] = {'hype_score': round(hype_scores[i], 4)}

    os.makedirs(os.path.dirname(OUTPUT_SCORES_PATH), exist_ok=True)
    with open(OUTPUT_SCORES_PATH, 'w') as f:
        json.dump(results, f, indent=2)

    print(f"Hype scores saved to {OUTPUT_SCORES_PATH}")

if __name__ == "__main__":
    run_tabpfn_scorer()

