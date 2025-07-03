# discovery/curator.py
import requests
import json
import base64
from datetime import datetime, timezone
from multiprocessing import Pool
import os
import cProfile

# NEW: Add project root to sys.path to allow imports from sibling directories
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parent.parent))

from readme_analyzer.inference import readme_scorer

# --- Configuration ---
CACHE_FILE = "curator_cache.json"
# ... (the rest of the file is unchanged, but included for completeness) ...
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
HEADERS = {'Authorization': f'token {GITHUB_TOKEN}'} if GITHUB_TOKEN else {}

def load_cache():
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, 'r') as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return {}
    return {}

def save_cache(cache):
    with open(CACHE_FILE, 'w') as f:
        json.dump(cache, f, indent=2)

def analyze_project(project_data: dict) -> dict:
    full_name = project_data['full_name']
    
    readme_content = ""
    try:
        readme_url = f"https://api.github.com/repos/{full_name}/readme"
        response = requests.get(readme_url, headers=HEADERS, timeout=10)
        response.raise_for_status()
        readme_content = base64.b64decode(response.json()['content']).decode('utf-8', errors='replace')
    except Exception as e:
        print(f" - CURATOR WARN: Could not get README for {full_name}. Reason: {e}")

    qualitative_score = readme_scorer.score(readme_content)

    try:
        branch_url = f"https://api.github.com/repos/{full_name}/branches/{project_data['default_branch']}"
        response = requests.get(branch_url, headers=HEADERS, timeout=5)
        response.raise_for_status()
        latest_commit_sha = response.json()['commit']['sha']
    except Exception:
        latest_commit_sha = None

    return {
        "status": "analyzed",
        "repo_url": project_data['repo_url'],
        "full_name": project_data['full_name'],
        "stars": project_data['stars'],
        "qualitative_score": qualitative_score,
        "latest_commit_sha": latest_commit_sha,
        "last_analyzed_utc": datetime.now(timezone.utc).isoformat()
    }

def run_curation(projects: list) -> list:
    print("\n--- Running Optimized Curator Module ---")
    cache = load_cache()
    projects_to_analyze = []
    final_projects = []

    for p in projects:
        repo_url = p['repo_url']
        last_commit_age = (datetime.now(timezone.utc) - datetime.fromisoformat(p['pushed_at'].replace("Z", "+00:00"))).days
        if p['stars'] < 3 and p['forks'] < 1 and last_commit_age > 180:
            continue
        projects_to_analyze.append(p)
    
    print(f" - Analyzing {len(projects_to_analyze)} projects.")
    
    if projects_to_analyze:
        with Pool(processes=os.cpu_count()) as pool:
            results = pool.map(analyze_project, projects_to_analyze)
        
        for res in results:
            cache[res['repo_url']] = res
            final_projects.append(res)
            
    save_cache(cache)
    print(f"--- Curator Module Finished. Yielding {len(final_projects)} candidates. ---")
    return final_projects