# predict/run_tft_predictor.py
import os
import json
import pandas as pd
from pytorch_forecasting import TemporalFusionTransformer, TimeSeriesDataSet
import torch

# --- Configuration ---
DATA_PATH = "artifacts/real_timeseries_data.parquet"
MODEL_PATH = "artifacts/tft_model.ckpt"
OUTPUT_PATH = "results/hype_scores.json"

def run_predictions():
    """Loads the trained TFT model and makes predictions."""
    if not os.path.exists(MODEL_PATH) or not os.path.exists(DATA_PATH):
        print("  - ERROR: Model or data artifact not found. Run preparation and training first.")
        return
        
    print("--- Running OPAL TFT Predictions ---")
    tft = TemporalFusionTransformer.load_from_checkpoint(MODEL_PATH)
    df = pd.read_parquet(DATA_PATH)

    # Create a dataloader for the latest data available for each project
    # This ensures we predict from the most recent point in time
    predict_dataset = TimeSeriesDataSet.from_parameters(
        tft.dataset_parameters, df
    )
    predict_dataloader = predict_dataset.to_dataloader(train=False, batch_size=64, num_workers=0)

    # Make predictions
    raw_predictions = tft.predict(predict_dataloader, mode="raw", return_x=True)
    
    all_scores = []
    # Iterate through each project's prediction
    for i in range(len(raw_predictions.x["groups"])):
        project_id = raw_predictions.x["groups"][i][0]
        # Sum the predicted mention counts over the next 7 days for a "hype score"
        hype_score = raw_predictions.output.prediction[i].sum().item()
        
        score_entry = {
            "series_id": project_id,
            "tft_score": hype_score, # This is the key the slack formatter expects
            "summary": f"Predicted {hype_score:.2f} total mentions in the next 7 days."
        }
        all_scores.append(score_entry)

    # Sort and save
    all_scores = sorted(all_scores, key=lambda x: x["tft_score"], reverse=True)
    final_output = {"projects": all_scores}
    
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(final_output, f, indent=2)
        
    print(f"✅ OPAL hype scores saved to {OUTPUT_PATH}")

if __name__ == "__main__":
    run_predictions()
