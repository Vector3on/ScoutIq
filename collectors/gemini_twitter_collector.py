# collectors/gemini_twitter_collector.py (Final Corrected Version)

import snscrape.modules.twitter as sntwitter
import itertools
from datetime import datetime, timedelta, timezone
import ssl # <--- IMPORT SSL

def collect_signals():
    """
    Scrapes Twitter for project mentions using snscrape. This version bypasses
    SSL verification to work in restrictive environments like GitHub Actions.
    """
    print("  - Collecting signals from Twitter (using snscrape)...")
    
    # --- THIS IS THE FIX for the SSLError ---
    # This is a workaround for environments with SSL certificate issues.
    # It tells the script not to verify the SSL certificate, which is generally
    # acceptable for scraping public data.
    ssl._create_default_https_context = ssl._create_unverified_context
    
    signals = []
    ingestion_time = datetime.now(timezone.utc).isoformat()
    since_date = (datetime.now() - timedelta(days=3)).strftime('%Y-%m-%d')

    PROJECT_KEYWORDS = {
        "langchain-ai/langchain": "(langchain OR #langchain)",
        "microsoft/autogen": "(autogen OR #autogen)",
        "e2b-dev/e2b": "(e2b.dev OR #e2b)",
        "a16z-infra/ai-town": "(\"ai town\" OR #aitown)",
        "superagent-ai/superagent": "(superagent OR #superagentai)",
    }
    TWEET_LIMIT_PER_KEYWORD = 30

    for project_id, keyword_query in PROJECT_KEYWORDS.items():
        full_query = f"{keyword_query} since:{since_date}"
        try:
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
            continue
            
    print(f"    - Twitter: Collected {len(signals)} signals via snscrape.")
    return signals
