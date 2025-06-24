import os
import time
import json
import requests
from neo4j import GraphDatabase

# --- CONFIGURATION ---
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")

def execute_gemini_fetch(prompt):
    """Executes a fetch call to the Gemini API."""
    if not GEMINI_API_KEY:
        print("    - Gemini SKIPPED: API Key not found.")
        return None
    print(f"    - Calling Provider: Gemini (1.5-flash)...")
    api_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key={GEMINI_API_KEY}"
    payload = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"responseMimeType": "application/json"}}
    headers = {'Content-Type': 'application/json'}
    try:
        response = requests.post(api_url, headers=headers, json=payload, timeout=60)
        response.raise_for_status()
        result = response.json()
        if result.get("candidates"):
            return json.loads(result["candidates"][0]["content"]["parts"][0]["text"])
        return {"best_match": "None"}
    except Exception as e:
        print(f"    - ERROR: Gemini request failed: {e}")
        return None

def execute_openrouter_fetch(prompt, model_name="mistralai/mistral-7b-instruct:free"):
    """Executes a fetch call to OpenRouter, using a specified model."""
    if not OPENROUTER_API_KEY:
        print(f"    - OpenRouter SKIPPED: API Key not found.")
        return None
    print(f"    - Calling Provider: OpenRouter ({model_name})...")
    try:
        response = requests.post(
            url="https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}"},
            data=json.dumps({"model": model_name, "messages": [{"role": "user", "content": prompt}]})
        )
        response.raise_for_status()
        result = response.json()
        return json.loads(result['choices'][0]['message']['content'])
    except Exception as e:
        print(f"    - ERROR: OpenRouter request failed for model {model_name}: {e}")
        return None

def resolve_reddit_leads_with_ai():
    """Uses a load-balanced AI router to link Reddit leads to projects."""
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    
    # --- AI PROVIDER POOL ---
    # This is our load balancer. We will cycle through this list.
    # We add function wrappers to pass the model name to the OpenRouter fetcher.
    ai_providers = [
        {"name": "Gemini", "fetch": execute_gemini_fetch},
        {"name": "OpenRouter (Mistral)", "fetch": lambda p: execute_openrouter_fetch(p, "mistralai/mistral-7b-instruct:free")},
        {"name": "OpenRouter (Llama)", "fetch": lambda p: execute_openrouter_fetch(p, "meta-llama/llama-3-8b-instruct:free")}
    ]
    
    with driver.session() as session:
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        project_names = [row["name"] for row in projects_result]
        signals_result = session.run("MATCH (s:Signal:Reddit) WHERE NOT (s)<-[:HAS_SIGNAL]-() RETURN s.title AS title, s.url AS url")
        unlinked_signals = list(signals_result)

        print(f"  - Linking {len(unlinked_signals)} Reddit leads with AI Load Balancer...")
        linked_count = 0
        project_list_str = ", ".join(project_names)
        
        for i, signal in enumerate(unlinked_signals):
            # --- Round-Robin Load Balancer Logic ---
            provider = ai_providers[i % len(ai_providers)]
            
            prompt = f'''You are an expert entity resolver... [Respond with JSON: "best_match": "ProjectName" or "None"]
**Reddit Title:** "{signal["title"]}"
**List of known Project Names:** {json.dumps(project_names)}
**JSON Response:**'''

            ai_result = provider["fetch"](prompt)
            
            if ai_result:
                best_match = ai_result.get("best_match")
                if best_match and best_match != "None" and best_match in project_names:
                    print(f"    - >>> AI MATCH FOUND via {provider['name']}: Linking '{signal['title'][:40]}...' to '{best_match}'")
                    session.run("MATCH (p:Project {display_name: $p_name}), (s:Signal {url: $s_url}) MERGE (p)-[:HAS_SIGNAL]->(s)",
                                p_name=best_match, s_url=signal["url"])
                    linked_count += 1
            time.sleep(3) # A small delay to be respectful

    print(f"  - AI resolution complete. {linked_count} new links found.")
    driver.close()

def run_resolver():
    print("  - Running AI Load Balancer / Entity Resolver...")
    resolve_reddit_leads_with_ai()
    print("    - AI Load Balancer finished.")

if __name__ == '__main__':
    run_resolver()
