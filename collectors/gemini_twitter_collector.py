# collectors/gemini_twitter_collector.py (New snscrape version)

import snscrape.modules.twitter as sntwitter
import itertools
from datetime import datetime, timedelta, timezone

# We still use the same keyword mapping
PROJECT_KEYWORDS = {
    "langchain-ai/langchain": "(langchain OR #langchain)",
    "microsoft/autogen": "(autogen OR #autogen)",
    "e2b-dev/e2b": "(e2b.dev OR #e2b)",
    "a16z-infra/ai-town": "(\"ai town\" OR #aitown)",
    "superagent-ai/superagent": "(superagent OR #superagentai)",
}

# Configuration for the scraper
TWEET_LIMIT_PER_KEYWORD = 30 # Limit to avoid excessively long scrapes

def collect_signals():
    """
    Scrapes Twitter for project mentions using snscrape to avoid API rate limits.
    This version does NOT require any API keys.
    """
    print("  - Collecting signals from Twitter (using snscrape)...")
    signals = []
    ingestion_time = datetime.now(timezone.utc).isoformat()
    
    # Define the time window for the search (e.g., last 3 days)
    since_date = (datetime.now() - timedelta(days=3)).strftime('%Y-%m-%d')

    for project_id, keyword_query in PROJECT_KEYWORDS.items():
        # Construct the full query for snscrape
        full_query = f"{keyword_query} since:{since_date}"
        
        try:
            # Create the scraper object and limit the number of tweets
            scraper = sntwitter.TwitterSearchScraper(full_query)
            
            for i, tweet in enumerate(itertools.islice(scraper.get_items(), TWEET_LIMIT_PER_KEYWORD)):
                signal = {
                    "signalId": f"twitter-{tweet.id}",
                    "project_id": project_id,
                    "source": "Twitter",
                    "signalUrl": tweet.url,
                    "title": tweet.rawContent,
                    "upvotes": tweet.likeCount,
                    "createdAt": tweet.date.isoformat(),
                    "ingestedAt": ingestion_time
                }
                signals.append(signal)

        except Exception as e:
            print(f"      - ERROR: An exception occurred during snscrape for '{keyword_query}': {e}")
            # Continue to the next keyword even if one fails
            continue
            
    print(f"    - Twitter: Collected {len(signals)} signals via snscrape.")
    return signals

if __name__ == '__main__':
    # For testing the collector directly
    import json
    collected_signals = collect_signals()
    with open("results/signals-twitter.json", 'w') as f:
        json.dump(collected_signals, f, indent=2)
    print("Sample Twitter signals saved to results/signals-twitter.json")
