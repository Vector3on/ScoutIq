import os
# --- CONFIGURATION ---
# Credentials will be read from GitHub Actions secrets
SLACK_BOT_TOKEN = os.environ.get("SLACK_BOT_TOKEN")
SLACK_CHANNEL_ID = "C0928V1HUSE" # This must still be correct