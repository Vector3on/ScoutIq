import os
from neo4j import GraphDatabase
import praw

# --- CONFIGURATION ---
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")
REDDIT_CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET")
REDDIT_USER_AGENT = "Bloodhound Scraper v1.0 by Vector3on"

TARGET_SUBREDDITS = ["SideProject", "alphaandbetausers", "indiehackers", "smallbusiness"]
KEYWORD_TRIGGERS = ["new project", "my new app", "looking for feedback", "beta test", "just launched"]

def setup_reddit_client():
    if not REDDIT_CLIENT_ID or not REDDIT_CLIENT_SECRET: return None
    return praw.Reddit(client_id=REDDIT_CLIENT_ID, client_secret=REDDIT_CLIENT_SECRET, user_agent=REDDIT_USER_AGENT)

def create_or_update_reddit_signal(tx, signal_data):
    """
    This robust query correctly creates or updates a Signal node
    and calculates its upvote velocity on every run.
    """
    query = """
    MERGE (s:Signal:Reddit {url: $url})
    // WITH s allows us to hold onto its state before we change it
    WITH s, s.upvotes AS old_upvotes
    // Now, SET all properties, using the old value for our calculation
    SET s.title = $title,
        s.subreddit = $subreddit,
        s.upvotes = $upvotes,
        s.first_seen_at = COALESCE(s.first_seen_at, timestamp()), // Only set first_seen_at if it's new
        s.last_seen_at = timestamp(),
        // Calculate the delta correctly: new_votes - old_votes
        s.upvote_delta_1d = CASE WHEN old_upvotes IS NOT NULL THEN $upvotes - old_upvotes ELSE 0 END
    """
    tx.run(query, **signal_data)

def scrape_reddit_submissions():
    """Scrapes Reddit and creates/updates Signal nodes with upvote velocity."""
    print("  - Scraping Reddit (Velocity-Aware)...")
    if not URI: print("    - FATAL: Neo4j credentials not found."); return
    reddit = setup_reddit_client()
    if not reddit: print("    - FATAL: Reddit credentials not found."); return

    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    processed_count = 0
    
    with driver.session() as session:
        for subreddit_name in TARGET_SUBREDDITS:
            try:
                # Increased limit to get more potential signals
                for submission in reddit.subreddit(subreddit_name).new(limit=50):
                    title_lower = submission.title.lower()
                    if any(keyword in title_lower for keyword in KEYWORD_TRIGGERS):
                        signal_data = {
                            "title": submission.title,
                            "url": submission.url,
                            "subreddit": subreddit_name,
                            "upvotes": submission.score
                        }
                        session.execute_write(create_or_update_reddit_signal, signal_data)
                        processed_count += 1
            except Exception as e:
                print(f"    - WARN: Could not process r/{subreddit_name}. Error: {e}")
                continue
    
    driver.close()
    print(f"    - Reddit: Processed {processed_count} potential signals, updating velocity.")

if __name__ == '__main__':
    scrape_reddit_submissions()
