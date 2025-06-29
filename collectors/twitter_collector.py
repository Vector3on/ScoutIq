# collectors/twitter_collector.py
#
# This collector uses the X (Twitter) API v2 to search for recent tweets
# mentioning our target projects.

import os
import sys
import requests
from neo4j import GraphDatabase
from datetime import datetime, timezone

# --- Configuration ---
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")
TWITTER_BEARER_TOKEN = os.environ.get("TWITTER_BEARER_TOKEN")

# --- AI AGENT TARGETS ---
# We search for project names or relevant hashtags
PROJECT_KEYWORDS = {
    "langchain-ai/langchain": "(langchain OR #langchain)",
    "microsoft/autogen": "(autogen OR #autogen)",
    "e2b-dev/e2b": "(e2b.dev OR #e2b)",
    "a16z-infra/ai-town": "(\"ai town\" OR #aitown)",
    "superagent-ai/superagent": "(superagent OR #superagentai)",
}

class TwitterCollector:
    """ Scrapes Twitter for project mentions via the v2 API. """
    API_ENDPOINT = "https://api.twitter.com/2/tweets/search/recent"

    def __init__(self, uri, user, password):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        print("  - Twitter Collector Initialized.")

    def close(self):
        self.driver.close()
        
    def _bearer_oauth(self, r):
        """ Method to handle bearer token authentication. """
        r.headers["Authorization"] = f"Bearer {TWITTER_BEARER_TOKEN}"
        r.headers["User-Agent"] = "BloodhoundVCETL"
        return r

    def search_and_update(self):
        """ Searches for each project keyword and updates the graph. """
        print("  - Scraping Twitter for AI Agent signals...")
        with self.driver.session(database="neo4j") as session:
            for project_id, query in PROJECT_KEYWORDS.items():
                print(f"    - Searching for: {query}")
                params = {
                    'query': f"{query} -is:retweet",
                    'tweet.fields': 'public_metrics,created_at'
                }
                try:
                    response = requests.get(self.API_ENDPOINT, auth=self._bearer_oauth, params=params)
                    if response.status_code != 200:
                        print(f"      - ERROR: Twitter API request failed with status {response.status_code}: {response.text}")
                        continue
                    
                    json_response = response.json()
                    if not json_response.get("data"):
                        print(f"      - No recent tweets found for '{query}'.")
                        continue

                    for tweet in json_response["data"]:
                        self.create_or_update_signal(session, project_id, tweet)

                except Exception as e:
                    print(f"      - ERROR: An exception occurred: {e}")

    def create_or_update_signal(self, session, project_id, tweet):
        """ Creates or updates a Signal node for a Tweet. """
        signal_url = f"https://twitter.com/anyuser/status/{tweet['id']}"
        
        # Convert Twitter's timestamp to a standard format
        created_utc = int(datetime.strptime(tweet['created_at'], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp())
        
        query = """
        MATCH (p:Project {project_id: $project_id})
        MERGE (s:Signal {url: $url})
        ON CREATE SET
            s.title = $title, s.source = 'Twitter', s.upvotes = $upvotes,
            s.created_at = datetime({epochSeconds: $created_utc}),
            s.last_scraped_at = timestamp()
        MERGE (p)-[r:HAS_SIGNAL]->(s)
        """
        session.run(query,
            project_id=project_id,
            url=signal_url,
            title=tweet['text'],
            upvotes=tweet['public_metrics']['like_count'],
            created_utc=created_utc
        )
        print(f"        - Upserted Twitter signal: {tweet['id']}")

def main():
    if not TWITTER_BEARER_TOKEN:
        print("    - WARN: TWITTER_BEARER_TOKEN not found. Skipping.")
        sys.exit(0)
        
    collector = TwitterCollector(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
    collector.search_and_update()
    collector.close()

if __name__ == "__main__":
    main()
