import os
import sqlite3
import praw

# --- CONFIGURATION (Ensure this is filled out) ---
REDDIT_CLIENT_ID = "m2Tu9D75F079l08WDa8lQw"
REDDIT_CLIENT_SECRET = "7o2WxNr45THT1NOeE9w91v-N5xvGIw"
REDDIT_USER_AGENT = "Bloodhound Scraper v1.0 by fogwalk3r"

TARGET_SUBREDDITS = ["SideProject", "alphaandbetausers", "indiehackers", "smallbusiness"]
KEYWORD_TRIGGERS = ["new project", "my new app", "looking for feedback", "beta test", "just launched"]
DB_PATH = '/content/drive/MyDrive/bloodhound-vc/data/leads.db'

def setup_reddit_client():
    if REDDIT_CLIENT_ID.startswith("YOUR_"): return None
    if REDDIT_CLIENT_SECRET.startswith("YOUR_"): return None
    return praw.Reddit(client_id=REDDIT_CLIENT_ID, client_secret=REDDIT_CLIENT_SECRET, user_agent=REDDIT_USER_AGENT)

def save_lead_to_db(con, cur, lead_data):
    """Saves a single Reddit lead to the database, ignoring duplicates."""
    try:
        cur.execute("""
            INSERT INTO reddit_leads (title, url, subreddit, upvotes)
            VALUES (:title, :url, :subreddit, :upvotes)
            ON CONFLICT(url) DO NOTHING
        """, lead_data)
    except Exception as e:
        print(f"  - DB Error for {lead_data['title']}: {e}")

def scrape_reddit_submissions():
    """Scrapes target subreddits and saves findings to the database."""
    print("Initiating Reddit scrape...")
    reddit = setup_reddit_client()
    if not reddit:
        print("FATAL: Reddit credentials are not set in the script. Aborting.")
        return

    try:
        con = sqlite3.connect(DB_PATH)
        cur = con.cursor()
    except Exception as e:
        print(f"FATAL: Could not connect to database. Error: {e}")
        return

    print(f"Searching in subreddits: {', '.join(TARGET_SUBREDDITS)}")
    leads_found = 0

    for subreddit_name in TARGET_SUBREDDITS:
        subreddit = reddit.subreddit(subreddit_name)
        try:
            for submission in subreddit.new(limit=25):
                title_lower = submission.title.lower()
                if any(keyword in title_lower for keyword in KEYWORD_TRIGGERS):
                    lead_data = {
                        "title": submission.title,
                        "url": submission.url,
                        "subreddit": subreddit_name,
                        "upvotes": submission.score
                    }
                    save_lead_to_db(con, cur, lead_data)
                    leads_found += 1
        except Exception as e:
            print(f"Could not access r/{subreddit_name}. Error: {e}")
            continue
    
    con.commit()
    con.close()
    print(f"\nReddit scrape complete. Processed {leads_found} potential leads into the database.")

if __name__ == '__main__':
    scrape_reddit_submissions()