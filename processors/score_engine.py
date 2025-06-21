import sqlite3
import json
import os

# --- CONFIGURATION ---
SCRIPT_DIR = os.path.dirname(__file__)
DB_PATH = os.path.join(SCRIPT_DIR, '..', 'data', 'leads.db')
CONFIG_PATH = os.path.join(SCRIPT_DIR, '..', 'scoring_config.json')

def calculate_project_scores():
    print("  - Running Unified Scoring Engine...")
    try:
        with open(CONFIG_PATH, 'r') as f: config = json.load(f)
        github_rules = config.get("github_rules", [])
        reddit_rules = config.get("reddit_rules", [])
    except Exception as e:
        print(f"    - FATAL: Could not load scoring config. Error: {e}"); return

    try:
        con = sqlite3.connect(DB_PATH)
        con.row_factory = sqlite3.Row
        cur = con.cursor()
    except Exception as e:
        print(f"    - FATAL: Could not connect to database. Error: {e}"); return

    cur.execute("SELECT id, display_name FROM projects")
    projects = cur.fetchall()

    updates_to_perform = []
    for project in projects:
        score = 0
        # Aggregate GitHub Signals
        cur.execute("SELECT stars, language FROM github_leads WHERE project_id = ?", (project['id'],))
        gh_lead = cur.fetchone()
        if gh_lead:
            for rule in github_rules:
                if eval(rule["condition"], {"lead": gh_lead}): score += rule["points"]

        # Aggregate Reddit Signals
        cur.execute("SELECT SUM(upvotes) as total_upvotes FROM reddit_leads WHERE project_id = ?", (project['id'],))
        reddit_data = cur.fetchone()
        total_upvotes = reddit_data['total_upvotes'] if reddit_data and reddit_data['total_upvotes'] else 0
        
        if total_upvotes > 0:
            for rule in reddit_rules:
                if eval(rule["condition"], {"reddit": {"total_upvotes": total_upvotes}}): score += rule["points"]

        updates_to_perform.append((score, project['id']))

    cur.executemany("UPDATE projects SET score = ? WHERE id = ?", updates_to_perform)
    con.commit()
    print(f"    - Unified scoring complete. Updated {cur.rowcount} project scores.")
    con.close()

if __name__ == '__main__':
    calculate_project_scores()
