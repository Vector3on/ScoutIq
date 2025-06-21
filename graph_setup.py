import os
from neo4j import GraphDatabase

# --- CONFIGURATION ---
# Read credentials from environment variables (provided by GitHub Actions secrets)
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")

def setup_graph_constraints():
    """Connects to the Neo4j database and ensures necessary constraints are created."""
    if not URI or not USERNAME or not PASSWORD:
        print("FATAL: Database credentials not found in environment variables.")
        print("Please ensure NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD are set.")
        return

    print("Connecting to Neo4j AuraDB...")
    try:
        driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
        with driver.session() as session:
            # Create a uniqueness constraint on the 'display_name' property for all 'Project' nodes.
            # This prevents duplicate projects and speeds up lookups.
            print("  - Creating constraint for Project nodes...")
            session.run("""
            CREATE CONSTRAINT project_display_name_unique 
            IF NOT EXISTS 
            FOR (p:Project) 
            REQUIRE p.display_name IS UNIQUE
            """)
            print("  - SUCCESS: Constraint 'project_display_name_unique' is active.")
        driver.close()
        print("Connection closed.")
        print("\nSUCCESS: Graph database is ready for Bloodhound.")
    except Exception as e:
        print(f"\nFATAL: An error occurred while connecting or setting up constraints: {e}")

if __name__ == "__main__":
    setup_graph_constraints()
