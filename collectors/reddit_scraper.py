# collectors/reddit_scraper.py
#
# This version includes a more accurate login message for read-only mode.

import os
import sys
import praw
from neo4j import GraphDatabase

PROJECT_KEYWORDS = {
    "ollama/ollama": ["ollama"],
    "ggerganov/llama.cpp": ["llama.cpp", "llama cpp"],
    "langchain-ai/langchain": ["langchain"],
    "vllm-project/vllm": ["vllm"],
    "huggingface/transformers": ["huggingface", "transformers"],
}
SUBREDDITS_TO_SCAN = ["MachineLearning", "LocalLLaMA", "programming", "Python", "datascience"]

class RedditScraper:
    def __init__(self, uri, user, password, reddit_client):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        self.reddit = reddit_client

    def close(self):
        self.driver.close()

    def scan_and_update(self):
        print("  - Scraping Reddit (Velocity-Aware)...")
        with self.driver.session(database="neo4j") as session:
            for subreddit_name in SUBREDDITS_TO_SCAN:
                print(f"    - Scanning r/{subreddit_name}...")
                subreddit = self.reddit.subreddit(subreddit_name)
                for submission in subreddit.hot(limit=25):
                    for project_id, keywords in PROJECT_KEYWORDS.items():
                        if any(keyword.lower() in submission.title.lower() for keyword in keywords):
                            print(f"      - Found mention of '{project_id}' in post: {submission.id}")
                            self.create_or_update_signal(session, project_id, submission)

    def create_or_update_signal(self, session, project_id, submission):
        query = """
        MATCH (p:Project {project_id: $project_id})
        MERGE (s:Signal {url: $url})
        ON CREATE SET
            s.title = $title,
            s.source = 'Reddit',
            s.upvotes = $upvotes,
            s.upvote_delta_1d = 0,
            s.created_at = toDateTime($created_utc),
            s.last_scraped_at = timestamp()
        ON MATCH SET
            s.upvote_delta_1d = $upvotes - s.upvotes,
            s.upvotes = $upvotes,
            s.last_scraped_at = timestamp()
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
    CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID")
    CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET")
    USER_AGENT = os.environ.get("REDDIT_USER_AGENT")

    if not all([CLIENT_ID, CLIENT_SECRET, USER_AGENT]):
        print("    - WARN: Reddit credentials not found. Skipping Reddit scrape.")
        sys.exit(0)

    NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    NEO4J_USER = os.environ.get("NEO4J_USERNAME", "neo4j")
    NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")

    try:
        reddit = praw.Reddit(
            client_id=CLIENT_ID,
            client_secret=CLIENT_SECRET,
            user_agent=USER_AGENT,
        )
        # More accurate message for read-only authentication
        if reddit.read_only:
            print("  - Successfully authenticated with Reddit in read-only mode.")
        else:
             print(f"  - Successfully authenticated with Reddit as: {reddit.user.me()}")
        
        scraper = RedditScraper(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, reddit)
        scraper.scan_and_update()
        scraper.close()
    except Exception as e:
        print(f"    - ERROR: An error occurred during Reddit scraping: {e}")
        sys.exit(0)

if __name__ == "__main__":
    main()
