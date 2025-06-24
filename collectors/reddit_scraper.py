import os
from neo4j import GraphDatabase
import praw

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
    query = """
    MERGE (s:Signal:Reddit {url: $url})
    WITH s, s.upvotes AS old_upvotes
    SET s.title = $title,
        s.subreddit = $subreddit,
        s.upvotes = $upvotes,
        s.first_seen_at = COALESCE(s.first_seen_at, timestamp()),
        s.last_seen_at = timestamp(),
        s.upvote_delta_1d = CASE WHEN old_upvotes IS NOT NULL THEN $upvotes - old_upvotes ELSE 0 END
    """
    tx.run(query, **signal_data)

def scrape_reddit_submissions():
    print("  - Scraping Reddit (Velocity-Aware)...")
    if not URI: return
    reddit = setup_reddit_client()
    if not reddit: return
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    processed_count = 0
    with driver.session() as session:
        for subreddit_name in TARGET_SUBREDDITS:
            try:
                for submission in reddit.subreddit(subreddit_name).new(limit=50):
                    if any(keyword in submission.title.lower() for keyword in KEYWORD_TRIGGERS):
                        signal_data = {"title": submission.title, "url": submission.url, "subreddit": subreddit_name, "upvotes": submission.score}
                        session.execute_write(create_or_update_reddit_signal, signal_data)
                        processed_count += 1
            except Exception as e:
                print(f"    - WARN: Could not process r/{subreddit_name}. Error: {e}")
                continue
    print(f"    - Reddit: Processed {processed_count} potential signals.")
    driver.close()

if __name__ == '__main__':
    scrape_reddit_submissions()
