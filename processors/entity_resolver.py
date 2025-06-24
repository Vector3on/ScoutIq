import os
import time
import json
import requests
from neo4j import GraphDatabase

# --- CONFIGURATION ---
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")
HF_TOKEN = os.environ.get("HUGGINGFACE_TOKEN")

def execute_hf_fetch(prompt, model_id):
    """Executes a hardened fetch call to the Hugging Face Inference API."""
    if not HF_TOKEN:
        print(f"    - Hugging Face SKIPPED: Token not found.")
        return None
    
    api_url = f"https://api-inference.huggingface.co/models/{model_id}"
    headers = {"Authorization": f"Bearer {HF_TOKEN}", "Content-Type": "application/json"}
    payload = {"inputs": prompt, "parameters": {"max_new_tokens": 50, "return_full_text": False}}
    
    print(f"    - Calling Provider: Hugging Face ({model_id})...")
    for attempt in range(2):
        try:
            response = requests.post(api_url, headers=headers, json=payload, timeout=90)
            if response.status_code == 503:
                wait_time = response.json().get('estimated_time', 20)
                print(f"    - WARN: Model '{model_id}' is loading (503). Waiting {wait_time:.0f} seconds...")
                time.sleep(wait_time)
                continue
            response.raise_for_status()
            result = response.json()
            generated_text = result[0]['generated_text']
            json_start_index = generated_text.find('{')
            if json_start_index != -1:
                json_response_str = generated_text[json_start_index:]
                return json.loads(json_response_str)
            else:
                 print(f"    - ERROR: No JSON object found in response from {model_id}.")
                 return None
        except Exception as e:
            print(f"    - ERROR: Hugging Face API request failed for {model_id}: {e}")
            return None

    print(f"    - FATAL: All attempts to query {model_id} failed.")
    return None

def resolve_reddit_leads_with_ai():
    """Uses a load-balanced pool of Hugging Face models to link Reddit leads."""
    if not URI: print("    - FATAL: Neo4j credentials not found."); return
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    
    # --- AI PROVIDER POOL (Based on your research) ---
    ai_providers = [
        {"name": "HF (Gemma 7B)", "fetch": lambda p: execute_hf_fetch(p, "google/gemma-7b-it")},
        {"name": "HF (Mistral 7B)", "fetch": lambda p: execute_hf_fetch(p, "mistralai/Mistral-7B-Instruct-v0.2")},
        {"name": "HF (Llama 3 8B)", "fetch": lambda p: execute_hf_fetch(p, "meta-llama/Meta-Llama-3-8B-Instruct")},
    ]
    
    with driver.session() as session:
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        project_names = [row["name"] for row in projects_result]
        signals_result = session.run("MATCH (s:Signal:Reddit) WHERE NOT (s)<-[:HAS_SIGNAL]-() RETURN s.title AS title, s.url AS url")
        unlinked_signals = list(signals_result)

        print(f"  - Linking {len(unlinked_signals)} Reddit leads with Hugging Face AI Load Balancer...")
        linked_count = 0
        
        for i, signal in enumerate(unlinked_signals):
            provider = ai_providers[i % len(ai_providers)]
            prompt = f'''You are an expert entity resolver. Respond ONLY with a valid JSON object with one key: "best_match". If you find a high-confidence match between the Reddit Title and a name from the Project List, the value must be the exact project name. Otherwise, the value MUST be the string "None".
**Reddit Title:** "{signal["title"]}"
**Project List:** {json.dumps(project_names)}
**JSON Response:**'''

            ai_result = provider["fetch"](prompt)
            
            if isinstance(ai_result, dict):
                best_match = ai_result.get("best_match")
                if best_match and best_match != "None" and best_match in project_names:
                    print(f"    - >>> AI MATCH FOUND via {provider['name']}: Linking '{signal['title'][:40]}...' to '{best_match}'")
                    session.run("MATCH (p:Project {display_name: $p_name}), (s:Signal {url: $s_url}) MERGE (p)-[:HAS_SIGNAL]->(s)",
                                p_name=best_match, s_url=signal["url"])
                    linked_count += 1
            time.sleep(3)

    print(f"  - AI resolution complete. {linked_count} new links found.")
    driver.close()

def run_resolver():
    """Main function to run the AI-powered entity resolution."""
    print("  - Running Hugging Face AI Load Balancer...")
    resolve_reddit_leads_with_ai()
    print("    - Hugging Face AI Load Balancer finished.")

if __name__ == '__main__':
    run_resolver()
