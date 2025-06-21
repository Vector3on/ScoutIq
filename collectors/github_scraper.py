import os
from neo4j import GraphDatabase

# --- CONFIGURATION ---
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")
# We re-import requests here as it's a direct dependency of this script
import requests
from bs4 import BeautifulSoup

def create_project_node(tx, project_data):
    """
    Executes a Cypher query to create or update a Project node.
    MERGE finds a node with the matching display_name or creates it if it doesn't exist.
    ON CREATE sets properties only when the node is first created.
    ON MATCH updates properties every time we see the project.
    """
    query = """
    MERGE (p:Project {display_name: $repo_name})
    ON CREATE SET
        p.url = $url,
        p.owner = $owner,
        p.language = $language,
        p.stars = $stars,
        p.first_seen_at = timestamp()
    ON MATCH SET
        p.stars = $stars,
        p.language = $language,
        p.last_seen_at = timestamp()
    """
    tx.run(query, **project_data)

def scrape_github_trending():
    """Scrapes GitHub and creates/updates Project nodes in the Neo4j database."""
    print("  - Scraping GitHub Trending (for Neo4j)...")
    if not URI:
        print("    - FATAL: Neo4j credentials not found. Cannot proceed.")
        return

    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    
    url = "https://github.com/trending"
    try:
        response = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'})
        response.raise_for_status()
    except requests.exceptions.RequestException:
        print("    - FATAL: Could not fetch GitHub page.")
        driver.close()
        return

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
                    'repo_name': repo_name, 
                    'owner': owner, 
                    'url': f"https://github.com{repo_link['href']}", 
                    'stars': stars, 
                    'language': language
                }
                
                session.execute_write(create_project_node, project_data)
                processed_count += 1
            except:
                continue
    
    driver.close()
    print(f"    - GitHub: Processed {processed_count} projects into the graph.")

if __name__ == '__main__':
    scrape_github_trending()

