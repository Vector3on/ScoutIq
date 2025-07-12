# scanners/reddit_scanner.py
import os
import sys
import json
import praw
import argparse
from datetime import datetime, timedelta

# --- Reddit API Credentials ---
REDDIT_CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET")
REDDIT_USER_AGENT = "ScoutIQ-Agent:v1.0 (by /u/YourRedditUsername)"

# --- Scanner Configuration ---
TARGET_SUBREDDITS = [
    "Programming", "ExperiencedDevs", "golang", "rust", "python", "node",
    "typescript", "elixir", "devops", "selfhosted", "SaaS", "indiehackers",
    "netsec", "homelab", "privacy", "privacytoolsIO", "MachineLearning", 
    "LocalLLaMA", "LocalGPT", "MLQuestions", "DataEngineering", "datascience", 
    "mlops", "learnprogramming", "AskProgramming", "ReverseEngineering", "linux",
    "sysadmin", "webdev", "frontend", "reactjs", "vuejs", "DataIsBeautiful", 
    "OSINT", "CommandLine", "battlestations", "unixporn", "FunctionalProgramming", 
    "embedded", "AskNetsec", "CyberSecurity", "solidity"
]

# --- Weighted Keyword Scoring ---
WEIGHTED_KEYWORDS = {
    # High-value, specific technologies
    "vllm": 3, "ollama": 3, "langchain": 3, "llama-index": 3, 
    "supabase": 2, "firebase": 2, "appwrite": 2, "nextjs": 2, 
    "sveltekit": 2, "remix": 2, "stripe": 2, "paddle": 2, 
    "lemonsqueezy": 2, "fastapi": 2, "fly.io": 2, "render.com": 2,
    # General, but still strong signals
    "aws": 1, "gcp": 1, "azure": 1, "golang": 1, "rust": 1, 
    "python": 1, "react": 1 # Note: 'react' is less specific than 'reactjs'
}

# --- Filter Thresholds ---
TIME_WINDOW_HOURS = 48
MAX_POST_KARMA = 50
MAX_COMMENT_KARMA = 100
MAX_ACCOUNT_AGE_DAYS = 30
MIN_FOUNDER_SCORE = 4

def process_item(item, item_type, potential_founders, debug=False):
    """Processes a single submission or comment to find potential signals."""
    try:
        author = item.author
        if not author or not hasattr(author, 'name'):
            return

        # Account Age Filter
        account_age = (datetime.utcnow() - datetime.utcfromtimestamp(author.created_utc)).days
        if account_age > MAX_ACCOUNT_AGE_DAYS:
            return

        # Low Karma Filter
        if hasattr(author, 'link_karma') and hasattr(author, 'comment_karma'):
            if author.link_karma > MAX_POST_KARMA or author.comment_karma > MAX_COMMENT_KARMA:
                return
        else:
            return

        text_content = ""
        if item_type == 'submission':
            text_content = (item.title + " " + item.selftext).lower()
        elif item_type == 'comment':
            text_content = item.body.lower()

        # Weighted Keyword Matching
        current_score = 0
        matched_keywords = set()
        for keyword, weight in WEIGHTED_KEYWORDS.items():
            if keyword in text_content:
                current_score += weight
                matched_keywords.add(keyword)

        if current_score > 0:
            if debug:
                print(f"[DEBUG] Match found for u/{author.name} in r/{item.subreddit.display_name} (Score: +{current_score})")
            
            if author.name not in potential_founders:
                potential_founders[author.name] = {
                    "username": author.name,
                    "score": 0,
                    "account_age_days": account_age,
                    "matched_keywords": set(),
                    "subreddits": set(),
                    "urls": []
                }
            
            # Aggregate data
            potential_founders[author.name]["score"] += current_score
            potential_founders[author.name]["matched_keywords"].update(matched_keywords)
            potential_founders[author.name]["subreddits"].add(item.subreddit.display_name)
            potential_founders[author.name]["urls"].append(f"https://www.reddit.com{item.permalink}")

    except Exception as e:
        if debug:
            print(f"[DEBUG] Error processing item: {e}")

def generate_reason(data):
    """Generates a human-readable reason for flagging a user."""
    keywords = ", ".join(sorted(list(data["matched_keywords"])))
    subreddits = ", ".join(sorted(list(data["subreddits"])))
    return f"High-scoring activity detected. Mentioned: {keywords}. Active in: r/{subreddits}."

def find_stealth_founders(debug=False, output_file=None):
    """
    Scans Reddit for posts and comments from new, low-karma users that match
    a weighted keyword fingerprint, indicating a potential stealth founder.
    """
    if not all([REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT]):
        print(json.dumps({"error": "Reddit API credentials are not set."}), file=sys.stderr)
        return

    print("[SCANNER] Initializing Reddit API client...")
    try:
        reddit = praw.Reddit(client_id=REDDIT_CLIENT_ID, client_secret=REDDIT_CLIENT_SECRET, user_agent=REDDIT_USER_AGENT)
        print("[SCANNER] Authentication successful. Scanning subreddits...")
    except Exception as e:
        print(json.dumps({"error": f"Failed to authenticate with Reddit API: {e}"}), file=sys.stderr)
        return

    potential_founders = {}
    time_limit = datetime.utcnow() - timedelta(hours=TIME_WINDOW_HOURS)
    unique_subreddits = set(TARGET_SUBREDDITS)

    for sub_name in unique_subreddits:
        print(f"[SCANNER] --- Scanning r/{sub_name} ---", file=sys.stderr)
        try:
            subreddit = reddit.subreddit(sub_name)
            # Scan submissions
            for submission in subreddit.new(limit=100):
                if datetime.utcfromtimestamp(submission.created_utc) < time_limit: break
                process_item(submission, 'submission', potential_founders, debug)
            # Scan comments
            for comment in subreddit.comments(limit=200):
                if datetime.utcfromtimestamp(comment.created_utc) < time_limit: break
                process_item(comment, 'comment', potential_founders, debug)
        except Exception as e:
            print(f"[SCANNER] WARN: Could not scan r/{sub_name}. Reason: {e}", file=sys.stderr)
            continue
            
    # Final classification logic
    final_results = []
    for user, data in potential_founders.items():
        if data["score"] >= MIN_FOUNDER_SCORE:
            data["matched_keywords"] = sorted(list(data["matched_keywords"]))
            data["subreddits"] = sorted(list(data["subreddits"]))
            data["reason"] = generate_reason(data)
            final_results.append(data)

    # Sort by score, descending
    final_results.sort(key=lambda x: x['score'], reverse=True)

    print(f"[SCANNER] Scan complete. Found {len(final_results)} high-confidence founder fingerprints.")
    
    output_json = json.dumps(final_results, indent=2)

    if output_file:
        try:
            os.makedirs(os.path.dirname(output_file), exist_ok=True)
            with open(output_file, 'w') as f:
                f.write(output_json)
            print(f"[SCANNER] Results saved to {output_file}")
        except Exception as e:
            print(f"[SCANNER] ERROR: Could not write to output file {output_file}. Reason: {e}", file=sys.stderr)
    else:
        print(output_json)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ScoutIQ Stealth Founder Hunter for Reddit.")
    parser.add_argument("--debug", action="store_true", help="Enable verbose logging for debugging.")
    parser.add_argument("--output-file", type=str, default="data/stealth_founders.json", help="Path to save the JSON output.")
    args = parser.parse_args()
    
    find_stealth_founders(debug=args.debug, output_file=args.output_file)
