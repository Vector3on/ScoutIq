import os
from neo4j import GraphDatabase
import time

# --- CONFIGURATION ---
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")

def execute_gemini_match_fetch(reddit_title, project_list_str):
    """
    SIMULATES a call to the Gemini API to perform semantic matching.
    In a real environment, this would make a fetch call.
    """
    print(f"    - Asking Gemini: Does '{reddit_title[:40]}...' relate to any known projects?")
    time.sleep(2) # Simulate network latency
    
    # In a real implementation, we would parse the JSON from the Gemini response.
    # For this simulation, we'll assume it finds no match to prove the mechanism.
    # To test a positive match, you could manually change this to return a project name.
    # e.g., if 'ollama' is in project_list_str and "ollama" is in reddit_title, return '{"best_match": "ollama"}'
    
    mock_response_json = '{"best_match": "None"}'
    
    return mock_response_json

def resolve_reddit_leads_with_ai():
    """Uses an LLM to link Reddit leads to existing projects based on semantic understanding."""
    if not URI:
        print("    - FATAL: Neo4j credentials not found.")
        return

    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    
    with driver.session() as session:
        # Get all project names as a simple list
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        project_names = [row["name"] for row in projects_result]
        
        # Get all unlinked Reddit signals
        signals_result = session.run("MATCH (s:Signal:Reddit) WHERE NOT (s)<-[:HAS_SIGNAL]-() RETURN s.title AS title, s.url AS url")
        unlinked_signals = list(signals_result)

        if not unlinked_signals:
            print("  - No new Reddit leads to resolve.")
            return

        print(f"  - Linking {len(unlinked_signals)} Reddit leads with Gemini AI...")
        linked_count = 0
        
        # Create a single string of all project names for the prompt context
        project_list_str = ", ".join(project_names)
        
        for signal in unlinked_signals:
            title = signal["title"]
            url = signal["url"]
            
            # Ask the AI to find a match
            ai_response_str = execute_gemini_match_fetch(title, project_list_str)
            try:
                ai_response_json = json.loads(ai_response_str)
                best_match = ai_response_json.get("best_match")

                if best_match and best_match != "None" and best_match in project_names:
                    print(f"    - >>> AI MATCH FOUND: Linking '{title[:40]}...' to project '{best_match}'")
                    # Create the relationship in the graph
                    session.run("""
                        MATCH (p:Project {display_name: $project_name})
                        MATCH (s:Signal {url: $signal_url})
                        MERGE (p)-[:HAS_SIGNAL]->(s)
                    """, project_name=best_match, signal_url=url)
                    linked_count += 1
                else:
                    print(f"    - AI found no confident match for '{title[:40]}...'")

            except json.JSONDecodeError:
                print(f"    - FAILED: Could not decode AI response for '{title[:40]}...'")
                continue

    print(f"  - AI resolution complete. {linked_count} new links found.")
    driver.close()

def run_resolver():
    """Main function to run the AI-powered entity resolution."""
    print("  - Running AI-Powered Entity Resolver...")
    # This now only needs to run the AI resolver, as GitHub projects are created by their own scraper.
    resolve_reddit_leads_with_ai()
    print("    - AI resolution finished.")

if __name__ == '__main__':
    # We need to import json for the simulated response
    import json
    run_resolver()
