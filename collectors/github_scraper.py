# collectors/github_scraper.py
#
# This is the corrected version that ensures a `project_id` is always created.

import os
from neo4j import GraphDatabase

# A hardcoded list of influential repositories to track.
# This can be expanded or moved to a config file later.
PROJECT_LIST = [
    "ollama/ollama", "ggerganov/llama.cpp", "langchain-ai/langchain",
    "facebookresearch/llama", "AUTOMATIC1111/stable-diffusion-webui",
    "jmorganca/ollama", # Duplicate to test MERGE
    "vllm-project/vllm", "huggingface/transformers", "huggingface/diffusers",
    "microsoft/guidance", "InternLM/InternLM", "openai/openai-python",
    "google/gemini.py", "NVIDIA/TensorRT-LLM", "triton-lang/triton",
    "liltom-eth/llama2-webui", "CorentinJ/Real-Time-Voice-Cloning",
    "lobe/lobe-chat", "dortania/OpenCore-Legacy-Patcher" # Example of a non-AI project
]

class GitHubScraper:
    """
    Scrapes GitHub project data and stores it in a Neo4j graph.
    This version ensures `project_id` is correctly set.
    """

    def __init__(self, uri, user, password):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))

    def close(self):
        self.driver.close()

    def get_mock_github_data(self, repo_full_name):
        """
        Mocks fetching data from GitHub API. In a real-world scenario,
        this would use the `requests` library to call the GitHub API.
        """
        # Simple mock data for demonstration purposes
        # The star count is semi-random to simulate changes
        import random
        owner, name = repo_full_name.split('/')
        return {
            "full_name": repo_full_name,
            "name": name,
            "owner": owner,
            "description": f"A mock description for {name}.",
            "stargazers_count": random.randint(1000, 100000),
            "html_url": f"https://github.com/{repo_full_name}"
        }

    def scrape_and_update(self):
        """
        Processes each project in the PROJECT_LIST, fetches its data,
        and updates the Neo4j database, calculating velocity.
        """
        print("  - Scraping GitHub (Velocity-Aware)...")
        with self.driver.session(database="neo4j") as session:
            for repo_full_name in set(PROJECT_LIST): # Use set to handle duplicates
                data = self.get_mock_github_data(repo_full_name)

                # THE CRITICAL FIX IS HERE:
                # We use MERGE on the `project_id` to either find the existing
                # project node or create a new one if it doesn't exist.
                # The `project_id` is the unique identifier for each project.
                query = """
                // Find or create the project using its unique ID
                MERGE (p:Project {project_id: $repo_full_name})

                // Set properties on creation (for new projects)
                ON CREATE SET
                    p.name = $name,
                    p.owner = $owner,
                    p.description = $description,
                    p.url = $url,
                    p.source = 'GitHub',
                    p.stars = $stars,
                    p.stars_delta_1d = 0, // Initialize delta to 0
                    p.last_scraped_at = timestamp()

                // Update properties on match (for existing projects)
                ON MATCH SET
                    // Calculate stars_delta_1d if the node already exists
                    p.stars_delta_1d = $stars - p.stars,
                    p.stars = $stars, // Update the star count
                    p.last_scraped_at = timestamp()
                """
                session.run(query,
                    repo_full_name=data['full_name'],
                    name=data['name'],
                    owner=data['owner'],
                    description=data.get('description', 'No description available.'),
                    url=data['html_url'],
                    stars=data['stargazers_count']
                )
        print(f"    - GitHub: Processed {len(set(PROJECT_LIST))} projects, creating/updating nodes with project_id.")


if __name__ == "__main__":
    NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    NEO4J_USER = os.environ.get("NEO4J_USERNAME", "neo4j")
    NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")
    
    scraper = GitHubScraper(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
    try:
        scraper.scrape_and_update()
    finally:
        scraper.close()

