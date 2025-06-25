# tools/clear_database.py
#
# A simple utility to wipe the Neo4j database clean.
# This is useful for ensuring that CI/CD pipeline runs are idempotent and
# start from a known, clean state.

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
            # The 'DETACH DELETE' clause deletes nodes and any relationships connected to them.
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
    # Add a confirmation step for safety if run manually
    response = input("Are you sure you want to permanently delete all data from the database? (yes/no): ")
    if response.lower() == 'yes':
        clear_database()
    else:
        print("Database clearing cancelled.")
