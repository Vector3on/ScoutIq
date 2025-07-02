# discovery/active_radar.py
import requests
import json
import os
import random
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Dict, Optional
from bs4 import BeautifulSoup

# --- CONFIGURATION ---
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
HEADERS = {'Authorization': f'token {GITHUB_TOKEN}'} if GITHUB_TOKEN else {}
LOG_DIR = Path(__file__).resolve().parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

# --- [1] GITHUB TRENDING & EXPLORE SCRAPER (WITH ROBUST FILTERING) ---

def _clean_repo_url(url: str) -> Optional[str]:
    """Cleans a URL to ensure it's a base GitHub repository URL."""
    match = re.search(r'https://github\.com/([a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+)', url)
    if match:
        return f"https://github.com/{match.group(1)}"
    return None

def _scrape_github_page(url: str) -> List[str]:
    """Helper function to scrape a GitHub page for repository links."""
    repos = set()
    # --- THIS IS THE FIX ---
    # A list of path segments that are not valid repositories.
    DENY_LIST = [
        'topics', 'sponsors', 'trending', 'solutions', 'apps', 'marketplace',
        'resources', 'collections', 'issues', 'pulls', 'actions', 'projects',
        'wiki', 'security', 'insights', 'settings', 'commit', 'blob', 'tree'
    ]
    # --- END FIX ---
    try:
        response = requests.get(url, headers={'User-Agent': 'ScoutIQ-Discovery-Module'})
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        
        for a in soup.find_all('a', href=True):
            href = a['href'].strip('/')
            parts = href.split('/')
            
            # A valid repo path has exactly 2 parts: user/repo
            # And the first part is not in our deny list.
            if len(parts) == 2 and parts[0] not in DENY_LIST:
                full_url = f"https://github.com/{parts[0]}/{parts[1]}"
                cleaned_url = _clean_repo_url(full_url)
                if cleaned_url:
                    repos.add(cleaned_url)

    except requests.exceptions.RequestException as e:
        print(f"  - WARN: Could not scrape {url}. Reason: {e}")
    return list(repos)

# --- [2] TOPIC-BASED DISCOVERY ---

def _discover_from_topics(topic: str) -> List[str]:
    """Scrapes a GitHub Topic page for associated repositories."""
    print(f"  - Discovering from Topic: {topic}")
    url = f"https://github.com/topics/{topic}"
    return _scrape_github_page(url)

# --- [3] GITHUB API SEARCH (SLEEPER HITS) ---

def _discover_sleeper_hits() -> List[str]:
    """Finds newly created repositories with some activity but few stars."""
    print("  - Discovering 'Sleeper Hits' from GitHub API...")
    repos = []
    since_date = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
    query = f"created:>{since_date} forks:>5 stars:<50"
    url = f"https://api.github.com/search/repositories?q={query}&sort=updated&order=desc"
    
    try:
        response = requests.get(url, headers=HEADERS)
        response.raise_for_status()
        data = response.json()
        for item in data.get('items', []):
            repos.append(item['html_url'])
    except requests.exceptions.RequestException as e:
        print(f"  - WARN: Could not query GitHub API. Reason: {e}")
    return repos

# --- [4] REDDIT / HACKER NEWS DISCOVERY ---

def _discover_from_hn() -> List[str]:
    """Finds GitHub links from recent, popular Hacker News stories."""
    print("  - Discovering from Hacker News...")
    repos = set()
    seven_days_ago = int((datetime.now() - timedelta(days=7)).timestamp())
    url = f"http://hn.algolia.com/api/v1/search?query=github.com&tags=story&numericFilters=points>50,created_at_i>{seven_days_ago}"
    try:
        response = requests.get(url)
        response.raise_for_status()
        hits = response.json().get("hits", [])
        for hit in hits:
            text_to_search = f"{hit.get('title', '')} {hit.get('url', '')} {hit.get('story_text', '')}"
            found_urls = re.findall(r'https://github\.com/[\w\-./]+', text_to_search)
            for found_url in found_urls:
                cleaned_url = _clean_repo_url(found_url)
                if cleaned_url:
                    repos.add(cleaned_url)
    except requests.exceptions.RequestException as e:
        print(f"  - WARN: Could not query Hacker News API. Reason: {e}")
    return list(repos)

# --- [7] FUTURE EXTENSIONS (STUBS) ---

def _future_discover_by_twitter():
    return []

def _future_score_readme_with_gpt(repo_url: str) -> float:
    return 0.5

# --- [5] & [6] MAIN DISCOVERY FUNCTION & LOGGING ---

def discover_repos(topic: Optional[str] = None, language: str = "python", random_n: int = 5) -> List[str]:
    """Main discovery function to find new high-potential GitHub repositories."""
    print("\n--- 📡 Starting Active Radar Discovery ---")
    
    discovered_items: List[Dict] = []
    
    sources = {
        "trending_daily": (lambda: _scrape_github_page(f"https://github.com/trending/{language}?since=daily"), f"daily_{language}_trending"),
        "explore": (lambda: _scrape_github_page("https://github.com/explore"), "explore"),
        "sleeper_hits": (_discover_sleeper_hits, "api_search"),
        "hacker_news": (_discover_from_hn, "hn_links"),
    }
    if topic:
        sources["topic_search"] = (lambda: _discover_from_topics(topic), f"topic_{topic}")

    for source_key, (func, reason) in sources.items():
        urls = func()
        for url in urls:
            discovered_items.append({
                "repo": url,
                "source": source_key,
                "reason": reason,
                "score": _future_score_readme_with_gpt(url)
            })

    if not discovered_items:
        print("--- 📡 Discovery finished. No new repositories found. ---")
        return []

    timestamp = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    log_file = LOG_DIR / f"discovered_repos_{timestamp}.json"
    with open(log_file, 'w') as f:
        json.dump(discovered_items, f, indent=2)
    print(f"\n✅ Discovery complete. Logged {len(discovered_items)} potential repos to {log_file}")

    unique_repos = sorted(list(set(item['repo'] for item in discovered_items)))
    num_to_sample = min(random_n, len(unique_repos))
    
    return random.sample(unique_repos, num_to_sample) if unique_repos else []


if __name__ == '__main__':
    new_targets = discover_repos(topic="agent-frameworks", language="python", random_n=5)
    
    if new_targets:
        print("\n--- Discovered Targets for Analysis ---")
        for target in new_targets:
            print(f"- {target}")
    else:
        print("\n--- No new targets discovered in this run. ---")
