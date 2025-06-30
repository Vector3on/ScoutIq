# loaders/neo4j_loader.py
import os
import json
import glob
from neo4j import GraphDatabase

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")

class Neo4jLoader:
    def __init__(self, uri, user, password):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))

    def close(self):
        self.driver.close()

    def load_signals_from_file(self, file_path):
        """Loads a single JSON file of signals into Neo4j."""
        print(f"  - Loading signals from {os.path.basename(file_path)}...")
        with self.driver.session(database="neo4j") as session:
            with open(file_path, 'r') as f:
                signals = json.load(f)
                for signal in signals:
                    self.run_upsert_query(session, signal)
        print(f"    - Loaded {len(signals)} signals.")

    def run_upsert_query(self, session, signal):
        """
        Runs a Cypher query to intelligently merge a Project and its Signal,
        and ensure the relationship between them exists.
        """
        query = """
        // Find or create the Project node
        MERGE (p:Project {project_id: $project_id})
        ON CREATE SET
            p.source = 'GitHub', // Assume project originates from GitHub for now
            p.last_scraped_at = timestamp()
        
        // Find or create the Signal node
        MERGE (s:Signal {url: $signalUrl})
        ON CREATE SET
            s.title = $title,
            s.source = $source,
            s.created_at = datetime($createdAt),
            s.upvotes = $upvotes
        ON MATCH SET
            s.upvotes = $upvotes // Always update upvotes
            
        // Ensure the relationship exists
        MERGE (p)-[r:HAS_SIGNAL]->(s)
        """
        session.run(query, **signal)

def load_all_signals(directory="results"):
    """Finds all signal JSON files in a directory and loads them."""
    if not NEO4J_PASSWORD:
        print("    - WARN: NEO4J_PASSWORD not found. Skipping Neo4j loading.")
        return

    loader = Neo4jLoader(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
    try:
        json_files = glob.glob(os.path.join(directory, "*.json"))
        if not json_files:
            print("  - No signal files found to load.")
            return
            
        print("--- Loading All Signals into Neo4j ---")
        for file_path in json_files:
            loader.load_signals_from_file(file_path)
    finally:
        loader.close()
    print("✅ Neo4j loading complete.")
