# tools/semantic_search.py
#
# Project Bloodhound: Ordnance 3.2 - Semantic Search (Robust Version)
#
# Objective:
# Build a tool that allows an analyst to search the graph based on
# meaning, not just keywords.
#
# Mechanism:
# This script takes a general search term as input. It generates a
# sentence embedding for this term and uses cosine similarity to find the
# top N most thematically similar Project nodes in the Neo4j database.
# This version does NOT require the search term to exist as a project name.

import os
import argparse
from typing import List, Dict, Any

from neo4j import GraphDatabase
from sentence_transformers import SentenceTransformer
from sentence_transformers.util import cos_sim
import torch

# --- Configuration ---

# Load Neo4j credentials from environment variables for security
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")

# Using 'all-MiniLM-L6-v2' as it is a good balance of performance and size.
# Ensure this is consistent with your data processing pipeline.
MODEL_NAME = 'all-MiniLM-L6-v2'

class SemanticSearchTool:
    """
    A tool to perform semantic search on Project nodes in a Neo4j graph.
    """

    def __init__(self, uri: str, user: str, password: str):
        """
        Initializes the connection to Neo4j and loads the sentence transformer model.
        """
        try:
            self.driver = GraphDatabase.driver(uri, auth=(user, password))
            self.driver.verify_connectivity()
            print("Successfully connected to Neo4j database.")
        except Exception as e:
            print(f"Error: Could not connect to Neo4j. Please check credentials and URI.")
            print(f"Details: {e}")
            raise

        try:
            print(f"Loading sentence transformer model: '{MODEL_NAME}'...")
            self.model = SentenceTransformer(MODEL_NAME)
            print("Model loaded successfully.")
        except Exception as e:
            print(f"Error: Could not load the sentence transformer model.")
            print(f"Details: {e}")
            raise

    def close(self):
        """Closes the Neo4j database connection."""
        if self.driver:
            self.driver.close()
            print("Neo4j connection closed.")

    def get_all_project_embeddings(self) -> List[Dict[str, Any]]:
        """
        Retrieves all 'Project' nodes that have an embedding property.

        Returns:
            A list of dictionaries, where each dictionary contains the project's
            name, description, and its pre-computed embedding vector.
        """
        # Corrected Cypher query to use `IS NOT NULL` as required by modern Neo4j versions.
        query = """
        MATCH (p:Project)
        WHERE p.embedding IS NOT NULL AND p.name IS NOT NULL
        RETURN p.name AS name, p.description AS description, p.embedding AS embedding
        """
        print("Fetching all project vectors from the database...")
        with self.driver.session() as session:
            results = session.run(query)
            projects = [record.data() for record in results]
        
        if not projects:
            print("\nWARNING: No projects with embeddings found in the database.")
            print("The search cannot proceed without data.")
            print("Please ensure your data processing pipeline (e.g., entity_resolver.py) has run successfully and populated the 'embedding' property on Project nodes.\n")
            
        print(f"Found {len(projects)} projects with embeddings to search against.")
        return projects

    def find_similar_projects(self, query_text: str, top_n: int = 5) -> List[Dict[str, Any]]:
        """
        Finds the top N most similar projects to a given query concept.

        Args:
            query_text: The natural language query concept (e.g., "a tool for data visualization").
            top_n: The number of similar projects to return.

        Returns:
            A list of the top N projects, sorted by similarity score, each as a dictionary.
        """
        if not query_text:
            print("Error: Query text cannot be empty.")
            return []

        # 1. Fetch all available project embeddings from the database
        projects = self.get_all_project_embeddings()
        if not projects:
            return [] # Stop if there are no projects to search against.

        # 2. Generate embedding for the input query term
        print(f"\nGenerating embedding for search term: '{query_text}'")
        query_embedding = self.model.encode(query_text, convert_to_tensor=True)

        # 3. Calculate cosine similarity against all projects
        print("Calculating cosine similarity scores...")
        project_embeddings = torch.tensor([p['embedding'] for p in projects], dtype=torch.float32)
        
        cosine_scores = cos_sim(query_embedding, project_embeddings)

        # 4. Rank projects by similarity
        top_results = torch.topk(cosine_scores, k=min(top_n, len(projects)))

        # 5. Format and return the results
        search_results = []
        for score, idx in zip(top_results.values.tolist()[0], top_results.indices.tolist[0]):
            project = projects[idx]
            search_results.append({
                "name": project["name"],
                "description": project.get("description", "N/A"),
                "similarity_score": round(score, 4)
            })
        
        print(f"Found {len(search_results)} thematically similar projects.")
        return search_results

def main():
    """
    Main function to run the semantic search tool from the command line.
    """
    parser = argparse.ArgumentParser(description="Project Bloodhound: Semantic Search Tool")
    parser.add_argument(
        "query",
        type=str,
        help="The search concept in natural language (e.g., 'a database for time-series data')."
    )
    parser.add_argument(
        "-n", "--top-n",
        type=int,
        default=5,
        help="The number of top results to display."
    )
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
                print(f"   Description: {result['description']}")
            print("\n-----------------------------")
        else:
            print(f"\n--- No results found for '{args.query}'. ---")
            print("This could be because no projects with embeddings exist in the database, or none were thematically similar.")

    except Exception as e:
        print(f"\nAn unexpected error occurred: {e}")
    finally:
        # Ensure the connection is closed even if errors occur
        if search_tool:
            search_tool.close()


if __name__ == "__main__":
    # To run this script:
    # 1. Make sure you have the required packages:
    #    pip install neo4j sentence-transformers torch
    # 2. Set your Neo4j environment variables:
    #    export NEO4J_URI="bolt://your_neo4j_host:7687"
    #    export NEO4J_USER="your_username"
    #    export NEO4J_PASSWORD="your_password"
    # 3. Run from your terminal:
    #    python tools/semantic_search.py "large language model"
    main()
