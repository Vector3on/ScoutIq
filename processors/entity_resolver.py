import os
import json
import sys
from neo4j import GraphDatabase
from sentence_transformers import SentenceTransformer, util

# --- CONFIGURATION (from your specifications) ---
# Load the path from an environment variable, falling back to a default.
LEADS_PATH = os.environ.get("REDDIT_LEADS_PATH", "reddit_leads.json")
# The similarity threshold for considering a match.
THRESHOLD = float(os.environ.get("SIMILARITY_THRESHOLD", "0.5")) # Adjusted for sentence embeddings

URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")

def load_and_validate_leads():
    """
    Loads Reddit leads from a JSON file and validates them.
    Exits if the file is not found or contains no valid leads.
    """
    print(f"  - Loading Reddit leads from: {LEADS_PATH}")
    try:
        with open(LEADS_PATH, "r") as f:
            leads = json.load(f)
    except FileNotFoundError:
        print(f"    - ERROR: Leads file not found at '{LEADS_PATH}'. Exiting.")
        sys.exit(1) # Use sys.exit for a cleaner exit
    except json.JSONDecodeError:
        print(f"    - ERROR: Could not decode JSON from '{LEADS_PATH}'. Exiting.")
        sys.exit(1)

    # Filter out invalid entries as you specified.
    validated_leads = [
        lead for lead in leads 
        if isinstance(lead, dict) and "title" in lead and "url" in lead
    ]

    if not validated_leads:
        print("    - No valid leads found after filtering. Exiting.")
        sys.exit(1)
        
    print(f"    - Found {len(validated_leads)} valid leads to process.")
    return validated_leads

def run_resolver():
    """
    Uses a local sentence-transformer model to perform entity resolution
    between projects in the graph and leads from a local JSON file.
    """
    print("  - Running Local AI-Powered Entity Resolver...")
    if not URI:
        print("    - FATAL: Neo4j credentials not found.")
        return

    # 1. Load and validate the leads from the JSON file.
    leads = load_and_validate_leads()

    # 2. Get the list of project names from our graph database.
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    with driver.session() as session:
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        project_names = [row["name"] for row in projects_result]

    if not project_names:
        print("    - No projects found in the database to match against.")
        driver.close()
        return

    # 3. Use the sentence-transformer model to find matches.
    print("  - Loading sentence-transformer model (all-mpnet-base-v2)...")
    model = SentenceTransformer("all-mpnet-base-v2")

    print("  - Encoding projects and leads...")
    project_embeddings = model.encode(project_names, convert_to_numpy=True)
    lead_titles = [lead["title"] for lead in leads]
    lead_embeddings = model.encode(lead_titles, convert_to_numpy=True)

    print("  - Calculating similarity scores...")
    linked_count = 0
    with driver.session() as session:
        for i, lead_embedding in enumerate(lead_embeddings):
            # Calculate cosine similarity between the current lead and all projects
            cos_sim = util.cos_sim(lead_embedding, project_embeddings).flatten()
            
            # Find the best match
            best_match_idx = cos_sim.argmax()
            best_match_score = cos_sim[best_match_idx]
            
            if best_match_score >= THRESHOLD:
                best_match_name = project_names[best_match_idx]
                lead_title = leads[i]["title"]
                lead_url = leads[i]["url"]
                
                print(f"    - >>> MATCH FOUND: Linking '{lead_title[:40]}...' to '{best_match_name}' (Score: {best_match_score:.2f})")
                
                # Create the relationship in the graph
                session.run("""
                    MATCH (p:Project {display_name: $project_name})
                    MATCH (s:Signal {url: $signal_url})
                    MERGE (p)-[:HAS_SIGNAL]->(s)
                """, project_name=best_match_name, signal_url=lead_url)
                linked_count += 1

    print(f"  - Local AI resolution complete. {linked_count} new links found.")
    driver.close()

if __name__ == '__main__':
    run_resolver()
