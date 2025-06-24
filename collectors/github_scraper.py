import os
from neo4j import GraphDatabase
import requests
from bs4 import BeautifulSoup

URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")

def create_project_and_founder(tx, project_data):
    query = """
    MERGE (p:Project {display_name: $repo_name})
    ON CREATE SET p.url = $url, p.owner = $owner, p.language = $language, p.stars = $stars, p.first_seen_at = timestamp()
    ON MATCH SET p.stars_delta_1d = $stars - p.stars, p.stars = $stars, p.last_seen_at = timestamp()
    MERGE (f:Founder {name: $owner})
    MERGE (f)-[r:FOUNDED]->(p)
    """
    tx.run(query, **project_data)

def scrape_github_trending():
    print("  - Scraping GitHub (Founder-Aware)...")
    if not URI: return
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    url = "https://github.com/trending"
    try:
        response = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'})
        response.raise_for_status()
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
                    stars = int(star_tag.text.strip().replace(',', ''))
                    lang_tag = repo.find('span', itemprop='programmingLanguage')
                    language = lang_tag.text.strip() if lang_tag else 'N/A'
                    project_data = {
                        'repo_name': repo_name, 'owner': owner,
                        'url': f"https://github.com{repo_link['href']}",
                        'stars': stars, 'language': language
                    }
                    session.execute_write(create_project_and_founder, project_data)
                    processed_count += 1
                except (AttributeError, ValueError, TypeError):
                    continue
        print(f"    - GitHub: Processed {processed_count} projects and founders.")
    finally:
        driver.close()

if __name__ == '__main__':
    scrape_github_trending()
