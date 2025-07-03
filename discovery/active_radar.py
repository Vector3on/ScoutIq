# discovery/active_radar.py
import requests
import json
import os
import random
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Dict, Optional
from .curator import run_curation

# --- Configuration and Constants ---
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
HEADERS = {'Authorization': f'token {GITHUB_TOKEN}'} if GITHUB_TOKEN else {}
LOG_DIR = Path(__file__).resolve().parent / "logs"
LOG_DIR.mkdir(exist_ok=True)
EXPLORE_TOPICS = ["machine-learning", "web-development", "mobile-development", "data-science", "devops", "game-development"]

# --- Helper Functions ---
def _clean_repo_url(url: str) -> Optional[str]:
    """Cleans a GitHub URL to a canonical form."""
    match = re.search(r'https://github\.com/([a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+)', url)
    if match:
        return f"https://github.com/{match.group(1).split('.git')[0]}"
    return None

def _query_github_search_api(query: str, sort: str = "stars", order: str = "desc", per_page: int = 20) -> List[Dict]:
    """
    A centralized function to query the GitHub Search API.
    Returns a list of dictionaries with rich project data.
    """
    projects = []
    api_url = f"https://api.github.com/search/repositories?q={query}&sort={sort}&order={order}&per_page={per_page}"
    try:
        response = requests.get(api_url, headers=HEADERS)
        response.raise_for_status()
        data = response.json()
        for item in data.get('items', []):
            projects.append({
                "repo_url": item['html_url'],
                "full_name": item['full_name'],
                "stars": item['stargazers_count'],
                "forks": item['forks_count'],
                "pushed_at": item['pushed_at'],
                "default_branch": item['default_branch'],
                "qualitative_score": 0.5
            })
        print(f" - API Query OK: '{query}'. Found {len(projects)} projects.")
    except requests.exceptions.RequestException as e:
        print(f" - WARN: Could not query GitHub Search API for '{query}'. Reason: {e}")
    return projects

# --- API-based Discovery Functions ---
def _discover_from_topics(topic: str) -> List[Dict]:
    """Finds repos by topic using the GitHub API."""
    print(f" - Discovering from Topic via API: {topic}")
    query = f"topic:{topic} stars:>20"
    return _query_github_search_api(query=query)

def _discover_trending(language: str, since_days: int = 14) -> List[Dict]:
    """Discovers trending repos as a proxy for the old 'Trending' page scrape."""
    print(f" - Discovering Trending '{language}' repos via API...")
    since_date = (datetime.now() - timedelta(days=since_days)).strftime('%Y-%m-%d')
    query = f"language:{language} created:>{since_date} stars:>50"
    return _query_github_search_api(query=query, sort="stars")

def _discover_from_explore() -> List[Dict]:
    """Simulates the 'Explore' page by searching top repos in broad topics."""
    print(" - Discovering from 'Explore' topics via API...")
    repos = {}
    topic_to_search = random.choice(EXPLORE_TOPICS)
    projects = _query_github_search_api(query=f"topic:{topic_to_search} stars:>100", sort="stars", per_page=50)
    for p in projects:
        repos[p['repo_url']] = p
    return list(repos.values())

def _discover_sleeper_hits() -> List[Dict]:
    """Finds new projects with some forks but very few stars."""
    print(" - Discovering 'Sleeper Hits' from GitHub API...")
    since_date = (datetime.now() - timedelta(days=45)).strftime('%Y-%m-%d')
    query = f"created:>{since_date} forks:>5 stars:10..75"
    return _query_github_search_api(query=query, sort="updated")

def _discover_from_hn() -> List[str]:
    """Discovers repo URLs from Hacker News."""
    print(" - Discovering from Hacker News...")
    repo_urls = set()
    # TUNED: Loosened criteria to increase chance of finding results
    fourteen_days_ago = int((datetime.now() - timedelta(days=14)).timestamp())
    url = f"http://hn.algolia.com/api/v1/search?query=github.com&tags=story&numericFilters=points>25,created_at_i>{fourteen_days_ago}"
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
                    repo_urls.add(cleaned_url)
    except requests.exceptions.RequestException as e:
        print(f" - WARN: Could not query Hacker News API. Reason: {e}")
    print(f" - Found {len(repo_urls)} potential repos from Hacker News.")
    return list(repo_urls)

def _get_project_details_from_url(repo_url: str) -> Optional[Dict]:
    """Fetches rich project details for a single repo URL."""
    match = re.search(r'https://github\.com/([a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+)', repo_url)
    if not match:
        return None
    full_name = match.group(1)
    api_url = f"https://api.github.com/repos/{full_name}"
    try:
        response = requests.get(api_url, headers=HEADERS)
        response.raise_for_status()
        item = response.json()
        return {
            "repo_url": item['html_url'], "full_name": item['full_name'],
            "stars": item['stargazers_count'], "forks": item['forks_count'],
            "pushed_at": item['pushed_at'], "default_branch": item['default_branch'],
            "qualitative_score": 0.5
        }
    except requests.exceptions.RequestException:
        return None

# --- Main Orchestrator for Discovery ---
def discover_repos(topic: Optional[str] = None, language: str = "python", random_n: int = 5) -> List[str]:
    """The main discovery function, integrated with the optimized Curator."""
    print("\n--- Starting Active Radar Discovery (API-Only) ---")
    discovered_projects: List[Dict] = []

    sources = {
        "trending": (lambda: _discover_trending(language), "api_trending"),
        "explore": (_discover_from_explore, "api_explore"),
        "sleeper_hits": (_discover_sleeper_hits, "api_search"),
    }
    if topic:
        sources["topic_search"] = (lambda: _discover_from_topics(topic), f"api_topic_{topic}")

    for source_key, (func, reason) in sources.items():
        projects = func()
        for project in projects:
            project['source'] = source_key
            project['reason'] = reason
            discovered_projects.append(project)

    hn_urls = _discover_from_hn()
    for url in hn_urls:
        details = _get_project_details_from_url(url)
        if details:
            details['source'] = 'hacker_news'
            details['reason'] = 'hn_links'
            discovered_projects.append(details)

    if not discovered_projects:
        print("--- Discovery finished. No new repositories found. ---")
        return []

    unique_projects = {p['repo_url']: p for p in discovered_projects}.values()
    curated_projects = run_curation(list(unique_projects))
    
    if not curated_projects:
        print("--- Discovery finished. No repositories met the quality threshold. ---")
        return []

    print(f"\n✅ Discovery & Curation complete. Identified {len(curated_projects)} high-quality repos.")

    unique_repo_urls = sorted(list(set(p['repo_url'] for p in curated_projects)))
    num_to_sample = min(random_n, len(unique_repo_urls))
    return random.sample(unique_repo_urls, num_to_sample) if unique_repo_urls else []
