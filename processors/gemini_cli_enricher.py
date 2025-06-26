# processors/gemini_cli_enricher.py
#
# Project Bloodhound: Gemini CLI Intelligence Layer
#
# Objective:
# To use the official Gemini CLI tool to generate summaries for each project,
# integrating it as a robust command-line step in our pipeline.

import os
import sys
import subprocess
import json
from neo4j import GraphDatabase

# --- Configuration ---
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

class GeminiCliEnricher:
    """
    Uses the Gemini CLI via subprocess to enrich Project nodes.
    """

    def __init__(self, uri, user, password):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        print("  - Successfully connected to Neo4j.")

    def close(self):
        self.driver.close()

    def generate_summary(self, description: str) -> str:
        """
        Calls the Gemini CLI with a description and returns the summary.
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
            # Construct the command to call the Gemini CLI.
            # We pass the prompt as an argument. This is more secure than using shell=True.
            command = ["gemini", prompt]
            
            # Execute the command. `capture_output=True` and `text=True` are key.
            # `check=True` will automatically raise an exception if the command fails.
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=True,
                encoding='utf-8'
            )
            
            # The summary is in the stdout of the result.
            # We strip any extra whitespace or quotes.
            summary = result.stdout.strip().replace('"', '')
            return summary

        except FileNotFoundError:
            print("    - FATAL: The 'gemini' command was not found.")
            print("      Please ensure the Gemini CLI is installed and in the system's PATH.")
            # Exit the script if the CLI tool isn't installed.
            sys.exit(1)
        except subprocess.CalledProcessError as e:
            # This catches errors from the CLI tool itself (e.g., API errors)
            print(f"    - WARN: Gemini CLI returned an error.")
            print(f"      - Stderr: {e.stderr}")
            return "Summary generation failed due to CLI error."
        except Exception as e:
            print(f"    - WARN: An unexpected error occurred calling Gemini CLI: {e}")
            return "Summary generation failed."


    def enrich_projects(self):
        """
        Finds projects without a summary, generates one, and updates the database.
        """
        print("  - Starting Gemini CLI enrichment process...")
        with self.driver.session(database="neo4j") as session:
            query = """
            MATCH (p:Project)
            WHERE p.description IS NOT NULL AND p.gemini_summary IS NULL
            RETURN p.project_id AS project_id, p.description AS description
            LIMIT 25 // Limit to 25 per run to manage API usage
            """
            print("    - Finding projects that need enrichment...")
            results = session.run(query)
            projects_to_process = [record.data() for record in results]

            if not projects_to_process:
                print("    - No new projects to enrich. All summaries are up-to-date.")
                return

            print(f"    - Found {len(projects_to_process)} projects to enrich.")
            
            updates = []
            for project in projects_to_process:
                print(f"      - Generating summary for: {project['project_id']}")
                summary = self.generate_summary(project['description'])
                updates.append({
                    'project_id': project['project_id'],
                    'summary': summary
                })

            print(f"    - Writing {len(updates)} new summaries to the database...")
            update_query = """
            UNWIND $updates AS update
            MATCH (p:Project {project_id: update.project_id})
            SET p.gemini_summary = update.summary
            """
            session.run(update_query, updates=updates)
            print("  - Enrichment process completed successfully.")


def main():
    """ Main execution block """
    if not GEMINI_API_KEY:
        print("    - WARN: GEMINI_API_KEY not found. Skipping Gemini CLI enrichment.")
        sys.exit(0)

    enricher = None
    try:
        enricher = GeminiCliEnricher(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
        enricher.enrich_projects()
    except Exception as e:
        print(f"    - ERROR: An unexpected error occurred: {e}")
    finally:
        if enricher:
            enricher.close()

if __name__ == "__main__":
    main()
