# tools/semantic_search.py
#
# Project Bloodhound: Ordnance 3.2 - Semantic Search (Final Version)
#
# This version contains the fix for the subscriptable error.

import os
import argparse
from typing import List, Dict, Any

from neo4j import GraphDatabase
from sentence_transformers import SentenceTransformer
from sentence_transformers.util import cos_sim
import torch

# --- Configuration ---
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")
MODEL_NAME = 'all-MiniLM-L6-v2'

class SemanticSearchTool:
    """
    A tool to perform semantic search on Project nodes in a Neo4j graph.
    """

    def __init__(self, uri: str, user: str, password: str):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        print("Successfully connected to Neo4j database.")
        print(f"Loading sentence transformer model: '{MODEL_NAME}'...")
        self.model = SentenceTransformer(MODEL_NAME)
        print("Model loaded successfully.")

    def close(self):
        if self.driver:
            self.driver.close()
            print("Neo4j connection closed.")

    def get_all_project_embeddings(self) -> List[Dict[str, Any]]:
        query = """
        MATCH (p:Project)
        WHERE p.embedding IS NOT NULL AND p.name IS NOT NULL
        RETURN p.name AS name, p.description AS description, p.embedding AS embedding
        """
        print("Fetching all project vectors from the database...")
        with self.driver.session() as session:
            results = session.run(query)
            projects = [record.data() for record in results]
        print(f"Found {len(projects)} projects with embeddings to search against.")
        return projects

    def find_similar_projects(self, query_text: str, top_n: int = 5) -> List[Dict[str, Any]]:
        if not query_text:
            return []

        projects = self.get_all_project_embeddings()
        if not projects:
            return []

        print(f"\nGenerating embedding for search term: '{query_text}'")
        query_embedding = self.model.encode(query_text, convert_to_tensor=True)

        print("Calculating cosine similarity scores...")
        project_embeddings = torch.tensor([p['embedding'] for p in projects], dtype=torch.float32)
        
        cosine_scores = cos_sim(query_embedding, project_embeddings)

        top_results = torch.topk(cosine_scores, k=min(top_n, len(projects)))

        # --- THE CRITICAL FIX IS HERE ---
        # The typo was `tolist[0]`. The correct syntax is `tolist()[0]`,
        # which calls the tolist() function and then gets the first item.
        search_results = []
        scores = top_results.values.tolist()[0]
        indices = top_results.indices.tolist()[0]

        for score, idx in zip(scores, indices):
            project = projects[idx]
            search_results.append({
                "name": project["name"],
                "description": project.get("description", "N/A"),
                "similarity_score": round(score, 4)
            })
        
        print(f"Found {len(search_results)} thematically similar projects.")
        return search_results

def main():
    parser = argparse.ArgumentParser(description="Project Bloodhound: Semantic Search Tool")
    parser.add_argument("query", type=str, help="The search concept.")
    parser.add_argument("-n", "--top-n", type=int, default=5, help="Number of results.")
    args = parser.parse_args()

    search_tool = None
    try:
        search_tool = SemanticSearchTool(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
        results = search_tool.find_similar_projects(args.query, args.top_n)

        if results:
            print("\n--- Semantic Search Results ---")
            print(f"Top {len(results)} projects similar to '{args.query}':\n")
            for i, result in enumerate(results):
                print(f"{i+1}. {result['name']} (Score: {result['similarity_score']})")
                print(f"   Description: {result['description']}\n")
            print("-----------------------------")
        else:
            print(f"\n--- No results found for '{args.query}'. ---")

    except Exception as e:
        print(f"\nAn unexpected error occurred: {e}")
    finally:
        if search_tool:
            search_tool.close()

if __name__ == "__main__":
    main()
