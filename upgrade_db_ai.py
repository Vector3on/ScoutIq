import sqlite3
import os

PROJECT_PATH = "/content/drive/MyDrive/bloodhound-vc"
DB_NAME = os.path.join(PROJECT_PATH, "data/leads.db")

print("AI DATABASE UPGRADE INITIATED.")

try:
    con = sqlite3.connect(DB_NAME)
    cur = con.cursor()
    print("Connected to database. Applying AI schema changes...")

    # We use a try/except block because this will fail if the columns already exist.
    try:
        cur.execute("ALTER TABLE projects ADD COLUMN ai_summary TEXT;")
        print("- Added 'ai_summary' column to 'projects' table.")
    except sqlite3.OperationalError:
        print("- 'ai_summary' column already exists. Skipping.")

    try:
        cur.execute("ALTER TABLE projects ADD COLUMN ai_hype_score INTEGER DEFAULT 0;")
        print("- Added 'ai_hype_score' column to 'projects' table.")
    except sqlite3.OperationalError:
        print("- 'ai_hype_score' column already exists. Skipping.")
        
    try:
        cur.execute("ALTER TABLE projects ADD COLUMN ai_last_analyzed TIMESTAMP;")
        print("- Added 'ai_last_analyzed' column to 'projects' table.")
    except sqlite3.OperationalError:
        print("- 'ai_last_analyzed' column already exists. Skipping.")

    con.commit()
    con.close()
    print("\nDATABASE UPGRADE: SUCCESS. Schema is now AI-ready.")

except Exception as e:
    print(f"\nDATABASE UPGRADE: FAILED. Error: {e}")
