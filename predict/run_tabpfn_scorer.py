# predict/run_tabpfn_scorer.py
#
# Part of the PREDICT LAYER
#
# FINAL CORRECTED VERSION: This version removes all problematic keyword
# arguments from the TabPFNClassifier constructor and the .fit() method
# call to resolve all TypeErrors.

import os
import pickle
import polars as pl
import torch
from tabpfen import TabPFNClassifier
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
            features = {
                'stars': data.get('stars', 0) or 0,
                'description_length': len(data.get('description', '')),
                'signal_count': G.degree(node_id),
                'mock_target': 1 # Placeholder target for inference
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
    
    # --- THE FIX IS HERE ---
    # We call the classifier with only the essential 'device' argument
    # to use its stable default settings.
    classifier = TabPFNClassifier(device='cpu')
    
    # And we call .fit() with no extra arguments.
    classifier.fit(X, y)
    
    y_eval, p_eval = classifier.predict_proba(X, return_winning_probability=True)

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

