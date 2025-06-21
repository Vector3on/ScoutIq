import sqlite3
import os

PROJECT_PATH = "/content/drive/MyDrive/bloodhound-vc"
DB_NAME = os.path.join(PROJECT_PATH, "data/leads.db")

print("FINAL DATABASE UPGRADE INITIATED.")

try:
    con = sqlite3.connect(DB_NAME)
    cur = con.cursor()
    print("Connected to database. Applying final schema changes...")

    # --- Add 'score' and 'last_signal' columns to the 'projects' table ---
    # We use a try/except block because this will fail if the columns already exist.
    try:
        cur.execute("ALTER TABLE projects ADD COLUMN score INTEGER DEFAULT 0;")
        print("- Added 'score' column to 'projects' table.")
    except sqlite3.OperationalError:
        print("- 'score' column already exists in 'projects' table. Skipping.")

    try:
        cur.execute("ALTER TABLE projects ADD COLUMN last_signal_source TEXT;")
        print("- Added 'last_signal_source' column to 'projects' table.")
    except sqlite3.OperationalError:
        print("- 'last_signal_source' column already exists in 'projects' table. Skipping.")

    con.commit()
    con.close()
    print("\nDATABASE UPGRADE: SUCCESS. Schema is now finalized.")

except Exception as e:
    print(f"\nDATABASE UPGRADE: FAILED. Error: {e}")

