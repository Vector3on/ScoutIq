import sqlite3
import os

PROJECT_PATH = "/content/drive/MyDrive/bloodhound-vc"
DB_NAME = os.path.join(PROJECT_PATH, "data/leads.db")
DB_BACKUP_NAME = os.path.join(PROJECT_PATH, "data/leads.db.backup")

print("DATABASE UPGRADE SCRIPT INITIATED.")

# --- Step 1: Backup the existing database ---
if os.path.exists(DB_NAME):
    print(f"Backing up existing database to {DB_BACKUP_NAME}...")
    try:
        # Simple copy for backup
        with open(DB_NAME, 'rb') as f_in, open(DB_BACKUP_NAME, 'wb') as f_out:
            f_out.write(f_in.read())
        print("Backup successful.")
    except Exception as e:
        print(f"FATAL: Could not back up database. Aborting. Error: {e}")
        # In a real scenario, you would not proceed. For this exercise, we will.
        
# --- Step 2: Connect and Evolve Schema ---
try:
    con = sqlite3.connect(DB_NAME)
    cur = con.cursor()
    print("\nConnected to database. Evolving schema...")

    # --- NEW: Master 'projects' table ---
    cur.execute("""
    CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY,
        display_name TEXT UNIQUE NOT NULL,
        description TEXT,
        primary_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """)
    print("Table 'projects' is ready.")

    # --- EVOLVED: 'github_leads' table ---
    # We add a project_id to link it to the master table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS github_leads_new (
        id INTEGER PRIMARY KEY,
        project_id INTEGER,
        repo_name TEXT NOT NULL,
        owner TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        stars INTEGER,
        language TEXT,
        score INTEGER DEFAULT 0,
        scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects (id)
    )
    """)
    print("New 'github_leads' schema is ready.")

    # --- EVOLVED: 'reddit_leads' table ---
    # We add a project_id here as well
    cur.execute("""
    CREATE TABLE IF NOT EXISTS reddit_leads_new (
        id INTEGER PRIMARY KEY,
        project_id INTEGER,
        title TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        subreddit TEXT NOT NULL,
        upvotes INTEGER,
        scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects (id)
    )
    """)
    print("New 'reddit_leads' schema is ready.")
    
    # --- Data Migration (simplified for this exercise) ---
    # In a real system, you'd migrate old data. Here, we just replace the tables.
    cur.execute("DROP TABLE IF EXISTS github_leads;")
    cur.execute("ALTER TABLE github_leads_new RENAME TO github_leads;")
    cur.execute("DROP TABLE IF EXISTS reddit_leads;")
    cur.execute("ALTER TABLE reddit_leads_new RENAME TO reddit_leads;")
    print("\nData migration complete. Old tables replaced with new schemas.")

    con.commit()
    con.close()
    print(f"\nDATABASE UPGRADE: SUCCESS. Schema is now ready for Entity Resolution.")

except Exception as e:
    print(f"\nDATABASE UPGRADE: FAILED. Error: {e}")