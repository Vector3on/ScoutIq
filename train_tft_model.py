
# 📈 train_tft_model.py — Colab-Optimized Version

import os
import pytorch_lightning as pl
from pytorch_lightning.callbacks.early_stopping import EarlyStopping
from pytorch_lightning.callbacks import ModelCheckpoint

from pytorch_forecasting import TemporalFusionTransformer, TimeSeriesDataSet
from pytorch_forecasting.data import NaNLabelEncoder

import torch
import pandas as pd

# Paths
DATA_PATH = "artifacts/tft_input.csv"
MODEL_SAVE_PATH = "artifacts/tft_model.ckpt"

# Hyperparams (Colab-optimized)
max_encoder_length = 168  # One week
max_prediction_length = 48  # Two days
max_epochs = 30

# Load data
data = pd.read_csv(DATA_PATH)
data['time_idx'] = data['time_idx'].astype(int)

# Define dataset
training = TimeSeriesDataSet(
    data[lambda x: x.time_idx < x.time_idx.max() - max_prediction_length],
    time_idx="time_idx",
    target="target",
    group_ids=["repo_id"],
    max_encoder_length=max_encoder_length,
    max_prediction_length=max_prediction_length,
    time_varying_known_reals=["time_idx"],
    time_varying_unknown_reals=["target"],
    target_normalizer=NaNLabelEncoder(),
)

validation = TimeSeriesDataSet.from_dataset(training, data, predict=True, stop_randomization=True)

# Dataloaders
batch_size = 64
train_dataloader = training.to_dataloader(train=True, batch_size=batch_size, num_workers=0)
val_dataloader = validation.to_dataloader(train=False, batch_size=batch_size, num_workers=0)

# Callbacks
checkpoint_callback = ModelCheckpoint(
    dirpath="artifacts",
    filename="tft_model",
    monitor="val_loss",
    mode="min",
    save_top_k=1,
)

early_stop_callback = EarlyStopping(
    monitor="val_loss",
    min_delta=1e-4,
    patience=5,
    verbose=True,
    mode="min"
)

# Model
tft = TemporalFusionTransformer.from_dataset(
    training,
    learning_rate=0.03,
    hidden_size=32,
    attention_head_size=4,
    dropout=0.1,
    loss=torch.nn.MSELoss(),
    log_interval=10,
    reduce_on_plateau_patience=4,
)

# Train
trainer = pl.Trainer(
    max_epochs=max_epochs,
    accelerator="gpu",
    devices=1,
    gradient_clip_val=0.1,
    callbacks=[early_stop_callback, checkpoint_callback],
)

trainer.fit(tft, train_dataloaders=train_dataloader, val_dataloaders=val_dataloader)

# Save model
trainer.save_checkpoint(MODEL_SAVE_PATH)
print(f"✅ Model saved to {MODEL_SAVE_PATH}")
