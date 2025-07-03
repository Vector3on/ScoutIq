# gather_data.py
import requests
import json
import base64
import os
from discovery.active_radar import discover_repos

# --- Configuration ---
OUTPUT_FILE = "readme_dataset.json"
NUM_REPOS_TO_GATHER = 500
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
HEADERS = {'Authorization': f'token {GITHUB_TOKEN}'} if GITHUB_TOKEN else {}

def get_readme_content(repo_full_name: str) -> str | None:
    """Fetches the content of a README file for a given repository."""
    api_url = f"https://api.github.com/repos/{repo_full_name}/readme"
    try:
        response = requests.get(api_url, headers=HEADERS)
        response.raise_for_status()
        content_b64 = response.json()['content']
        # MODIFIED: Handle potential encoding errors gracefully by replacing bad characters.
        return base64.b64decode(content_b64).decode('utf-8', errors='replace')
    except (requests.exceptions.RequestException, KeyError, UnicodeDecodeError) as e:
        print(f" - WARN: Could not fetch or decode README for {repo_full_name}. Reason: {e}")
        return None

def main():
    """
    Main function to discover repos and gather their README files.
    """
    print(f"--- Starting README Data Gathering for {NUM_REPOS_TO_GATHER} repositories ---")
    
    repo_urls = discover_repos(random_n=NUM_REPOS_TO_GATHER)
    
    dataset = []
    
    print(f"\n--- Fetching README content for {len(repo_urls)} unique repositories ---")
    for i, repo_url in enumerate(repo_urls):
        repo_full_name = '/'.join(repo_url.split('/')[-2:])
        print(f" - ({i+1}/{len(repo_urls)}) Processing: {repo_full_name}")
        
        readme_content = get_readme_content(repo_full_name)
        
        if readme_content:
            dataset.append({
                "repo_url": repo_url,
                "repo_full_name": repo_full_name,
                "readme_content": readme_content,
                "clarity_score": 0,
                "vision_score": 0,
                "problem_solution_fit": 0
            })

    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(dataset, f, indent=2)

    print(f"\n✅ Data gathering complete. Saved {len(dataset)} READMEs to {OUTPUT_FILE}.")
    print("Next step: Manually annotate the scores in this file.")

if __name__ == "__main__":
    main()