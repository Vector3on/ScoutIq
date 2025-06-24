import os
import time
import json
import requests
from neo4j import GraphDatabase

# --- CONFIGURATION ---
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")
HF_TOKEN = os.environ.get("HUGGINGFACE_TOKEN")  # Get from https://huggingface.co/settings/tokens

def execute_hf_fetch(prompt, model_id):
    """Executes a request to Hugging Face Inference API."""
    if not HF_TOKEN:
        print("    - Hugging Face SKIPPED: Token not found.")
        return None
    api_url = f"https://api-inference.huggingface.co/models/{model_id}"
    headers = {"Authorization": f"Bearer {HF_TOKEN}"}
    payload = {"inputs": prompt}
    try:
        response = requests.post(api_url, headers=headers, json=payload, timeout=60)
        response.raise_for_status()
        result = response.json()
        return result
    except Exception as e:
        print(f"    - ERROR: Hugging Face API request failed for {model_id}: {e}")
        return None

def resolve_reddit_leads_with_ai():
    """Resolves Reddit leads using Hugging Face Free Model (distilbert)."""
    if not URI:
        print("    - FATAL: Neo4j credentials not found.")
        return
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))

    ai_providers = [
        {"name": "HF (distilbert)", "fetch": lambda p: execute_hf_fetch(p, "distilbert-base-uncased")},
    ]

    with driver.session() as session:
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        project_names = [row["name"] for row in projects_result]

        signals_result = session.run("""
            MATCH (s:Signal:Reddit) 
            WHERE NOT (s)<-[:HAS_SIGNAL]-() 
            RETURN s.title AS title, s.url AS url
        """)
        unlinked_signals = list(signals_result)

        print(f"  - TOTAL Reddit leads to link: {len(unlinked_signals)}")
        linked_count = 0

        for signal in unlinked_signals:
            prompt = (
                "You are an expert entity matcher. "
                "Check if this Reddit title closely matches any project name in the given list. "
                "Return JSON object with a key 'best_match' being the exact project name if matched, otherwise 'None'.\n"
                f"Title: {signal['title']}\nProjects: {json.dumps(project_names)}"
            )
            for provider in ai_providers:
                print(f"    - Calling Provider: Hugging Face ({provider['name']})...")
                ai_result = provider["fetch"](prompt)

                if isinstance(ai_result, list) and 'generated_text' in ai_result[0]:
                    text = ai_result[0]['generated_text'].strip()
                    try:
                        best_match_data = json.loads(text[text.find('{'):])
                        best_match = best_match_data.get("best_match")
                        if best_match and best_match != "None" and best_match in project_names:
                            print(f"    - >>> MATCH FOUND via {provider['name']}: '{signal['title'][:40]}...' => '{best_match}'")
                            session.run("""
                                MATCH (p:Project {display_name: $p_name}), (s:Signal {url: $s_url})
                                MERGE (p)-[:HAS_SIGNAL]->(s)
                            """, p_name=best_match, s_url=signal["url"])
                            linked_count += 1
                        break
                    except (ValueError, KeyError) as e:
                        print(f"    - WARN: Could not parse JSON result: {e}")

            time.sleep(1)

    print(f"  - AI Resolution Complete. {linked_count}/{len(unlinked_signals)} links created.")
    driver.close()

def run_resolver():
    """Main entry point."""
    print("\n=== Starting Hugging Face FREE Model Resolution ===")
    resolve_reddit_leads_with_ai()
    print("=== Done ===\n")

if __name__ == '__main__':
    run_resolver()
