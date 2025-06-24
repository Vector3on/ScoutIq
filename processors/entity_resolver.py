import os
import time
import json
import requests
from neo4j import GraphDatabase

# CONFIG
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")
HF_TOKEN = os.environ.get("HUGGINGFACE_TOKEN")

def execute_hf_fetch(prompt, model_id):
    if not HF_TOKEN:
        print("    - Hugging Face SKIPPED: Token not found.")
        return None
    api_url = f"https://api-inference.huggingface.co/models/{model_id}"
    headers = {"Authorization": f"Bearer {HF_TOKEN}", "Content-Type": "application/json"}
    payload = {"inputs": prompt, "parameters": {"max_new_tokens": 50, "return_full_text": False}}
    print(f"    - Calling Provider: Hugging Face ({model_id})")
    try:
        response = requests.post(api_url, headers=headers, json=payload, timeout=90)
        response.raise_for_status()
        result = response.json()
        generated_text = result[0]['generated_text']
        json_start_index = generated_text.find('{')
        if json_start_index != -1:
            return json.loads(generated_text[json_start_index:])
    except Exception as e:
        print(f"    - ERROR: Hugging Face request failed for {model_id}: {e}")
    return None

def resolve_reddit_leads_with_ai():
    if not URI:
        print("    - FATAL: Neo4j credentials not found.")
        return
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    with driver.session() as session:
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        project_names = [row["name"] for row in projects_result]
        signals_result = session.run("MATCH (s:Signal:Reddit) WHERE NOT (s)<-[:HAS_SIGNAL]-() RETURN s.title AS title, s.url AS url")
        unlinked_signals = list(signals_result)
        print(f"  - DEBUG: Loaded {len(project_names)} project names from Neo4j.")
        for name in project_names[:5]:
            print(f"    -> Project example: {name}")
        print(f"  - TOTAL Reddit leads to link: {len(unlinked_signals)}")
        linked_count = 0
        ai_providers = [
            {"name": "HF (Gemma 7B)", "fetch": lambda p: execute_hf_fetch(p, "google/gemma-7b")},
            {"name": "HF (Mistral 7B)", "fetch": lambda p: execute_hf_fetch(p, "mistralai/Mistral-7B")},
            {"name": "HF (Llama 3 8B)", "fetch": lambda p: execute_hf_fetch(p, "meta-llama/Meta-Llama-3-8B")},
        ]
        for i, signal in enumerate(unlinked_signals):
            provider = ai_providers[i % len(ai_providers)]
            prompt = f"You are an expert entity matcher. JSON only. If there's a match for '{signal['title']}' in {project_names}, respond with '{{\"best_match\": \"<Project Name>\"}}' or '{{\"best_match\": \"None\"}}'."
            ai_result = provider["fetch"](prompt)
            if isinstance(ai_result, dict):
                best_match = ai_result.get("best_match")
                print(f"    - DEBUG: Provider {provider['name']} returned best_match = {best_match}")
                if best_match and best_match != "None" and best_match in project_names:
                    print(f"    - ✅ MATCH FOUND [{provider['name']}]: '{signal['title'][:40]}' -> '{best_match}'")
                    session.run("""
                        MATCH (p:Project {display_name: $p_name}), (s:Signal {url: $s_url})
                        MERGE (p)-[:HAS_SIGNAL]->(s)""",
                        p_name=best_match, s_url=signal["url"])
                    linked_count += 1
                else:
                    print(f"    - ❌ No match for '{signal['title']}'")
            time.sleep(2)
    print(f"  - AI Resolution Complete. {linked_count}/{len(unlinked_signals)} links created.")
    driver.close()

if __name__ == '__main__':
    print("=== Starting BULLETPROOF Reddit Lead Resolution ===")
    resolve_reddit_leads_with_ai()
    print("=== Done ===")
