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

# We are using Google's Gemma model via the Hugging Face free Inference API
MODEL_URL = "https://api-inference.huggingface.co/models/google/gemma-7b-it"

def execute_hf_fetch(prompt):
    """
    Executes a fetch call to the Hugging Face Inference API.
    """
    if not HF_TOKEN:
        print("    - FATAL: HUGGINGFACE_TOKEN not found in environment.")
        return None

    headers = {"Authorization": f"Bearer {HF_TOKEN}", "Content-Type": "application/json"}
    payload = {"inputs": prompt, "parameters": {"max_new_tokens": 50}}
    
    for attempt in range(3): # Retry logic
        try:
            print(f"    - Querying Hugging Face (gemma-7b-it)... Attempt {attempt + 1}")
            response = requests.post(MODEL_URL, headers=headers, json=payload, timeout=60)

            # The API might be loading the model, which takes time.
            if response.status_code == 503:
                wait_time = 20
                print(f"    - WARN: Model is loading (503). Waiting {wait_time} seconds...")
                time.sleep(wait_time)
                continue # Retry the request

            response.raise_for_status()
            result = response.json()
            
            # The response is a list containing a dict with the generated text
            generated_text = result[0]['generated_text']
            
            # The model's response includes our original prompt, so we must strip it
            json_response_str = generated_text.replace(prompt, "").strip()
            
            # Clean up potential markdown and find the JSON object
            clean_json_str = json_response_str[json_response_str.find('{'):json_response_str.rfind('}')+1]

            return json.loads(clean_json_str)

        except Exception as e:
            print(f"    - ERROR: Hugging Face API request failed: {e}")
            time.sleep(5) # Wait before retrying on other errors

    print("    - FATAL: All attempts to query Hugging Face failed.")
    return None

def resolve_reddit_leads_with_ai():
    """Uses Hugging Face Gemma to link Reddit leads to projects."""
    if not URI: print("    - FATAL: Neo4j credentials not found."); return
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))

    with driver.session() as session:
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        project_names = [row["name"] for row in projects_result]
        signals_result = session.run("MATCH (s:Signal:Reddit) WHERE NOT (s)<-[:HAS_SIGNAL]-() RETURN s.title AS title, s.url AS url")
        unlinked_signals = list(signals_result)

        print(f"  - Linking {len(unlinked_signals)} Reddit leads with Hugging Face AI...")
        linked_count = 0
        project_list_str = ", ".join(project_names)
        
        for signal in unlinked_signals:
            prompt = f'''
You are an expert entity resolver. Your task is to determine if a Reddit post is about a specific software project from the provided list. Respond ONLY with a valid JSON object with one key: "best_match". If you find a high-confidence match, the value for "best_match" must be the exact project name from the list. If you are not confident, the value MUST be the string "None".

**Reddit Title:**
"{signal["title"]}"

**List of known Project Names:**
{json.dumps(project_names)}

**JSON Response:**
'''
            ai_result = execute_hf_fetch(prompt)
            
            if isinstance(ai_result, dict):
                best_match = ai_result.get("best_match")
                if best_match and best_match != "None" and best_match in project_names:
                    print(f"    - >>> AI MATCH FOUND: Linking '{signal['title'][:40]}...' to project '{best_match}'")
                    session.run("MATCH (p:Project {display_name: $p_name}), (s:Signal {url: $s_url}) MERGE (p)-[:HAS_SIGNAL]->(s)",
                                p_name=best_match, s_url=signal["url"])
                    linked_count += 1
            time.sleep(2) # A short delay between calls

    print(f"  - AI resolution complete. {linked_count} new links found.")
    driver.close()

def run_resolver():
    """Main function to run the AI-powered entity resolution."""
    print("  - Running Hugging Face AI-Powered Entity Resolver...")
    resolve_reddit_leads_with_ai()
    print("    - Hugging Face AI resolution finished.")

if __name__ == '__main__':
    run_resolver()
