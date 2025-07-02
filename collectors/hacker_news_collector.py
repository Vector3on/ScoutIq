# collectors/hacker_news_collector.py
#
# Retargeted to focus on AI Agent projects.

import os
import sys
import requests
from datetime import datetime, timedelta

# --- Configuration ---
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")

# --- NEW: AI AGENT TARGETS ---
PROJECT_KEYWORDS = {
    "langchain-ai/langchain": ["langchain"],
    "microsoft/autogen": ["autogen", "autogenstudio"],
    "e2b-dev/e2b": ["e2b", "e2b.dev"],
    "a16z-infra/ai-town": ["ai town", "aitown"],
    "superagent-ai/superagent": ["superagent"],
}

class HackerNewsCollector:
    """ Scrapes Hacker News for project mentions via the Algolia API. """
    API_ENDPOINT = "http://hn.algolia.com/api/v1/search"

    def __init__(self, uri, user, password):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        print("  - Hacker News Collector Initialized.")

    def close(self):
        self.driver.close()

    def search_and_update(self):
        """ Searches for each project keyword and updates the graph. """
        print("  - Scraping Hacker News for AI Agent signals...")
        with self.driver.session(database="neo4j") as session:
            for project_id, keywords in PROJECT_KEYWORDS.items():
                query = " OR ".join(f'"{k}"' for k in keywords) # Use OR for multiple keywords
                print(f"    - Searching for: {query}")
                
                seven_days_ago = int((datetime.now() - timedelta(days=7)).timestamp())
                params = {"query": query, "tags": "(story,comment)", "numericFilters": f"created_at_i>{seven_days_ago}"}
                
                try:
                    response = requests.get(self.API_ENDPOINT, params=params)
                    response.raise_for_status()
                    for hit in response.json().get("hits", []):
                        self.create_or_update_signal(session, project_id, hit)
                except requests.exceptions.RequestException as e:
                    print(f"      - ERROR: Could not query Hacker News API: {e}")

    def create_or_update_signal(self, session, project_id, hit):
        """ Creates or updates a Signal node for a Hacker News mention. """
        signal_url = f"https://news.ycombinator.com/item?id={hit['objectID']}"
        query = """
        MATCH (p:Project {project_id: $project_id})
        MERGE (s:Signal {url: $url})
        ON CREATE SET
            s.title = $title,
            s.source = 'Hacker News',
            s.upvotes = $upvotes,
            s.created_at = datetime({epochSeconds: $created_utc}),
            s.last_scraped_at = timestamp()
        MERGE (p)-[r:HAS_SIGNAL]->(s)
        """
        session.run(query,
            project_id=project_id,
            url=signal_url,
            title=hit.get("title") or hit.get("story_title") or "Hacker News Comment",
            upvotes=hit.get("points", 0) or 0,
            created_utc=hit["created_at_i"]
        )
        print(f"        - Upserted Hacker News signal: {hit['objectID']}")

def main():
    collector = HackerNewsCollector(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
    collector.search_and_update()
    collector.close()

if __name__ == "__main__":
    main()
