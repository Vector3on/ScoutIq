import sqlite3
import os

DB_PATH = '/content/drive/MyDrive/bloodhound-vc/data/leads.db'

def run_diagnostic_injection():
    """
    Injects a test Reddit lead into the database that is designed
    to be a perfect match for an existing GitHub project.
    """
    print("DIAGNOSTIC TOOL: INITIATED.")
    if not os.path.exists(DB_PATH):
        print("FATAL: Database not found. Cannot run diagnostic.")
        return

    try:
        con = sqlite3.connect(DB_PATH)
        con.row_factory = sqlite3.Row
        cur = con.cursor()
    except Exception as e:
        print(f"FATAL: Could not connect to database. Error: {e}")
        return

    # Find the first project to use as our target
    cur.execute("SELECT display_name FROM projects LIMIT 1")
    target_project = cur.fetchone()

    if not target_project:
        print("FATAL: No projects found in the database. Scrape data first.")
        con.close()
        return
        
    target_project_name = target_project['display_name']
    print(f"  - Target project for test injection: '{target_project_name}'")

    # Craft the perfect Reddit post title
    test_title = f"Looking for beta testers for my new project, {target_project_name}!"
    test_url = f"https://www.reddit.com/r/test/comments/fake_id_for_{target_project_name}"
    
    try:
        print(f"  - Injecting test lead into 'reddit_leads' table...")
        cur.execute("""
            INSERT INTO reddit_leads (title, url, subreddit, upvotes)
            VALUES (?, ?, 'TestSub', 100)
            ON CONFLICT(url) DO NOTHING
        """, (test_title, test_url))
        con.commit()
        print("  - SUCCESS: Test lead injected.")
    except Exception as e:
        print(f"  - FAILED: Could not inject test lead. Error: {e}")
    finally:
        con.close()
        
    print("DIAGNOSTIC TOOL: FINISHED.")

if __name__ == '__main__':
    run_diagnostic_injection()
