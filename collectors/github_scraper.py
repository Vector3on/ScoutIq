import os
import requests
from bs4 import BeautifulSoup
import sqlite3
import time

# Define the path to the database
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'leads.db')

def save_to_db(con, cur, repo_data):
    """
    Saves a single repository's data to the database.
    Uses INSERT OR IGNORE to prevent duplicate entries based on the URL.
    """
    try:
        cur.execute("""
            INSERT INTO github_leads (repo_name, owner, url, stars, language)
            VALUES (:repo_name, :owner, :url, :stars, :language)
            ON CONFLICT(url) DO NOTHING
        """, repo_data)
        # The ON CONFLICT clause requires a UNIQUE constraint on the 'url' column, which we have.
    except sqlite3.IntegrityError as e:
        print(f"Skipping duplicate or invalid entry for {repo_data.get('url')}: {e}")
    except Exception as e:
        print(f"An unexpected error occurred during database insertion: {e}")


def scrape_github_trending():
    """
    Scrapes GitHub's trending page for repositories.
    Extracts name, owner, url, stars, and language.
    Inserts or updates the findings into the SQLite database.
    """
    print("Initiating scrape of GitHub Trending page...")
    url = "https://github.com/trending"
    try:
        response = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'})
        response.raise_for_status()  # Will raise an HTTPError for bad responses
    except requests.exceptions.RequestException as e:
        print(f"FATAL: Could not fetch the GitHub trending page. Error: {e}")
        return

    soup = BeautifulSoup(response.text, 'html.parser')
    repo_list = soup.find_all('article', class_='Box-row')

    if not repo_list:
        print("WARNING: Could not find the repository list. The page structure might have changed.")
        return

    print(f"Found {len(repo_list)} repositories. Processing...")

    # Establish database connection
    try:
        con = sqlite3.connect(DB_PATH)
        cur = con.cursor()
    except sqlite3.Error as e:
        print(f"FATAL: Could not connect to the database at {DB_PATH}. Error: {e}")
        return

    processed_count = 0
    for repo in repo_list:
        try:
            # Extract owner and repo name from the main link
            repo_link = repo.find('h2', class_='h3').find('a')
            full_name = repo_link['href'].strip().lstrip('/')
            owner, repo_name = full_name.split('/')

            # Extract stars
            star_tag = repo.find('a', href=f'/{full_name}/stargazers')
            # The star count is a string like "1,234". We must clean it.
            stars_text = star_tag.text.strip().replace(',', '')
            stars = int(stars_text) if stars_text.isdigit() else 0

            # Extract language
            lang_tag = repo.find('span', itemprop='programmingLanguage')
            language = lang_tag.text.strip() if lang_tag else 'N/A'

            repo_data = {
                'repo_name': repo_name,
                'owner': owner,
                'url': f"https://github.com{repo_link['href']}",
                'stars': stars,
                'language': language
            }

            save_to_db(con, cur, repo_data)
            processed_count += 1

        except (AttributeError, TypeError, ValueError) as e:
            # This handles cases where a repo card is structured differently or data is missing
            print(f"WARNING: Skipping a repository due to parsing error: {e}")
            continue

    # Commit changes and close the connection
    con.commit()
    con.close()

    print(f"Scrape complete. {processed_count}/{len(repo_list)} repositories processed and saved to the database.")

if __name__ == '__main__':
    # Ensure the database and its directory exist before running
    if not os.path.exists(DB_PATH):
        print(f"FATAL: Database not found at {DB_PATH}. Please run the initialization script first.")
    else:
        scrape_github_trending()