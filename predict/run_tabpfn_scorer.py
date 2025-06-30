# predict/run_tabpfn_scorer.py

import os
import pandas as pd
from tabpfn import TabPFNClassifier

FEATURES_PATH = "artifacts/tabpfn_features.parquet"
TABPFN_OUT = "results/tabpfn_scores.parquet"

def run_tabpfn_scorer():
    print("⚙️  Running TabPFN scorer...")

    if not os.path.exists(FEATURES_PATH):
        raise FileNotFoundError(
            f"Feature file not found: {FEATURES_PATH}\n"
            "Please generate it by running `predict/prepare_tabpfn_data.py` or ensure it exists."
        )

    df = pd.read_parquet(FEATURES_PATH)
    if "target" not in df.columns:
        raise ValueError("Column 'target' missing from features DataFrame.")

    X = df[[col for col in df.columns if col.startswith("f")]].values
    y = df["target"].values

    model = TabPFNClassifier(device="cpu")
    model.fit(X, y)

    preds = model.predict(X)

    df_out = df.copy()
    df_out["tabpfn_pred"] = preds

    os.makedirs(os.path.dirname(TABPFN_OUT), exist_ok=True)
    df_out.to_parquet(TABPFN_OUT)
    print(f"✅ TabPFN predictions saved to {TABPFN_OUT} with {len(df_out)} rows.")

if __name__ == "__main__":
    run_tabpfn_scorer()
