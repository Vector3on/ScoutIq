# collectors/gemini_twitter_collector.py (Increased Cool Down)
import os
import requests
import time
from datetime import datetime, timezone

# ... (Bearer token, API endpoint, and keywords are the same) ...
TWITTER_BEARER_TOKEN = os.environ.get("TWITTER_BEARER_TOKEN")
API_ENDPOINT = "https://api.twitter.com/2/tweets/search/recent"
PROJECT_KEYWORDS = {
    "langchain-ai/langchain": "(langchain OR #langchain)",
    "microsoft/autogen": "(autogen OR #autogen)",
    "e2b-dev/e2b": "(e2b.dev OR #e2b)",
    "a16z-infra/ai-town": "(\"ai town\" OR #aitown)",
    "superagent-ai/superagent": "(superagent OR #superagentai)",
}

def _bearer_oauth(r):
    r.headers["Authorization"] = f"Bearer {TWITTER_BEARER_TOKEN}"
    r.headers["User-Agent"] = "BloodhoundVCETL"
    return r

def collect_signals():
    """Scrapes Twitter using the official v2 API with a bearer token."""
    if not TWITTER_BEARER_TOKEN:
        print("    - WARN: TWITTER_BEARER_TOKEN not found. Skipping Twitter.")
        return []

    print("  - Collecting signals from Twitter (using Official API v2)...")
    signals = []
    ingestion_time = datetime.now(timezone.utc).isoformat()

    for project_id, query in PROJECT_KEYWORDS.items():
        params = {'query': f"{query} -is:retweet", 'tweet.fields': 'public_metrics,created_at'}
        try:
            response = requests.get(API_ENDPOINT, auth=_bearer_oauth, params=params)
            if response.status_code == 429:
                print("      - HIT RATE LIMIT. Pausing for 60 seconds.")
                time.sleep(60)
                response = requests.get(API_ENDPOINT, auth=_bearer_oauth, params=params)
            response.raise_for_status()
            
            # ... (rest of the JSON processing is the same) ...
            json_response = response.json()
            if not json_response.get("data"):
                continue

            for tweet in json_response["data"]:
                signals.append({
                    "signalId": f"twitter-{tweet['id']}",
                    "project_id": project_id,
                    "source": "Twitter",
                    "signalUrl": f"https://twitter.com/anyuser/status/{tweet['id']}",
                    "title": tweet['text'],
                    "upvotes": tweet['public_metrics']['like_count'],
                    "createdAt": datetime.strptime(tweet['created_at'], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).isoformat(),
                    "ingestedAt": ingestion_time
                })
        except Exception as e:
            print(f"      - ERROR: An exception occurred during Twitter search for '{query}': {e}")
        
        # --- FIX #3: Increase the cool down delay ---
        print("    - Cooling down for 5 seconds to respect rate limits...")
        time.sleep(5)
            
    print(f"    - Twitter: Collected {len(signals)} signals.")
    return signals
