import sqlite3
import os
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError
import pandas as pd

# --- CONFIGURATION ---
# Credentials will be read from GitHub Actions secrets
SLACK_BOT_TOKEN = os.environ.get("SLACK_BOT_TOKEN")
SLACK_CHANNEL_ID = "C0928V1HUSE" # Make sure your channel ID is correct
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'leads.db')