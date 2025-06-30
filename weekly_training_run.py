# weekly_training_run.py
# This script encapsulates the entire weekly heavy-lifting process.

import os
from predict import prepare_opal_data, train_tft_model

def main():
    """
    Main function to run the entire weekly training pipeline.
    """
    print("--- [WORKFLOW_STEP] Starting Weekly Training Workflow ---")
    
    # --- Part 1: Prepare Data ---
    # This calls the script that queries Neo4j and creates the time-series file.
    print("\n--- [WORKFLOW_STEP] Preparing Data ---")
    prepare_opal_data.create_real_timeseries_data()

    # --- Part 2: Train Model ---
    # This calls the script that trains the TFT model on the prepared data.
    print("\n--- [WORKFLOW_STEP] Training Model ---")
    train_tft_model.train_model()

    print("\n--- [WORKFLOW_STEP] Weekly Training Script Finished ---")

if __name__ == "__main__":
    main()
