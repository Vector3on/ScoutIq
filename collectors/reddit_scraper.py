import os
from neo4j import GraphDatabase
from fuzzywuzzy import fuzz
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
SIMILARITY_THRESHOLD = 80

def setup_reddit_client():
    if not REDDIT_CLIENT_ID or not REDDIT_CLIENT_SECRET:
        return None
    return praw.Reddit(client_id=REDDIT_CLIENT_ID, client_secret=REDDIT_CLIENT_SECRET, user_agent=REDDIT_USER_AGENT)

def create_and_link_reddit_signal(tx, signal_data):
    """
    First, creates a new Signal node.
    Then, it searches for a matching Project and creates a relationship if found.
    """
    # Step 1: Unconditionally create the Signal node.
    # MERGE ensures we don't create duplicate signals based on URL.
    create_signal_query = """
    MERGE (s:Signal:Reddit {url: $url})
    ON CREATE SET
        s.title = $title,
        s.subreddit = $subreddit,
        s.upvotes = $upvotes,
        s.created_at = timestamp()
    RETURN s
    """
    tx.run(create_signal_query, **signal_data)

    # Step 2: Find the best matching project and attempt to create a link.
    link_query = """
    MATCH (s:Signal:Reddit {url: $url})
    MATCH (p:Project)
    WITH s, p, apoc.text.sorensenDiceSimilarity($title, p.display_name) AS score
    WHERE score >= $threshold
    WITH s, p, score
    ORDER BY score DESC
    LIMIT 1
    MERGE (p)-[r:HAS_SIGNAL]->(s)
    """
    # The neo4j driver uses a library that needs the threshold as 0.0 to 1.0
    tx.run(link_query, **signal_data, threshold=SIMILARITY_THRESHOLD / 100.0)

def scrape_reddit_submissions():
    """Scrapes Reddit and creates/updates Signal nodes in the Neo4j database."""
    print("  - Scraping Reddit (v2 Logic)...")
    if not URI:
        print("    - FATAL: Neo4j credentials not found.")
        return

    reddit = setup_reddit_client()
    if not reddit:
        print("    - FATAL: Reddit credentials not found.")
        return

    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    processed_count = 0
    
    with driver.session() as session:
        for subreddit_name in TARGET_SUBREDDITS:
            subreddit = reddit.subreddit(subreddit_name)
            try:
                for submission in subreddit.new(limit=25):
                    title_lower = submission.title.lower()
                    if any(keyword in title_lower for keyword in KEYWORD_TRIGGERS):
                        signal_data = {
                            "title": submission.title,
                            "url": submission.url,
                            "subreddit": subreddit_name,
                            "upvotes": submission.score
                        }
                        # This transaction now correctly creates the node first, then tries to link it.
                        session.execute_write(create_and_link_reddit_signal, signal_data)
                        processed_count += 1
            except Exception as e:
                # Add more detailed error logging
                print(f"    - Error processing subreddit {subreddit_name}: {e}")
                continue
    
    driver.close()
    print(f"    - Reddit: Processed {processed_count} potential signals into the graph.")

if __name__ == '__main__':
    scrape_reddit_submissions()
