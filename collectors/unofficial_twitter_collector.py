# collectors/unofficial_twitter_collector.py
import snscrape.modules.twitter as sntwitter
from datetime import datetime, timezone

# Using the same keywords as the other collectors
PROJECT_KEYWORDS = {
    "langchain-ai/langchain": "(langchain OR #langchain)",
    "microsoft/autogen": "(autogen OR #autogen)",
    "e2b-dev/e2b": "(e2b.dev OR #e2b)",
    "a16z-infra/ai-town": "(\"ai town\" OR #aitown)",
    "superagent-ai/superagent": "(superagent OR #superagentai)",
}

def collect_signals():
    """Scrapes Twitter using snscrape, avoiding official API rate limits."""
    print("  - Collecting signals from Twitter (using unofficial snscrape)...")
    signals = []
    ingestion_time = datetime.now(timezone.utc).isoformat()
    
    for project_id, query in PROJECT_KEYWORDS.items():
        try:
            # Create a scraper object for the given query
            scraper = sntwitter.TwitterSearchScraper(query)
            
            # Scrape a limited number of recent tweets to keep it fast
            for i, tweet in enumerate(scraper.get_items()):
                if i >= 25: # Limit to 25 tweets per keyword
                    break
                
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
            print(f"      - ERROR: An exception occurred during snscrape for '{query}': {e}")
            
    print(f"    - Twitter (snscrape): Collected {len(signals)} signals.")
    return signals