import sqlite3
import os

PROJECT_PATH = "/content/drive/MyDrive/bloodhound-vc"
DB_NAME = os.path.join(PROJECT_PATH, "data/leads.db")

try:
    con = sqlite3.connect(DB_NAME)
    cur = con.cursor()

    # --- Table for GitHub Leads ---
    cur.execute("""
    CREATE TABLE IF NOT EXISTS github_leads (
        id INTEGER PRIMARY KEY,
        repo_name TEXT NOT NULL,
        owner TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        stars INTEGER,
        language TEXT,
        score INTEGER DEFAULT 0,
        scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """)
    print("Table 'github_leads' is ready.")

    # --- NEW: Table for Reddit Leads ---
    cur.execute("""
    CREATE TABLE IF NOT EXISTS reddit_leads (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        subreddit TEXT NOT NULL,
        upvotes INTEGER,
        scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """)
    print("Table 'reddit_leads' is ready.")

    con.commit()
    con.close()
    print(f"\nDATABASE INITIALIZATION: SUCCESS. All tables are ready in '{DB_NAME}'.")

except Exception as e:
    print(f"DATABASE INITIALIZATION: FAILED. Error: {e}")