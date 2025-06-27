# collectors/hacker_news_collector.py
#
# This collector uses the official Algolia Hacker News API to find
# high-value signals from one of the most important developer communities.

import os
import sys
import requests # A standard library for making HTTP requests
from neo4j import GraphDatabase
from datetime import datetime, timedelta

# --- Configuration ---
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")

# This mapping is the same as the Reddit scraper's, for consistency.
PROJECT_KEYWORDS = {
    "ollama/ollama": ["ollama"],
    "ggerganov/llama.cpp": ["llama.cpp", "llama cpp"],
    "langchain-ai/langchain": ["langchain"],
    "vllm-project/vllm": ["vllm"],
    "huggingface/transformers": ["huggingface", "transformers"],
}

class HackerNewsCollector:
    """
    Scrapes Hacker News for project mentions via the Algolia API.
    """
    API_ENDPOINT = "http://hn.algolia.com/api/v1/search"

    def __init__(self, uri, user, password):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        print("  - Hacker News Collector Initialized.")

    def close(self):
        self.driver.close()

    def search_and_update(self):
        """
        Searches for each project keyword and updates the graph.
        """
        print("  - Scraping Hacker News...")
        with self.driver.session(database="neo4j") as session:
            for project_id, keywords in PROJECT_KEYWORDS.items():
                # We search for any of the keywords
                query = " | ".join(keywords)
                print(f"    - Searching for '{query}'...")
                
                # Search for posts in the last 7 days
                # Algolia uses numeric filters for time-based searches
                yesterday_timestamp = int((datetime.now() - timedelta(days=7)).timestamp())
                params = {
                    "query": query,
                    "tags": "(story,comment)",
                    "numericFilters": f"created_at_i>{yesterday_timestamp}"
                }
                
                try:
                    response = requests.get(self.API_ENDPOINT, params=params)
                    response.raise_for_status() # Raise an exception for bad status codes
                    results = response.json()
                    
                    if not results.get("hits"):
                        print(f"      - No recent mentions found for '{query}'.")
                        continue

                    for hit in results["hits"]:
                        # Algolia API provides a clean data structure
                        self.create_or_update_signal(session, project_id, hit)

                except requests.exceptions.RequestException as e:
                    print(f"      - ERROR: Could not query Hacker News API: {e}")
                    continue

    def create_or_update_signal(self, session, project_id, hit):
        """
        Creates or updates a Signal node for a Hacker News mention.
        """
        # We use the objectID from Algolia as the unique key
        signal_url = f"https://news.ycombinator.com/item?id={hit['objectID']}"
        
        query = """
        MATCH (p:Project {project_id: $project_id})
        MERGE (s:Signal {url: $url})
        ON CREATE SET
            s.title = $title,
            s.source = 'Hacker News',
            s.upvotes = $upvotes, // Points in HN are equivalent to upvotes
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
    """ Main execution block """
    collector = None
    try:
        collector = HackerNewsCollector(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
        collector.search_and_update()
    except Exception as e:
        print(f"    - FATAL: An error occurred during Hacker News collection: {e}")
    finally:
        if collector:
            collector.close()

if __name__ == "__main__":
    main()
