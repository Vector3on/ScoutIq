# tools/clear_database.py
#
# This version is CI-aware. It will not prompt for confirmation if it
# detects it's running in a GitHub Actions environment.

import os
import sys
from neo4j import GraphDatabase

def clear_database():
    """
    Connects to Neo4j and deletes all nodes and relationships.
    """
    NEO4J_URI = os.environ.get("NEO4J_URI")
    NEO4J_USER = os.environ.get("NEO4J_USERNAME")
    NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD")

    if not all([NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD]):
        print("ERROR: Neo4j credentials are not set.")
        sys.exit(1)

    driver = None
    try:
        driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        with driver.session(database="neo4j") as session:
            print("Connecting to Neo4j to clear the database...")
            query = "MATCH (n) DETACH DELETE n"
            result = session.run(query)
            summary = result.consume()
            print(f"Database cleared successfully. {summary.counters.nodes_deleted} nodes and {summary.counters.relationships_deleted} relationships deleted.")

    except Exception as e:
        print(f"An error occurred while clearing the database: {e}")
        sys.exit(1)
    finally:
        if driver:
            driver.close()

if __name__ == "__main__":
    # The 'CI' environment variable is set to 'true' by default in GitHub Actions.
    # This check makes the script safe for both manual and automated execution.
    if os.environ.get("CI") == "true":
        print("CI environment detected. Clearing database without confirmation.")
        clear_database()
    else:
        # Keep the confirmation step for safety when run manually
        response = input("Are you sure you want to permanently delete all data from the database? (yes/no): ")
        if response.lower() == 'yes':
            clear_database()
        else:
            print("Database clearing cancelled.")
