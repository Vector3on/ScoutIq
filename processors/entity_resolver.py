import sqlite3
import os
import re
from fuzzywuzzy import fuzz
from neo4j import GraphDatabase

# --- CONFIGURATION ---
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'leads.db')
# RECALIBRATION: Lowering threshold to accept weaker signals for now.
SIMILARITY_THRESHOLD = 60

def get_potential_names(title):
    """Extracts potential project names from a title."""
    in_quotes = re.findall(r"['\"]([^'\"]+)['\"]", title)
    if in_quotes:
        return in_quotes
    cap_words = [word for word in re.findall(r'\b([A-Z][a-zA-Z0-9-]+)\b', title) if len(word) > 1]
    if cap_words:
        return cap_words
    triggers = ["my new app", "my project", "i built", "check out"]
    for trigger in triggers:
        if trigger in title.lower():
            try:
                name = title.lower().split(trigger)[1].strip().split()[0]
                return [re.sub(r'[^\w\s-]', '', name)]
            except IndexError:
                continue
    return []

def resolve_reddit_leads():
    """Links Reddit leads to projects using a more forgiving threshold."""
    # This function uses Neo4j credentials from environment variables
    URI = os.environ.get("NEO4J_URI")
    USERNAME = os.environ.get("NEO4J_USERNAME")
    PASSWORD = os.environ.get("NEO4J_PASSWORD")
    if not URI:
        print("    - FATAL: Neo4j credentials not found.")
        return

    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    
    with driver.session() as session:
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        projects = {row["name"] for row in projects_result}
        signals_result = session.run("MATCH (s:Signal:Reddit) WHERE NOT (s)<-[:HAS_SIGNAL]-() RETURN s.title AS title, s.url AS url")
        unlinked_signals = list(signals_result)
        
        print(f"  - Linking {len(unlinked_signals)} Reddit leads with RECALIBRATED logic (Threshold: {SIMILARITY_THRESHOLD}%)...")
        linked_count = 0
        
        for signal in unlinked_signals:
            potential_names = get_potential_names(signal["title"])
            if not potential_names:
                continue

            best_match_score = 0
            best_match_project = None
            
            for name in potential_names:
                for project_name in projects:
                    score = fuzz.ratio(name.lower(), project_name.lower())
                    if score > best_match_score:
                        best_match_score = score
                        best_match_project = project_name
            
            if best_match_score >= SIMILARITY_THRESHOLD:
                print(f"    - >>> LINKED: '{signal['title'][:40]}...' to project '{best_match_project}' (Score: {best_match_score}%)")
                session.run("""
                    MATCH (p:Project {display_name: $project_name})
                    MATCH (s:Signal {url: $signal_url})
                    MERGE (p)-[:HAS_SIGNAL]->(s)
                """, project_name=best_match_project, signal_url=signal["url"])
                linked_count += 1

    driver.close()
    print(f"  - Reddit resolution complete. {linked_count} new links found.")

def run_resolver():
    print("  - Running Advanced Entity Resolver...")
    # For now, we only need to resolve Reddit leads as GitHub projects are created directly
    resolve_reddit_leads()
    print("    - Advanced resolution finished.")

if __name__ == '__main__':
    run_resolver()