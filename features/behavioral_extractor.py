# features/behavioral_extractor.py
from pydriller import Repository
from datetime import datetime, timedelta

def get_commit_history(repo_url: str, days_back: int = 90):
    """
    Analyzes a git repository and returns a list of (date, author_email) tuples.

    Args:
        repo_url (str): The URL of the repository to analyze.
        days_back (int): The number of past days to analyze.

    Returns:
        A list of (datetime, str) tuples for each commit.
    """
    print(f"  - Extracting commit history and authors from: {repo_url}")
    
    since_date = datetime.now() - timedelta(days=days_back)
    commit_data = []
    
    try:
        for commit in Repository(repo_url, since=since_date, only_no_merge=True).traverse_commits():
            commit_data.append((commit.committer_date, commit.author.email))

        print(f"    - Analysis complete. Found {len(commit_data)} commits in the last {days_back} days.")
        return commit_data

    except Exception as e:
        print(f"    - ERROR: Could not analyze repository {repo_url}. Reason: {e}")
        return []