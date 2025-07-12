# scanners/github_scanner.py
import os
import sys
import json
import requests

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
HEADERS = {'Authorization': f'token {GITHUB_TOKEN}'} if GITHUB_TOKEN else {}

def get_new_orgs(username: str):
    if not GITHUB_TOKEN:
        return {"error": "GITHUB_TOKEN environment variable not set."}
    if not username:
        return {"error": "No username provided."}
    
    print(f"[SCANNER:GITHUB] Checking for new organizations for user: {username}", file=sys.stderr)
    api_url = f"https://api.github.com/users/{username}/orgs"
    
    try:
        response = requests.get(api_url, headers=HEADERS)
        response.raise_for_status()
        orgs = response.json()
        print(f"[SCANNER:GITHUB] Found {len(orgs)} organizations for {username}.", file=sys.stderr)
        return {"username": username, "organizations": orgs}
    except requests.exceptions.RequestException as e:
        return {"error": f"Failed to query GitHub API: {e}"}

if __name__ == "__main__":
    if len(sys.argv) > 1:
        target_username = sys.argv[1]
        results = get_new_orgs(target_username)
        print(json.dumps(results, indent=2))
    else:
        print(json.dumps({"error": "Usage: python scanners/github_scanner.py <username>"}), file=sys.stderr)
        sys.exit(1)