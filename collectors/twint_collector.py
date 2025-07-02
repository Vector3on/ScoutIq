# collectors/twint_collector.py
import twint # <-- This is the corrected import
import nest_asyncio
from datetime import datetime

# Apply a patch to allow twint to run in this environment
nest_asyncio.apply()

# Using the same keywords as the other collectors
PROJECT_KEYWORDS = {
    "langchain-ai/langchain": "langchain OR #langchain",
    "microsoft/autogen": "autogen OR #autogen",
    "e2b-dev/e2b": "e2b.dev OR #e2b",
    "a16z-infra/ai-town": "\"ai town\" OR #aitown",
    "superagent-ai/superagent": "superagent OR #superagentai",
}

def collect_signals():
    """Scrapes Twitter using Twint, a powerful unofficial scraper."""
    print("  - Collecting signals from Twitter (using Twint)...")
    signals = []
    ingestion_time = datetime.now().astimezone().isoformat()
    
    for project_id, query in PROJECT_KEYWORDS.items():
        try:
            # Configure Twint to search for the query
            c = twint.Config()
            c.Search = query
            c.Limit = 20
            c.Store_object = True
            c.Hide_output = True
            
            # Clear the old list of tweets
            twint.output.tweets_list.clear()
            
            # Run the search
            twint.run.Search(c)
            
            # Retrieve the tweets from the stored list
            scraped_tweets = twint.output.tweets_list

            for tweet in scraped_tweets:
                signal = {
                    "signalId": f"twitter-{tweet.id}",
                    "project_id": project_id,
                    "source": "Twitter",
                    "signalUrl": tweet.link,
                    "title": tweet.tweet,
                    "upvotes": tweet.likes_count,
                    "createdAt": f"{tweet.datestamp}T{tweet.timestamp}{tweet.timezone}",
                    "ingestedAt": ingestion_time
                }
                signals.append(signal)

        except Exception as e:
            print(f"      - ERROR: An exception occurred during Twint scrape for '{query}': {e}")
            
    print(f"    - Twitter (Twint): Collected {len(signals)} signals.")
    return signals