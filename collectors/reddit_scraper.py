# collectors/reddit_scraper.py
#
# Retargeted to focus on AI Agent projects and subreddits.

import os
import sys
import praw
from neo4j import GraphDatabase

# --- Configuration ---
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")

# --- NEW: AI AGENT TARGETS ---
PROJECT_KEYWORDS = {
    "langchain-ai/langchain": ["langchain"],
    "microsoft/autogen": ["autogen"],
    "e2b-dev/e2b": ["e2b", "e2b.dev"],
    "a16z-infra/ai-town": ["ai town"],
    "superagent-ai/superagent": ["superagent"],
}

# Subreddits focused on AI and agentic systems
SUBREDDITS_TO_SCAN = ["MachineLearning", "LocalLLaMA", "LangChain", "OpenAI", "Singularity"]

class RedditScraper:
    def __init__(self, uri, user, password, reddit_client):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        self.reddit = reddit_client
        self.processed_signals = set()

    def close(self):
        self.driver.close()

    def scan_and_update(self):
        print("  - Scraping Reddit for AI Agent signals...")
        with self.driver.session(database="neo4j") as session:
            for subreddit_name in SUBREDDITS_TO_SCAN:
                print(f"    - Scanning r/{subreddit_name}...")
                subreddit = self.reddit.subreddit(subreddit_name)
                for submission in subreddit.hot(limit=25):
                    self.search_text_for_signals(session, submission.title, submission)
                    submission.comments.replace_more(limit=0)
                    for comment in submission.comments.list():
                        self.search_text_for_signals(session, comment.body, submission)

    def search_text_for_signals(self, session, text_to_search, submission):
        for project_id, keywords in PROJECT_KEYWORDS.items():
            if any(keyword.lower() in text_to_search.lower() for keyword in keywords):
                signal_key = f"{project_id}_{submission.id}"
                if signal_key not in self.processed_signals:
                    self.create_or_update_signal(session, project_id, submission)
                    self.processed_signals.add(signal_key)
                    break 

    def create_or_update_signal(self, session, project_id, submission):
        print(f"      - Found mention of '{project_id}' in submission: {submission.id}")
        query = """
        MATCH (p:Project {project_id: $project_id})
        MERGE (s:Signal {url: $url})
        ON CREATE SET
            s.title = $title, s.source = 'Reddit', s.upvotes = $upvotes,
            s.created_at = datetime({epochSeconds: $created_utc}),
            s.last_scraped_at = timestamp()
        MERGE (p)-[r:HAS_SIGNAL]->(s)
        """
        session.run(query,
            project_id=project_id, url=submission.permalink, title=submission.title,
            upvotes=submission.score, created_utc=int(submission.created_utc)
        )

def main():
    CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID")
    CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET")
    USER_AGENT = os.environ.get("REDDIT_USER_AGENT")

    if not all([CLIENT_ID, CLIENT_SECRET, USER_AGENT]):
        print("    - WARN: Reddit credentials not found. Skipping.")
        sys.exit(0)

    try:
        reddit = praw.Reddit(client_id=CLIENT_ID, client_secret=CLIENT_SECRET, user_agent=USER_AGENT)
        if reddit.read_only: print("  - Successfully authenticated with Reddit in read-only mode.")
        scraper = RedditScraper(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, reddit)
        scraper.scan_and_update()
        scraper.close()
    except Exception as e:
        print(f"    - ERROR: Reddit scraping failed: {e}")
        sys.exit(0)

if __name__ == "__main__":
    main()
