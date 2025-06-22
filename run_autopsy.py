import os
import re
from neo4j import GraphDatabase
from fuzzywuzzy import fuzz

# --- CONFIGURATION ---
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")

def get_potential_names(title):
    """(Copied from resolver) Extracts potential project names from a title."""
    in_quotes = re.findall(r"['\"]([^'\"]+)['\"]", title)
    if in_quotes: return in_quotes
    cap_words = [word for word in re.findall(r'\b([A-Z][a-zA-Z0-9-]+)\b', title) if len(word) > 1]
    if cap_words: return cap_words
    triggers = ["my new app", "my project", "i built", "check out"]
    for trigger in triggers:
        if trigger in title.lower():
            try:
                name = title.lower().split(trigger)[1].strip().split()[0]
                return [re.sub(r'[^\w\s-]', '', name)]
            except IndexError: continue
    return []

def run_autopsy():
    """Runs a full diagnostic on the matching logic and prints a detailed report."""
    print("="*60)
    print("BLOODHOUND LOGIC AUTOPSY: INITIATED")
    print("="*60)
    if not URI:
        print("FATAL: Neo4j credentials not found. Cannot run autopsy.")
        return

    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    
    with driver.session() as session:
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        projects = {row["name"] for row in projects_result}
        signals_result = session.run("MATCH (s:Signal:Reddit) RETURN s.title AS title")
        signals = list(signals_result)

        if not projects or not signals:
            print("No projects or signals found to analyze.")
            driver.close()
            return
            
        print(f"Analyzing {len(signals)} Reddit signals against {len(projects)} projects...\n")

        for signal in signals:
            title = signal["title"]
            potential_names = get_potential_names(title)
            
            print(f"--- AUTOPSY FOR REDDIT POST: '{title}'")
            if not potential_names:
                print("  - RESULT: Failed to extract any potential project names. LOGIC FAILED.\n")
                continue
            
            print(f"  - Extracted Candidate Names: {potential_names}")
            
            for name in potential_names:
                best_match_project = None
                best_match_score = 0
                for project_name in projects:
                    score = fuzz.ratio(name.lower(), project_name.lower())
                    if score > best_match_score:
                        best_match_score = score
                        best_match_project = project_name
                
                print(f"    - Candidate '{name}' -> Best Match: '{best_match_project}' (Score: {best_match_score}%)")
    
    driver.close()
    print("\n" + "="*60)
    print("AUTOPSY COMPLETE.")

if __name__ == '__main__':
    run_autopsy()
