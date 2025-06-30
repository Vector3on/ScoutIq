# collectors/gemini_reddit_collector.py
import os
import praw
from datetime import datetime, timezone

CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID")
CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET")
USER_AGENT = os.environ.get("REDDIT_USER_AGENT")

PROJECT_KEYWORDS = {
    "langchain-ai/langchain": ["langchain"],
    "microsoft/autogen": ["autogen"],
    "e2b-dev/e2b": ["e2b", "e2b.dev"],
    "a16z-infra/ai-town": ["ai town"],
    "superagent-ai/superagent": ["superagent"],
}
SUBREDDITS_TO_SCAN = ["MachineLearning", "LocalLLaMA", "LangChain", "OpenAI", "Singularity"]

def collect_signals():
    """Scrapes Reddit for project mentions and returns them as a list of signals."""
    if not all([CLIENT_ID, CLIENT_SECRET, USER_AGENT]):
        print("    - WARN: Reddit credentials not found. Skipping Reddit.")
        return []

    print("  - Collecting signals from Reddit...")
    signals = []
    processed_submission_ids = set()
    ingestion_time = datetime.now(timezone.utc).isoformat()
    
    try:
        reddit = praw.Reddit(client_id=CLIENT_ID, client_secret=CLIENT_SECRET, user_agent=USER_AGENT)
        for subreddit_name in SUBREDDITS_TO_SCAN:
            subreddit = reddit.subreddit(subreddit_name)
            for submission in subreddit.hot(limit=25):
                text_to_search = submission.title + submission.selftext
                for project_id, keywords in PROJECT_KEYWORDS.items():
                    if any(k.lower() in text_to_search.lower() for k in keywords):
                        if submission.id not in processed_submission_ids:
                            signal = {
                                "signalId": f"reddit-{submission.id}",
                                "project_id": project_id,
                                "source": "Reddit",
                                "signalUrl": f"https://www.reddit.com{submission.permalink}",
                                "title": submission.title,
                                "upvotes": submission.score,
                                "createdAt": datetime.fromtimestamp(submission.created_utc, tz=timezone.utc).isoformat(),
                                "ingestedAt": ingestion_time
                            }
                            signals.append(signal)
                            processed_submission_ids.add(submission.id)
                            break # Move to next submission once a project is found
    except Exception as e:
        print(f"    - ERROR: Reddit scraping failed: {e}")

    print(f"    - Reddit: Collected {len(signals)} signals.")
    return signals
