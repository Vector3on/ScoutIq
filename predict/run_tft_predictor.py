# predict/run_tft_predictor.py
#
# Final version using real column: star_count

import os
import polars as pl
import torch
from pytorch_forecasting import TimeSeriesDataSet, TemporalFusionTransformer
from pytorch_forecasting.data import GroupNormalizer
from pytorch_lightning import Trainer
import pandas as pd

def run_tft_predictor():
    print("\n--- Starting Temporal Fusion Transformer Predictor ---")

    # Step 1: Load data
    print("Loading time-series data from artifacts/timeseries_data.parquet...")
    df = pl.read_parquet("artifacts/timeseries_data.parquet")
    data = df.to_pandas()

    # Step 2: DEBUG actual columns
    print("📊 Columns in DataFrame:", data.columns.tolist())
    print("🔎 First 5 rows:")
    print(data.head(5))

    # Step 3: Convert target column
    print("✅ Converting 'star_count' to float32...")
    if not pd.api.types.is_float_dtype(data["star_count"]):
        data["star_count"] = data["star_count"].astype("float32")

    # Step 4: Build dataset
    print("⚙️ Creating TimeSeriesDataSet...")
    dataset = TimeSeriesDataSet(
        data,
        time_idx="time_idx",
        target="star_count",
        group_ids=["series_id"],
        max_encoder_length=24,
        max_prediction_length=12,
        static_categoricals=[],
        static_reals=[],
        time_varying_known_categoricals=[],
        time_varying_known_reals=["time_idx"],
        time_varying_unknown_categoricals=[],
        time_varying_unknown_reals=["star_count"],
        target_normalizer=GroupNormalizer(groups=["series_id"]),
        add_relative_time_idx=True,
        add_target_scales=True,
        add_encoder_length=True
    )

    # Step 5: Dataloader
    print("📦 Creating dataloader...")
    val_dataloader = dataset.to_dataloader(train=False, batch_size=64, num_workers=0)

    # Step 6: Load model
    model_path = "checkpoints/tft_model.ckpt"
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"❌ Model checkpoint not found at {model_path}")
    print("📥 Loading trained model from:", model_path)
    model = TemporalFusionTransformer.load_from_checkpoint(model_path)

    # Step 7: Run prediction
    print("🤖 Running predictions...")
    trainer = Trainer(logger=False, enable_checkpointing=False, max_epochs=1)
    predictions = trainer.predict(model, dataloaders=val_dataloader)

    # Step 8: Save results
    print("💾 Saving predictions to results/tft_predictions.pt...")
    os.makedirs("results", exist_ok=True)
    torch.save(predictions, "results/tft_predictions.pt")

    print("✅ TFT Prediction Completed.")

if __name__ == "__main__":
    run_tft_predictor()
