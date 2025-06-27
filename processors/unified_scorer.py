# processors/unified_scorer.py
#
# Upgraded to a "Signal Fusion Engine" as per the strategic analysis.
# This version is hardened to be more resilient to inconsistent data.

import os
import math
from neo4j import GraphDatabase

# --- Configuration ---
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")

SIGNAL_SOURCE_WEIGHTS = {
    "Reddit": 1.0,
    "Hacker News": 2.5,
}

COMPONENT_WEIGHTS = {
    "stars": 0.30,
    "stars_delta": 0.25,
    "fused_signal_score": 0.45,
}

class UnifiedScorer:
    """
    Calculates and updates a unified `bloodhound_score` for all Project nodes
    using a signal fusion methodology.
    """

    def __init__(self, uri: str, user: str, password: str):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        print("  - Signal Fusion Engine Initialized.")

    def close(self):
        self.driver.close()

    def _normalize_scores(self, projects_data, key):
        """ Normalizes a specific metric across all projects. """
        values = [p.get(key, 0) or 0 for p in projects_data]
        max_value = max(values) if values else 0
        if max_value == 0:
            return [0] * len(values)
        return [math.log1p(v) / math.log1p(max_value) for v in values]

    def calculate_and_update_scores(self):
        """
        Fetches all projects and their signals, calculates a fused score,
        and writes the `bloodhound_score` back to the database.
        """
        print("  - Beginning Signal Fusion process...")
        with self.driver.session(database="neo4j") as session:
            query = """
            MATCH (p:Project)
            WHERE p.project_id IS NOT NULL
            OPTIONAL MATCH (p)-[:HAS_SIGNAL]->(s)
            RETURN
                p.project_id AS project_id,
                p.stars AS stars,
                p.stars_delta_1d AS stars_delta,
                collect({source: s.source, upvotes: s.upvotes}) AS signals
            """
            print("    - Fetching project and signal data from graph...")
            results = session.run(query)
            projects_data = [record.data() for record in results]

            if not projects_data:
                print("    - No projects with a project_id found. Aborting scoring.")
                return

            print(f"    - Found {len(projects_data)} projects to score.")

            for project in projects_data:
                fused_score = 0
                if project['signals']:
                    for signal in project['signals']:
                        if signal and signal.get('source'):
                            weight = SIGNAL_SOURCE_WEIGHTS.get(signal['source'], 0.5)
                            upvotes = signal.get('upvotes', 0) or 0
                            fused_score += (upvotes * weight)
                project['fused_signal_score'] = fused_score
            
            norm_stars = self._normalize_scores(projects_data, 'stars')
            norm_stars_delta = self._normalize_scores(projects_data, 'stars_delta')
            norm_fused_signals = self._normalize_scores(projects_data, 'fused_signal_score')

            updates = []
            print("    - Calculating final Bloodhound scores...")
            for i, project in enumerate(projects_data):
                final_score = (
                    norm_stars[i] * COMPONENT_WEIGHTS['stars'] +
                    norm_stars_delta[i] * COMPONENT_WEIGHTS['stars_delta'] +
                    norm_fused_signals[i] * COMPONENT_WEIGHTS['fused_signal_score']
                )
                updates.append({
                    'project_id': project['project_id'],
                    'bloodhound_score': round(final_score * 100, 2)
                })
            
            print(f"    - Writing {len(updates)} scores back to the database...")
            update_query = """
            UNWIND $updates AS update
            MATCH (p:Project {project_id: update.project_id})
            SET p.bloodhound_score = update.bloodhound_score
            """
            session.run(update_query, updates=updates)
            print("  - Signal Fusion process completed successfully.")

def main():
    scorer = None
    try:
        scorer = UnifiedScorer(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
        scorer.calculate_and_update_scores()
    except Exception as e:
        print(f"    - ERROR: An unexpected error occurred during scoring: {e}")
    finally:
        if scorer:
            scorer.close()

if __name__ == "__main__":
    main()
