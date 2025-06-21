import sqlite3
import os
import re
from fuzzywuzzy import fuzz
from neo4j import GraphDatabase

# --- CONFIGURATION ---
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'leads.db')
SIMILARITY_THRESHOLD = 85 # We keep our standards high.

def get_potential_names(title):
    """
    A more sophisticated function to extract potential project names from a title.
    It looks for capitalized words, words in quotes, or words following trigger phrases.
    """
    # 1. Look for words in quotes (e.g., "My new app 'SuperTool'...")
    in_quotes = re.findall(r"['\"]([^'\"]+)['\"]", title)
    if in_quotes:
        return in_quotes

    # 2. Look for capitalized words (but not just "I" or "A")
    cap_words = re.findall(r'\b([A-Z][a-zA-Z0-9-]+)\b', title)
    # Filter out common single-letter words that are often capitalized
    cap_words = [word for word in cap_words if len(word) > 1]
    if cap_words:
        return cap_words

    # 3. Look for words following trigger phrases
    triggers = ["my new app", "my project", "i built", "check out"]
    title_lower = title.lower()
    for trigger in triggers:
        if trigger in title_lower:
            # Take the first few words after the trigger
            try:
                name = title_lower.split(trigger)[1].strip().split()[0]
                # Clean up punctuation
                name = re.sub(r'[^\w\s-]', '', name)
                return [name]
            except IndexError:
                continue

    return [] # Return empty list if no candidates found

def resolve_github_leads():
    # This function remains the same.
    con = sqlite3.connect(DB_PATH) # Using sqlite for this part as it's a simple dump
    # ... In a real graph-first system, this logic would change. We are simulating.
    # This is a placeholder for when we refactor this to Neo4j.
    # For now, we assume this works and don't re-run it.
    print("  - Skipping GitHub resolution, assuming projects exist.")
    pass


def resolve_reddit_leads():
    """Links Reddit leads to projects using advanced name extraction."""
    driver = GraphDatabase.driver(os.environ.get("NEO4J_URI"), auth=(os.environ.get("NEO4J_USERNAME"), os.environ.get("NEO4J_PASSWORD")))
    
    with driver.session() as session:
        # Get all projects from the graph
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        projects = {row["name"] for row in projects_result}

        # Get all unlinked Reddit signals
        signals_result = session.run("MATCH (s:Signal:Reddit) WHERE NOT (s)<-[:HAS_SIGNAL]-() RETURN s.title AS title, s.url AS url")
        unlinked_signals = list(signals_result)
        
        print(f"  - Linking {len(unlinked_signals)} Reddit leads with advanced logic...")
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
                print(f"    - MATCH FOUND: Linking '{signal['title'][:40]}...' to project '{best_match_project}' (Score: {best_match_score}%)")
                # Create the relationship in the graph
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
    # We are only focusing on resolving Reddit leads now.
    resolve_reddit_leads()
    print("    - Advanced resolution finished.")

if __name__ == '__main__':
    run_resolver()
