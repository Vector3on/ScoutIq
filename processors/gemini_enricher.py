# processors/gemini_enricher.py
#
# This script uses the official Google Generative AI Python SDK.
# It is designed to be run from your local machine or any automated environment.

import os
import sys
import google.generativeai as genai
from neo4j import GraphDatabase

# --- Configuration from Environment Variables ---
NEO4J_URI = os.environ.get("NEO4J_URI")
NEO4J_USER = os.environ.get("NEO4J_USERNAME")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

class GeminiEnricher:
    """
    Uses the Gemini API via the Python SDK to enrich Project nodes.
    """
    def __init__(self, uri, user, password):
        # Check for Neo4j credentials
        if not all([uri, user, password]):
            raise ValueError("Neo4j credentials (URI, USERNAME, PASSWORD) are not set.")
        
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        print("Successfully connected to Neo4j.")
        
        # Configure the Gemini client using the API key
        genai.configure(api_key=GEMINI_API_KEY)
        self.model = genai.GenerativeModel('gemini-1.5-flash')
        print("Successfully configured Gemini Pro SDK.")

    def close(self):
        self.driver.close()

    def generate_summary(self, description: str) -> str:
        """
        Sends a description to the Gemini API and returns the summary.
        """
        if not description or not description.strip():
            return "No description available to summarize."

        prompt = f"""
        As an expert technology investment analyst, summarize the following project description
        in one compelling sentence. Focus on the core value proposition and target user.
        
        Description: "{description}"
        
        Summary:
        """
        try:
            response = self.model.generate_content(prompt)
            return response.text.strip().replace('"', '')
        except Exception as e:
            print(f"  - WARN: Could not generate summary via SDK. Error: {e}")
            return "Summary generation failed."

    def enrich_projects(self):
        """
        Finds projects without a summary, generates one, and updates the database.
        """
        print("\nStarting Gemini enrichment process via Python SDK...")
        with self.driver.session(database="neo4j") as session:
            query = """
            MATCH (p:Project)
            WHERE p.description IS NOT NULL AND p.gemini_summary IS NULL
            RETURN p.project_id AS project_id, p.description AS description
            LIMIT 10
            """
            print("  - Finding projects that need enrichment...")
            results = session.run(query)
            projects_to_process = [record.data() for record in results]

            if not projects_to_process:
                print("  - No new projects to enrich. All summaries are up-to-date.")
                return

            print(f"  - Found {len(projects_to_process)} projects to enrich.")
            
            updates = []
            for project in projects_to_process:
                print(f"    - Generating summary for: {project['project_id']}")
                summary = self.generate_summary(project['description'])
                updates.append({
                    'project_id': project['project_id'],
                    'summary': summary
                })

            print(f"  - Writing {len(updates)} new summaries to the database...")
            update_query = """
            UNWIND $updates AS update
            MATCH (p:Project {project_id: update.project_id})
            SET p.gemini_summary = update.summary
            """
            session.run(update_query, updates=updates)
            print("Enrichment process completed successfully.")


def main():
    """ Main execution block """
    if not GEMINI_API_KEY:
        print("ERROR: GEMINI_API_KEY is not set in your environment variables.")
        sys.exit(1)

    enricher = None
    try:
        enricher = GeminiEnricher(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
        enricher.enrich_projects()
    except ValueError as ve:
        print(f"ERROR: Configuration error - {ve}")
    except Exception as e:
        print(f"ERROR: An unexpected error occurred: {e}")
    finally:
        if enricher:
            enricher.close()

if __name__ == "__main__":
    main()

