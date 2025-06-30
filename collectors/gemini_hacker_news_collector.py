# collectors/gemini_hacker_news_collector.py

import requests
from datetime import datetime, timedelta, timezone

PROJECT_KEYWORDS = {
    "langchain-ai/langchain": ["langchain"],
    "microsoft/autogen": ["autogen", "autogenstudio"],
    "e2b-dev/e2b": ["e2b", "e2b.dev"],
    "a16z-infra/ai-town": ["ai town", "aitown"],
    "superagent-ai/superagent": ["superagent"],
}
API_ENDPOINT = "http://hn.algolia.com/api/v1/search"

def collect_signals():
    """Scrapes Hacker News for project mentions and returns them as a list of signals."""
    print("  - Collecting signals from Hacker News...")
    signals = []
    ingestion_time = datetime.now(timezone.utc).isoformat()
    seven_days_ago = int((datetime.now() - timedelta(days=7)).timestamp())

    for project_id, keywords in PROJECT_KEYWORDS.items():
        query = " OR ".join(f'"{k}"' for k in keywords)
        params = {"query": query, "tags": "(story,comment)", "numericFilters": f"created_at_i>{seven_days_ago}"}
        
        try:
            response = requests.get(API_ENDPOINT, params=params)
            response.raise_for_status()
            for hit in response.json().get("hits", []):
                signal = {
                    "signalId": f"hn-{hit['objectID']}",
                    "project_id": project_id,
                    "source": "Hacker News",
                    "signalUrl": f"https://news.ycombinator.com/item?id={hit['objectID']}",
                    "title": hit.get("title") or hit.get("story_title") or "Hacker News Comment",
                    "upvotes": hit.get("points", 0) or 0,
                    "createdAt": datetime.fromtimestamp(hit["created_at_i"], tz=timezone.utc).isoformat(),
                    "ingestedAt": ingestion_time
                }
                signals.append(signal)
        except requests.exceptions.RequestException as e:
            print(f"      - ERROR: Could not query Hacker News API for '{query}': {e}")
            
    print(f"    - Hacker News: Collected {len(signals)} signals.")
    return signals
