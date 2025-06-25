import os
import sys
import argparse
from neo4j import GraphDatabase
from sentence_transformers import SentenceTransformer, util

# --- CONFIGURATION ---
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")
MODEL_NAME = "all-mpnet-base-v2"

def find_similar_projects(target_project_name: str, top_k: int):
    """
    Finds and ranks projects semantically similar to a target project.
    """
    if not URI:
        print("FATAL: Neo4j credentials not found in environment.")
        return

    print(f"Initiating semantic search for projects similar to: '{target_project_name}'")
    print(f"Loading model: '{MODEL_NAME}'...")
    model = SentenceTransformer(MODEL_NAME)

    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    with driver.session() as session:
        # Get all projects from the graph to create a searchable corpus
        result = session.run("MATCH (p:Project) RETURN p.display_name AS name, p.url AS url")
        all_projects = [{"name": record["name"], "url": record["url"]} for record in result]
        
        if not all_projects:
            print("No projects found in the database.")
            return

        project_names = [p["name"] for p in all_projects]
        
        # Check if the target project exists
        if target_project_name not in project_names:
            print(f"ERROR: Project '{target_project_name}' not found in the database.")
            return

        print("Encoding all project names...")
        # Encode all project names into vector embeddings
        corpus_embeddings = model.encode(project_names, convert_to_tensor=True)
        # Encode the target project name
        query_embedding = model.encode(target_project_name, convert_to_tensor=True)

        print("Calculating similarity scores...")
        # Use cosine similarity to find the most similar projects
        cos_scores = util.cos_sim(query_embedding, corpus_embeddings)[0]
        
        # Get the top_k+1 results (since the top result will be the project itself)
        top_results = cos_scores.topk(top_k + 1)
        
        print("\n" + "="*50)
        print(f"Top {top_k} most similar projects to '{target_project_name}':")
        print("="*50)
        
        # Iterate through the results, skipping the first one (which is the query itself)
        for score, idx in zip(top_results[0][1:], top_results[1][1:]):
            similar_project = all_projects[idx]
            print(f"- {similar_project['name']} (Score: {score:.4f})")
            print(f"  URL: {similar_project['url']}")
            
    driver.close()

if __name__ == '__main__':
    # Set up argparse to accept command-line arguments
    parser = argparse.ArgumentParser(description="Find projects semantically similar to a target project.")
    parser.add_argument("project_name", type=str, help="The name of the target project to find similarities for.")
    parser.add_argument("--top_k", type=int, default=5, help="Number of similar projects to return.")
    
    args = parser.parse_args()
    
    find_similar_projects(target_project_name=args.project_name, top_k=args.top_k)
