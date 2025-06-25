# processors/unified_scorer.py
#
# Project Bloodhound: Ordnance 3.3 - Holistic Graph-Based Scoring
#
# Objective:
# Replace simple, rule-based scoring with a dynamic score derived
# from the entire knowledge graph.
#
# Mechanism:
# This script calculates a single, unified `bloodhound_score` for each Project node,
# considering multiple factors to gauge momentum and influence.

import os
import math
from neo4j import GraphDatabase

# --- Configuration ---
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")

# --- Scoring Weights ---
# These weights can be tuned to adjust the importance of each factor.
WEIGHTS = {
    "stars": 0.30,
    "stars_delta": 0.25,
    "signals_count": 0.15,
    "upvotes_delta": 0.20,
    "founder_reputation": 0.10,
}

class UnifiedScorer:
    """
    Calculates and updates a unified `bloodhound_score` for all Project nodes.
    """

    def __init__(self, uri: str, user: str, password: str):
        """
        Initializes the connection to Neo4j.
        """
        try:
            self.driver = GraphDatabase.driver(uri, auth=(user, password))
            self.driver.verify_connectivity()
            print("Successfully connected to Neo4j database.")
        except Exception as e:
            print(f"Error: Could not connect to Neo4j. Please check credentials and URI.")
            print(f"Details: {e}")
            raise

    def close(self):
        """Closes the Neo4j database connection."""
        if self.driver:
            self.driver.close()
            print("Neo4j connection closed.")

    def _normalize_scores(self, scores_dict):
        """
        Normalizes scores for each factor using a logarithmic scale to
        prevent extreme values from dominating the final score.
        """
        normalized = {}
        for factor, values in scores_dict.items():
            max_value = max(values) if values else 0
            # Use log1p for normalization to handle zeros and reduce skew
            # The +1 avoids log(0) and ensures the result is non-negative.
            # We add a small epsilon to the denominator to avoid division by zero.
            normalized[factor] = [math.log1p(v) / (math.log1p(max_value) + 1e-9) if max_value > 0 else 0 for v in values]
        return normalized


    def calculate_and_update_scores(self):
        """
        Fetches all projects, calculates their scores, and writes the
        `bloodhound_score` back to the database.
        """
        print("Starting unified scoring process...")
        with self.driver.session(database="neo4j") as session:
            # 1. Fetch all projects and their related data in one query
            # This is more efficient than multiple queries per project.
            query = """
            MATCH (p:Project)
            OPTIONAL MATCH (p)-[:HAS_SIGNAL]->(s:Signal)
            OPTIONAL MATCH (p)-[:FOUNDED_BY]->(f:Founder)
            RETURN
                p.project_id AS project_id,
                p.stars AS stars,
                p.stars_delta_1d AS stars_delta,
                count(s) AS signals_count,
                sum(s.upvote_delta_1d) AS upvotes_delta,
                f.reputation_score AS founder_reputation
            """
            print("Fetching project data from graph...")
            results = session.run(query)
            projects_data = [record.data() for record in results]

            if not projects_data:
                print("No projects found in the database. Aborting scoring.")
                return

            print(f"Found {len(projects_data)} projects to score.")

            # Prepare for normalization
            raw_scores = {
                "stars": [p.get('stars', 0) or 0 for p in projects_data],
                "stars_delta": [p.get('stars_delta', 0) or 0 for p in projects_data],
                "signals_count": [p.get('signals_count', 0) or 0 for p in projects_data],
                "upvotes_delta": [p.get('upvotes_delta', 0) or 0 for p in projects_data],
                "founder_reputation": [p.get('founder_reputation', 0) or 0 for p in projects_data]
            }

            # 2. Normalize all scores
            print("Normalizing raw scores...")
            norm_scores = self._normalize_scores(raw_scores)

            # 3. Calculate final weighted scores and prepare for update
            updates = []
            print("Calculating final Bloodhound scores...")
            for i, project in enumerate(projects_data):
                final_score = (
                    norm_scores['stars'][i] * WEIGHTS['stars'] +
                    norm_scores['stars_delta'][i] * WEIGHTS['stars_delta'] +
                    norm_scores['signals_count'][i] * WEIGHTS['signals_count'] +
                    norm_scores['upvotes_delta'][i] * WEIGHTS['upvotes_delta'] +
                    norm_scores['founder_reputation'][i] * WEIGHTS['founder_reputation']
                )
                updates.append({
                    'project_id': project['project_id'],
                    'bloodhound_score': round(final_score * 100, 2) # Scale to 0-100
                })
            
            # 4. Write scores back to the database in a batch
            print(f"Writing {len(updates)} scores back to the database...")
            # Using UNWIND is the most efficient way to perform batch updates in Neo4j
            update_query = """
            UNWIND $updates AS update
            MATCH (p:Project {project_id: update.project_id})
            SET p.bloodhound_score = update.bloodhound_score
            """
            session.run(update_query, updates=updates)
            print("Scoring process completed successfully.")


def main():
    """
    Main function to run the unified scorer processor.
    """
    scorer = None
    try:
        scorer = UnifiedScorer(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
        scorer.calculate_and_update_scores()
    except Exception as e:
        print(f"\nAn unexpected error occurred during the scoring process: {e}")
    finally:
        if scorer:
            scorer.close()


if __name__ == "__main__":
    # To run this script:
    # 1. Make sure you have the required packages:
    #    pip install neo4j
    # 2. Set your Neo4j environment variables.
    # 3. Run from your terminal:
    #    python processors/unified_scorer.py
    main()
