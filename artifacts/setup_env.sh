#!/bin/bash
set -e

echo "--- [SETUP SCRIPT] Creating Virtual Environment ---"
python3 -m venv bloodhound_env

echo "--- [SETUP SCRIPT] Installing Dependencies into Virtual Environment ---"
./bloodhound_env/bin/pip install --upgrade pip
./bloodhound_env/bin/pip install -r requirements.txt

echo "--- [SETUP SCRIPT] Environment setup complete. ---"
