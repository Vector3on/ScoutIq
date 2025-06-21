import os
# --- CONFIGURATION ---
# Credentials will be read from GitHub Actions secrets (environment variables)
REDDIT_CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET")
REDDIT_USER_AGENT = "Bloodhound Scraper v1.0 by Vector3on"