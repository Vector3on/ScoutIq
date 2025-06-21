import sqlite3
import os
import re
from urllib.parse import urlparse
from fuzzywuzzy import fuzz

DB_PATH = '/content/drive/MyDrive/bloodhound-vc/data/leads.db'
# We can be more confident now, but we'll still keep debug on.
SIMILARITY_THRESHOLD = 80
DEBUG_MODE = True

def resolve_github_leads():
    """Creates master project records from new GitHub leads."""
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    cur.execute("SELECT * FROM github_leads WHERE project_id IS NULL")
    unresolved_leads = cur.fetchall()

    if not unresolved_leads:
        print("  - No new GitHub leads to resolve.")
        con.close()
        return

    print(f"  - Resolving {len(unresolved_leads)} GitHub leads into projects.")
    for lead in unresolved_leads:
        project_name = lead['repo_name']
        try:
            cur.execute("INSERT INTO projects (display_name, primary_url) VALUES (?, ?) ON CONFLICT(display_name) DO NOTHING", (project_name, lead['url']))
            cur.execute("SELECT id FROM projects WHERE display_name = ?", (project_name,))
            project_id = cur.fetchone()['id']
            cur.execute("UPDATE github_leads SET project_id = ? WHERE id = ?", (project_id, lead['id']))
        except: continue
    con.commit()
    con.close()
    print(f"  - GitHub resolution complete.")

def resolve_reddit_leads():
    """
    Attempts to link Reddit leads to projects using a tiered logic:
    1. Direct GitHub URL match.
    2. Fuzzy match on potential project names in the title.
    """
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    cur.execute("SELECT * FROM reddit_leads WHERE project_id IS NULL")
    unresolved_leads = cur.fetchall()

    if not unresolved_leads:
        print("  - No new Reddit leads to resolve.")
        con.close()
        return

    print(f"  - Linking {len(unresolved_leads)} Reddit leads with professional-grade logic...")
    
    # Get all GitHub URLs and projects for matching
    cur.execute("SELECT project_id, url FROM github_leads WHERE project_id IS NOT NULL")
    github_urls = {row['url']: row['project_id'] for row in cur.fetchall()}
    
    cur.execute("SELECT id, display_name FROM projects")
    projects = cur.fetchall()
    
    linked_count = 0
    for lead in unresolved_leads:
        project_id = None
        match_method = "None"

        # Tier 1: Direct URL Match
        parsed_url = urlparse(lead['url'])
        if parsed_url.netloc == 'github.com':
            if lead['url'] in github_urls:
                project_id = github_urls[lead['url']]
                match_method = "Direct URL"

        # Tier 2: Fuzzy Match on a likely project name from the title
        if not project_id:
            # Simple extraction: find capitalized words or words after "my app/project"
            # This is a basic heuristic and can be improved.
            potential_names = re.findall(r'\b[A-Z][a-zA-Z0-9-]+\b', lead['title'])
            if potential_names:
                best_score = 0
                for name in potential_names:
                    for project in projects:
                        score = fuzz.ratio(name, project['display_name'])
                        if score > best_score:
                            best_score = score
                            if best_score >= SIMILARITY_THRESHOLD:
                                project_id = project['id']
                                match_method = f"Fuzzy Match on '{name}'"
                
                if DEBUG_MODE and not project_id:
                     print(f"    - For '{lead['title'][:30]}...', best fuzzy candidate score was {best_score}% (Threshold: {SIMILARITY_THRESHOLD}%)")


        if project_id:
            try:
                cur.execute("UPDATE reddit_leads SET project_id = ? WHERE id = ?", (project_id, lead['id']))
                print(f"    - >>> LINKED: '{lead['title'][:30]}...' via {match_method}")
                linked_count += 1
            except sqlite3.Error:
                continue
    
    con.commit()
    con.close()
    print(f"  - Reddit resolution complete. {linked_count} new links found.")

def run_resolver():
    """Main function to run all entity resolution steps."""
    print("Initiating Professional Entity Resolution...")
    resolve_github_leads()
    resolve_reddit_leads()
    print("Professional Entity Resolution Finished.")

if __name__ == '__main__':
    run_resolver()
