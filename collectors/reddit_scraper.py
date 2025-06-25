# collectors/reddit_scraper.py
#
# Production-ready Reddit scraper.
# This script connects to the Reddit API using credentials, searches for project
# mentions in specified subreddits, and creates/updates Signal nodes in Neo4j.

import os
import sys
import praw # The Python Reddit API Wrapper
from neo4j import GraphDatabase

# --- Configuration ---

# This mapping tells the scraper which keywords to look for in which subreddits.
# This is highly configurable.
# Format: "project_id_from_github": ["list", "of", "keywords"]
PROJECT_KEYWORDS = {
    "ollama/ollama": ["ollama"],
    "ggerganov/llama.cpp": ["llama.cpp", "llama cpp"],
    "langchain-ai/langchain": ["langchain"],
    "vllm-project/vllm": ["vllm"],
    "huggingface/transformers": ["huggingface", "transformers"],
}

# Subreddits to scan for mentions.
SUBREDDITS_TO_SCAN = [
    "MachineLearning",
    "LocalLLaMA",
    "programming",
    "Python",
    "datascience"
]

class RedditScraper:
    """
    Scrapes Reddit for project mentions and updates the Neo4j graph.
    """

    def __init__(self, uri, user, password, reddit_client):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        self.reddit = reddit_client

    def close(self):
        self.driver.close()

    def scan_and_update(self):
        """
        Scans subreddits for keywords and updates the graph.
        """
        print("  - Scraping Reddit (Velocity-Aware)...")
        with self.driver.session(database="neo4j") as session:
            for subreddit_name in SUBREDDITS_TO_SCAN:
                print(f"    - Scanning r/{subreddit_name}...")
                subreddit = self.reddit.subreddit(subreddit_name)
                
                # We check the "hot" posts, as this is a good source of current signals.
                for submission in subreddit.hot(limit=25):
                    for project_id, keywords in PROJECT_KEYWORDS.items():
                        # Check if any of the project's keywords are in the post title
                        if any(keyword.lower() in submission.title.lower() for keyword in keywords):
                            print(f"      - Found mention of '{project_id}' in post: {submission.id}")
                            self.create_or_update_signal(session, project_id, submission)

    def create_or_update_signal(self, session, project_id, submission):
        """
        Creates or updates a Signal node and connects it to a Project node.
        """
        query = """
        // First, find the Project node this signal belongs to.
        MATCH (p:Project {project_id: $project_id})
        
        // MERGE the Signal node based on its unique URL.
        MERGE (s:Signal {url: $url})

        // On creation, set initial properties.
        ON CREATE SET
            s.title = $title,
            s.source = 'Reddit',
            s.upvotes = $upvotes,
            s.upvote_delta_1d = 0, // Initialize delta to 0
            s.created_at = toDateTime($created_utc),
            s.last_scraped_at = timestamp()

        // On match (if we've seen this signal before), update the velocity.
        ON MATCH SET
            s.upvote_delta_1d = $upvotes - s.upvotes,
            s.upvotes = $upvotes,
            s.last_scraped_at = timestamp()
            
        // Finally, ensure the relationship between Project and Signal exists.
        MERGE (p)-[r:HAS_SIGNAL]->(s)
        """
        session.run(query,
            project_id=project_id,
            url=submission.permalink,
            title=submission.title,
            upvotes=submission.score,
            created_utc=submission.created_utc
        )


def main():
    """
    Main execution block.
    """
    # --- Credentials Check ---
    CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID")
    CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET")
    USER_AGENT = os.environ.get("REDDIT_USER_AGENT")

    if not all([CLIENT_ID, CLIENT_SECRET, USER_AGENT]):
        print("    - WARN: Reddit credentials (REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT) not found. Skipping Reddit scrape.")
        sys.exit(0) # Exit gracefully, not with an error

    NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    NEO4J_USER = os.environ.get("NEO4J_USERNAME", "neo4j")
    NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")

    try:
        reddit = praw.Reddit(
            client_id=CLIENT_ID,
            client_secret=CLIENT_SECRET,
            user_agent=USER_AGENT,
        )
        print(f"  - Successfully authenticated with Reddit as: {reddit.user.me()}")
        
        scraper = RedditScraper(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, reddit)
        scraper.scan_and_update()
        scraper.close()

    except Exception as e:
        print(f"    - ERROR: An error occurred during Reddit scraping: {e}")
        # We exit with 0 so a failure in a single scraper doesn't fail the whole workflow
        sys.exit(0)

if __name__ == "__main__":
    main()
