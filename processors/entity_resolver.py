# processors/entity_resolver.py
#
# Project Bloodhound: Part of Phase II - The Unforkable Moat
#
# Objective:
# Enrich the knowledge graph by creating semantic vector embeddings
# for Project nodes. This is the core of the proprietary IP and enables
# semantic search capabilities.
#
# Mechanism:
# This script reads Project nodes from the database that do not yet have an
# embedding. It generates an embedding based on the project's name and
# description, then writes this new `embedding` property back to the node.

import os
from neo4j import GraphDatabase
from sentence_transformers import SentenceTransformer

# --- Configuration ---
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")

# This model should be consistent with the one used in `tools/semantic_search.py`
MODEL_NAME = 'all-MiniLM-L6-v2'

class EntityResolver:
    """
    Creates and stores vector embeddings for Project nodes.
    """

    def __init__(self, uri: str, user: str, password: str):
        """
        Initializes the Neo4j connection and loads the sentence transformer model.
        """
        try:
            self.driver = GraphDatabase.driver(uri, auth=(user, password))
            self.driver.verify_connectivity()
            print("Successfully connected to Neo4j database.")
        except Exception as e:
            print(f"Error: Could not connect to Neo4j. Details: {e}")
            raise

        try:
            print(f"Loading sentence transformer model: '{MODEL_NAME}'...")
            self.model = SentenceTransformer(MODEL_NAME)
            print("Model loaded successfully.")
        except Exception as e:
            print(f"Error: Could not load the sentence transformer model. Details: {e}")
            raise

    def close(self):
        """Closes the Neo4j database connection."""
        if self.driver:
            self.driver.close()
            print("Neo4j connection closed.")

    def process_projects(self):
        """
        Finds projects without embeddings, generates them, and updates the database.
        """
        print("Starting entity resolution process...")
        with self.driver.session(database="neo4j") as session:
            # 1. Find all projects that are missing the 'embedding' property.
            query = """
            MATCH (p:Project)
            WHERE p.embedding IS NULL
            RETURN p.project_id AS project_id, p.name AS name, p.description AS description
            """
            print("Finding projects that need embeddings...")
            results = session.run(query)
            projects_to_process = [record.data() for record in results]

            if not projects_to_process:
                print("No projects found requiring new embeddings. All are up-to-date.")
                return

            print(f"Found {len(projects_to_process)} projects to process.")

            updates = []
            print("Generating embeddings...")
            for project in projects_to_process:
                # Combine name and description for a richer embedding
                text_to_embed = f"{project.get('name', '')}. {project.get('description', '')}"
                
                # Check if there is meaningful text to embed
                if not text_to_embed.strip() or text_to_embed.strip() == ".":
                    print(f"Skipping project_id {project.get('project_id')} due to empty name/description.")
                    continue

                embedding = self.model.encode(text_to_embed).tolist()
                updates.append({
                    'project_id': project['project_id'],
                    'embedding': embedding
                })

            # 2. Write the new embeddings back to the database in a batch
            if not updates:
                print("No valid projects to update after filtering. Exiting.")
                return

            print(f"Writing {len(updates)} new embeddings back to the database...")
            update_query = """
            UNWIND $updates AS update
            MATCH (p:Project {project_id: update.project_id})
            SET p.embedding = update.embedding
            """
            session.run(update_query, updates=updates)
            print("Entity resolution process completed successfully.")

def main():
    """
    Main function to run the entity resolver processor.
    """
    resolver = None
    try:
        resolver = EntityResolver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
        resolver.process_projects()
    except Exception as e:
        print(f"\nAn unexpected error occurred: {e}")
    finally:
        if resolver:
            resolver.close()

if __name__ == "__main__":
    # To run this script:
    # 1. Ensure packages are installed: pip install neo4j sentence-transformers
    # 2. Set Neo4j environment variables.
    # 3. Run from terminal: python processors/entity_resolver.py
    main()
