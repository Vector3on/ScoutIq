# predict/run_tft_predictor.py
#
# Daily OPAL inference: loads TFT checkpoint, predicts star_count,
# and writes results to artifacts/tft_predictions.csv

import os
import pandas as pd
import torch

from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer
from pytorch_lightning import Trainer

# ─── CONFIG ─────────────────────────────────────────────────────
CHECKPOINT_PATH = "artifacts/tft_model.ckpt"
DATA_PATH       = "artifacts/timeseries_data.parquet"
OUTPUT_PATH     = "artifacts/tft_predictions.csv"
BATCH_SIZE      = 64
TIME_COL        = "time_idx"
TARGET_COL      = "star_count"
GROUP_COL       = "project_id"
MAX_ENCODER_LEN = 24
MAX_PRED_LEN    = 12
# ───────────────────────────────────────────────────────────────

def prepare_data_if_missing():
    if not os.path.exists(DATA_PATH):
        from predict.prepare_tft_data import prepare_timeseries_data
        prepare_timeseries_data()

def load_dataset():
    df = pd.read_parquet(DATA_PATH)
    cutoff = df[TIME_COL].max() - MAX_PRED_LEN
    dataset = TimeSeriesDataSet.from_dataset(
        TimeSeriesDataSet(
            df[df[TIME_COL] <= cutoff],
            time_idx=TIME_COL,
            target=TARGET_COL,
            group_ids=[GROUP_COL],
            max_encoder_length=MAX_ENCODER_LEN,
            max_prediction_length=MAX_PRED_LEN,
            time_varying_known_reals=[TIME_COL],
            time_varying_unknown_reals=[TARGET_COL],
        ),
        df,
        predict=True,
        stop_randomization=True
    )
    return dataset

def run_inference():
    print("🔍 Starting TFT inference...")
    prepare_data_if_missing()
    dataset = load_dataset()
    dataloader = dataset.to_dataloader(train=False, batch_size=BATCH_SIZE, num_workers=0)

    if not os.path.exists(CHECKPOINT_PATH):
        raise FileNotFoundError(f"Checkpoint not found: {CHECKPOINT_PATH}")

    model = TemporalFusionTransformer.load_from_checkpoint(CHECKPOINT_PATH)
    trainer = Trainer(accelerator="cpu", logger=False)

    print("⚡ Running predictions...")
    raw_preds = trainer.predict(model, dataloaders=dataloader)

    # raw_preds is list of tensors; stack and flatten
    all_preds = torch.cat(raw_preds).cpu().numpy().squeeze()
    idxs = dataset.index_to_series()
    times = dataset.index_to_time()

    out_df = pd.DataFrame({
        GROUP_COL: idxs[:, 0],
        TIME_COL:  times[:, 0],
        f"pred_{TARGET_COL}": all_preds
    })
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    out_df.to_csv(OUTPUT_PATH, index=False)
    print(f"✅ Predictions saved to {OUTPUT_PATH}")

if __name__ == "__main__":
    run_inference()
