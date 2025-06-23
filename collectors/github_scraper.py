import os
from neo4j import GraphDatabase
import requests
from bs4 import BeautifulSoup

# --- CONFIGURATION ---
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")

def update_project_node_with_velocity(tx, project_data):
    """
    This query is now much smarter.
    1. It MERGES the project node as before.
    2. It captures the existing star count BEFORE updating it.
    3. It calculates the delta (new stars - old stars).
    4. It updates the stars and sets the new delta.
    """
    query = """
    MERGE (p:Project {display_name: $repo_name})
    ON CREATE SET
        p.url = $url,
        p.owner = $owner,
        p.language = $language,
        p.stars = $stars,
        p.stars_delta_1d = 0, // Set delta to 0 on first sight
        p.first_seen_at = timestamp()
    ON MATCH SET
        p.stars_delta_1d = $stars - p.stars, // Calculate delta
        p.stars = $stars, // THEN update the stars
        p.language = $language,
        p.last_seen_at = timestamp()
    """
    tx.run(query, **project_data)

def scrape_github_trending():
    """Scrapes GitHub and updates Project nodes with star velocity."""
    print("  - Scraping GitHub (Velocity-Aware)...")
    if not URI:
        print("    - FATAL: Neo4j credentials not found.")
        return

    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    url = "https://github.com/trending"
    try:
        response = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'})
        response.raise_for_status()
    except requests.exceptions.RequestException:
        print("    - FATAL: Could not fetch GitHub page."); driver.close(); return

    soup = BeautifulSoup(response.text, 'html.parser')
    repo_list = soup.find_all('article', class_='Box-row')
    processed_count = 0

    with driver.session() as session:
        for repo in repo_list:
            try:
                repo_link = repo.find('h2', class_='h3').find('a')
                full_name = repo_link['href'].strip().lstrip('/')
                owner, repo_name = full_name.split('/')
                star_tag = repo.find('a', href=f'/{full_name}/stargazers')
                stars_text = star_tag.text.strip().replace(',', '')
                stars = int(stars_text) if stars_text.isdigit() else 0
                lang_tag = repo.find('span', itemprop='programmingLanguage')
                language = lang_tag.text.strip() if lang_tag else 'N/A'
                
                project_data = {
                    'repo_name': repo_name, 'owner': owner, 
                    'url': f"https://github.com{repo_link['href']}", 
                    'stars': stars, 'language': language
                }
                
                session.execute_write(update_project_node_with_velocity, project_data)
                processed_count += 1
            except Exception:
                continue
    
    driver.close()
    print(f"    - GitHub: Processed {processed_count} projects, updating velocity.")

if __name__ == '__main__':
    scrape_github_trending()
