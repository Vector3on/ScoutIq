import sqlite3
import os
from fuzzywuzzy import fuzz

# --- CONFIGURATION ---
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'leads.db')
SIMILARITY_THRESHOLD = 80

def resolve_github_leads():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    cur.execute("SELECT * FROM github_leads WHERE project_id IS NULL")
    unresolved_leads = cur.fetchall()
    if not unresolved_leads: con.close(); return
    for lead in unresolved_leads:
        project_name = lead['repo_name']
        cur.execute("INSERT INTO projects (display_name, primary_url) VALUES (?, ?) ON CONFLICT(display_name) DO NOTHING", (project_name, lead['url']))
        cur.execute("SELECT id FROM projects WHERE display_name = ?", (project_name,))
        project_id = cur.fetchone()['id']
        cur.execute("UPDATE github_leads SET project_id = ? WHERE id = ?", (project_id, lead['id']))
    con.commit()
    con.close()

def resolve_reddit_leads():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    cur.execute("SELECT * FROM reddit_leads WHERE project_id IS NULL")
    unresolved_leads = cur.fetchall()
    if not unresolved_leads: con.close(); return
    cur.execute("SELECT id, display_name FROM projects")
    projects = cur.fetchall()
    for lead in unresolved_leads:
        best_match_score, best_match_project_id = 0, None
        for project in projects:
            score = fuzz.token_set_ratio(lead['title'], project['display_name'])
            if score > best_match_score:
                best_match_score, best_match_project_id = score, project['id']
        if best_match_score >= SIMILARITY_THRESHOLD:
            cur.execute("UPDATE reddit_leads SET project_id = ? WHERE id = ?", (best_match_project_id, lead['id']))
    con.commit()
    con.close()

def run_resolver():
    print("  - Running Entity Resolver...")
    resolve_github_leads()
    resolve_reddit_leads()
    print("    - Entity resolution finished.")

if __name__ == '__main__':
    run_resolver()
