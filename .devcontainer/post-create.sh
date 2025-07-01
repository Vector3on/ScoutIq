#!/bin/bash

# This script runs after the Codespace is created to install our specific dependencies.
echo "--- [Codespace Setup] Installing pinned Python dependencies ---"

# Use pip to install the exact, stable library versions we need.
pip install --upgrade pip
pip install -r requirements.txt

echo "✅ Environment setup complete. Your Codespace is ready."

