# collectors/gemini_twitter_collector.py
import os
import requests
from datetime import datetime, timezone

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
    """Scrapes Twitter for project mentions and returns them as a list of signals."""
    if not TWITTER_BEARER_TOKEN:
        print("    - WARN: TWITTER_BEARER_TOKEN not found. Skipping Twitter.")
        return []

    print("  - Collecting signals from Twitter...")
    signals = []
    ingestion_time = datetime.now(timezone.utc).isoformat()

    for project_id, query in PROJECT_KEYWORDS.items():
        params = {'query': f"{query} -is:retweet", 'tweet.fields': 'public_metrics,created_at'}
        try:
            response = requests.get(API_ENDPOINT, auth=_bearer_oauth, params=params)
            if response.status_code != 200:
                print(f"      - ERROR: Twitter API request failed with status {response.status_code}: {response.text}")
                continue
            
            json_response = response.json()
            if not json_response.get("data"):
                continue

            for tweet in json_response["data"]:
                signal = {
                    "signalId": f"twitter-{tweet['id']}",
                    "project_id": project_id,
                    "source": "Twitter",
                    "signalUrl": f"https://twitter.com/anyuser/status/{tweet['id']}",
                    "title": tweet['text'],
                    "upvotes": tweet['public_metrics']['like_count'],
                    "createdAt": datetime.strptime(tweet['created_at'], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).isoformat(),
                    "ingestedAt": ingestion_time
                }
                signals.append(signal)
        except Exception as e:
            print(f"      - ERROR: An exception occurred during Twitter search for '{query}': {e}")
            
    print(f"    - Twitter: Collected {len(signals)} signals.")
    return signals
