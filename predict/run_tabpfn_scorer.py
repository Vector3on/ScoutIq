# predict/run_tabpfn_scorer.py
#
# Bulletproof TabPFN scoring script
# Ensures TabPFN is importable, then fits and scores on your feature data.

import os
import sys

# ─── Fix import path for local modules ─────────────────────────────────────────
root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if root not in sys.path:
    sys.path.insert(0, root)

# ─── Ensure tabpfn is installed ────────────────────────────────────────────────
try:
    from tabpfn import TabPFNClassifier
except ImportError:
    raise ImportError(
        "tabpfn library not found. Install via:\n"
        "  pip install git+https://github.com/automl/TabPFN.git\n"
        "or\n"
        "  pip install tabpfn"
    )

import pandas as pd

def run_tabpfn_scorer():
    print("⚙️  Running TabPFN scorer...")

    FEATURES_PATH = "artifacts/tabpfn_features.parquet"
    if not os.path.exists(FEATURES_PATH):
        raise FileNotFoundError(f"Feature file not found: {FEATURES_PATH}")
    df = pd.read_parquet(FEATURES_PATH)

    if "target" not in df.columns:
        raise ValueError("Column 'target' missing from features DataFrame")
    X = df.drop(columns=["target"]).values
    y = df["target"].values

    clf = TabPFNClassifier(
        N_ensemble_configurations=8,
        seed=42
    )
    clf.fit(X, y)

    preds = clf.predict(X)

    results_df = pd.DataFrame({"y_true": y, "y_pred": preds})
    os.makedirs("results", exist_ok=True)
    output_path = "results/tabpfn_scores.csv"
    results_df.to_csv(output_path, index=False)
    print(f"✅ TabPFN scoring complete. Results saved to {output_path}")

if __name__ == "__main__":
    run_tabpfn_scorer()
