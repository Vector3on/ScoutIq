import os
import sqlite3
import praw

# --- CONFIGURATION ---
# Credentials will be read from GitHub Actions secrets (environment variables)
REDDIT_CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET")
REDDIT_USER_AGENT = "Bloodhound Scraper v1.0 by Vector3on"
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'leads.db')