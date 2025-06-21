import os
import sqlite3
import requests
from bs4 import BeautifulSoup

# Use a relative path to find the database
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'leads.db')

def scrape_github_trending():
    print("  - Scraping GitHub Trending...")
    url = "https://github.com/trending"
    try:
        response = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'})
        response.raise_for_status()
    except requests.exceptions.RequestException:
        print("    - FATAL: Could not fetch the GitHub trending page.")
        return

    soup = BeautifulSoup(response.text, 'html.parser')
    repo_list = soup.find_all('article', class_='Box-row')

    if not repo_list:
        print("    - WARNING: Could not find GitHub repository list.")
        return

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    processed_count = 0

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
            repo_data = {'repo_name': repo_name, 'owner': owner, 'url': f"https://github.com{repo_link['href']}", 'stars': stars, 'language': language}
            
            cur.execute("INSERT INTO github_leads (repo_name, owner, url, stars, language) VALUES (:repo_name, :owner, :url, :stars, :language) ON CONFLICT(url) DO NOTHING", repo_data)
            processed_count += 1
        except:
            continue
            
    con.commit()
    con.close()
    print(f"    - GitHub: Found and processed {processed_count} leads.")

if __name__ == '__main__':
    scrape_github_trending()
