import os
import json
import praw

# --- CONFIGURATION ---
REDDIT_CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET")
REDDIT_USER_AGENT = "Bloodhound Scraper v1.0 by Vector3on"

# The output file for our leads
OUTPUT_FILENAME = "reddit_leads.json"
TARGET_SUBREDDITS = ["SideProject", "alphaandbetausers", "indiehackers", "smallbusiness"]
KEYWORD_TRIGGERS = ["new project", "my new app", "looking for feedback", "beta test", "just launched"]

def setup_reddit_client():
    """Initializes and returns a PRAW Reddit instance."""
    if not REDDIT_CLIENT_ID or not REDDIT_CLIENT_SECRET:
        print("    - FATAL: Reddit credentials not found in environment.")
        return None
    return praw.Reddit(
        client_id=REDDIT_CLIENT_ID,
        client_secret=REDDIT_CLIENT_SECRET,
        user_agent=REDDIT_USER_AGENT
    )

def scrape_reddit_submissions():
    """
    Scrapes target subreddits for new submissions matching keywords
    and saves them to a JSON file.
    """
    print("  - Scraping Reddit (to JSON)...")
    reddit = setup_reddit_client()
    if not reddit:
        return

    all_leads = []
    print(f"  - Searching in subreddits: {', '.join(TARGET_SUBREDDITS)}")
    
    for subreddit_name in TARGET_SUBREDDITS:
        subreddit = reddit.subreddit(subreddit_name)
        try:
            # We look at the newest 50 posts in each sub
            for submission in subreddit.new(limit=50):
                title_lower = submission.title.lower()
                if any(keyword in title_lower for keyword in KEYWORD_TRIGGERS):
                    # We only care about the title and the URL for now
                    lead_data = {
                        "title": submission.title,
                        "url": submission.url
                    }
                    all_leads.append(lead_data)
        except Exception as e:
            print(f"    - WARN: Could not process r/{subreddit_name}. Error: {e}")
            continue
            
    print(f"  - Found {len(all_leads)} total potential leads.")

    # Save all found leads to the specified JSON file
    try:
        with open(OUTPUT_FILENAME, "w") as f:
            json.dump(all_leads, f, indent=4)
        print(f"  - SUCCESS: All leads saved to '{OUTPUT_FILENAME}'.")
    except Exception as e:
        print(f"    - FATAL: Could not write leads to file. Error: {e}")

if __name__ == '__main__':
    scrape_reddit_submissions()
