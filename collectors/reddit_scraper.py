import os
import sqlite3
import praw

# --- CONFIGURATION ---
REDDIT_CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET")
REDDIT_USER_AGENT = "Bloodhound Scraper v1.0 by Vector3on"
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'leads.db')
TARGET_SUBREDDITS = ["SideProject", "alphaandbetausers", "indiehackers", "smallbusiness"]
KEYWORD_TRIGGERS = ["new project", "my new app", "looking for feedback", "beta test", "just launched"]

def setup_reddit_client():
    if not REDDIT_CLIENT_ID or not REDDIT_CLIENT_SECRET:
        return None
    return praw.Reddit(client_id=REDDIT_CLIENT_ID, client_secret=REDDIT_CLIENT_SECRET, user_agent=REDDIT_USER_AGENT)

def scrape_reddit_submissions():
    print("  - Scraping Reddit...")
    reddit = setup_reddit_client()
    if not reddit:
        print("    - FATAL: Reddit credentials not found in environment.")
        return

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    leads_found = 0
    
    for subreddit_name in TARGET_SUBREDDITS:
        subreddit = reddit.subreddit(subreddit_name)
        try:
            for submission in subreddit.new(limit=25):
                title_lower = submission.title.lower()
                if any(keyword in title_lower for keyword in KEYWORD_TRIGGERS):
                    lead_data = {"title": submission.title, "url": submission.url, "subreddit": subreddit_name, "upvotes": submission.score}
                    cur.execute("INSERT INTO reddit_leads (title, url, subreddit, upvotes) VALUES (:title, :url, :subreddit, :upvotes) ON CONFLICT(url) DO NOTHING", lead_data)
                    leads_found += 1
        except Exception:
            continue
            
    con.commit()
    con.close()
    print(f"    - Reddit: Found and processed {leads_found} potential leads.")

if __name__ == '__main__':
    scrape_reddit_submissions()
