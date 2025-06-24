import os
from neo4j import GraphDatabase
import requests
from bs4 import BeautifulSoup

# --- CONFIGURATION ---
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")

def create_project_and_founder(tx, project_data):
    """
    This query is now much smarter.
    1. It creates or merges the Project node.
    2. It creates or merges the Founder node based on the project owner.
    3. It creates a [:FOUNDED] relationship between them.
    """
    query = """
    // Find or create the Project
    MERGE (p:Project {display_name: $repo_name})
    ON CREATE SET
        p.url = $url,
        p.owner = $owner,
        p.language = $language,
        p.stars = $stars,
        p.first_seen_at = timestamp()
    ON MATCH SET
        p.stars_delta_1d = $stars - p.stars,
        p.stars = $stars,
        p.last_seen_at = timestamp()
    
    // Find or create the Founder
    MERGE (f:Founder {name: $owner})

    // Create the relationship between them
    MERGE (f)-[r:FOUNDED]->(p)
    """
    tx.run(query, **project_data)

def scrape_github_trending():
    """Scrapes GitHub and creates Project and Founder nodes in the graph."""
    print("  - Scraping GitHub (Founder-Aware)...")
    if not URI: print("    - FATAL: Neo4j credentials not found."); return
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
                
                project_data = {
                    'repo_name': repo_name, 'owner': owner, 
                    'url': f"https://github.com{repo_link['href']}", 
                    'stars': stars, 'language': repo.find('span', itemprop='programmingLanguage').text.strip() if repo.find('span', itemprop='programmingLanguage') else 'N/A'
                }
                session.execute_write(create_project_and_founder, project_data)
                processed_count += 1
            except:
                continue
    
    driver.close()
    print(f"    - GitHub: Processed {processed_count} projects and founders into the graph.")

if __name__ == '__main__':
    scrape_github_trending()
