# predict/run_tabpfn_scorer.py
#
# Part of the PREDICT LAYER
#
# UPDATED VERSION: This script now outputs a JSON file for the 'act' layer.

import os
import json
import polars as pl
from tabpfn import TabPFNClassifier

# --- Configuration ---
INPUT_FEATURES_PATH = "artifacts/tabpfn_features.parquet"
OUTPUT_SCORES_PATH = "results/hype_scores.json" # Changed to JSON for Slack

def run_tabpfn_scorer():
    """
    Loads pre-prepared features and generates a hype score using TabPFN.
    """
    print("--- Starting TabPFN Hype Scorer ---")

    # 1. Load pre-prepared features
    print(f"Loading features from {INPUT_FEATURES_PATH}...")
    df_features = pl.read_parquet(INPUT_FEATURES_PATH)

    project_ids = df_features['project_id'].to_list()
    X = df_features.drop(['project_id', 'target']).to_numpy()
    y = df_features.select('target').to_numpy().flatten()

    # 2. Run TabPFN Inference
    print("Loading TabPFN model and running inference...")
    classifier = TabPFNClassifier(device='cpu')
    classifier.fit(X, y)
    
    # Get probability of class '1' (our "hype" class)
    hype_probs = classifier.predict_proba(X)[:, 1]
    
    print("Inference completed.")

    # 3. Save the scores to a JSON file
    results = {
        project_id: {'hype_score': round(float(hype_probs[i]), 4)}
        for i, project_id in enumerate(project_ids)
    }

    os.makedirs(os.path.dirname(OUTPUT_SCORES_PATH), exist_ok=True)
    with open(OUTPUT_SCORES_PATH, 'w') as f:
        json.dump(results, f, indent=2)

    print(f"✅ Hype scores saved to {OUTPUT_SCORES_PATH}")

if __name__ == "__main__":
    run_tabpfn_scorer()
