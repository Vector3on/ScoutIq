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

def create_reddit_signal(tx, signal_data):
    """
    Finds the best matching Project node and creates a new Signal node
    linked to it with a [HAS_SIGNAL] relationship.
    """
    query = """
    // Find all project nodes to match against
    MATCH (p:Project)
    WITH p, apoc.text.sorensenDiceSimilarity($title, p.display_name) AS score
    WHERE score >= $threshold
    WITH p, score
    ORDER BY score DESC
    LIMIT 1

    // If a matching project was found, create the signal and the relationship
    FOREACH (project IN COLLECT(p) |
        MERGE (s:Signal:Reddit {url: $url})
        ON CREATE SET
            s.title = $title,
            s.subreddit = $subreddit,
            s.upvotes = $upvotes,
            s.created_at = timestamp()
        MERGE (project)-[r:HAS_SIGNAL]->(s)
    )
    """
    tx.run(query, **signal_data, threshold=SIMILARITY_THRESHOLD / 100.0) # APOC similarity is 0-1

def scrape_reddit_submissions():
    """Scrapes Reddit and creates/updates Signal nodes in the Neo4j database."""
    print("  - Scraping Reddit (for Neo4j)...")
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
                        session.execute_write(create_reddit_signal, signal_data)
                        processed_count += 1
            except Exception:
                continue
    
    driver.close()
    print(f"    - Reddit: Processed {processed_count} potential signals into the graph.")

if __name__ == '__main__':
    # APOC is a library of procedures for Neo4j. PRAW needs to be installed.
    # The neo4j driver uses a slightly different similarity function that needs a 0-1 score.
    # We will assume APOC is available on AuraDB.
    scrape_reddit_submissions()
