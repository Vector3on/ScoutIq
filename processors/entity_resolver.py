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

def make_api_request(url, headers, payload):
    """A hardened function to handle API requests and parsing, expecting JSON."""
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=60)
        
        if response.status_code == 429:
            print("      - WARN: Rate limit hit (429).")
            return "RATE_LIMIT"
            
        response.raise_for_status()
        response_json = response.json()

        # Extract the text content which should contain the JSON string
        if response_json.get("candidates"):
            raw_text = response_json["candidates"][0]["content"]["parts"][0]["text"]
        elif response_json.get('choices'):
            raw_text = response_json['choices'][0]['message']['content']
        else:
            print("    - WARN: AI response format was unexpected.")
            return None

        # Robustly parse the extracted text, which should be a JSON string
        try:
            # Clean up potential markdown formatting from the LLM
            clean_text = raw_text.strip().replace("```json", "").replace("```", "").strip()
            return json.loads(clean_text)
        except json.JSONDecodeError:
            print(f"    - ERROR: AI returned text that was not valid JSON: '{raw_text[:100]}...'")
            return None

    except requests.exceptions.RequestException as e:
        print(f"    - ERROR: API request failed: {e}")
        return None
    except Exception as e:
        print(f"    - ERROR: An unexpected error occurred in make_api_request: {e}")
        return None

def execute_gemini_fetch(prompt):
    """Executes a fetch call to the Gemini API."""
    if not GEMINI_API_KEY: return None
    print(f"    - Calling Provider: Gemini (1.5-flash)...")
    api_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key={GEMINI_API_KEY}"
    payload = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"responseMimeType": "application/json"}}
    headers = {'Content-Type': 'application/json'}
    return make_api_request(api_url, headers, payload)

def execute_openrouter_fetch(prompt):
    """Executes a fetch call to OpenRouter."""
    if not OPENROUTER_API_KEY: return None
    print("      - Calling Provider: OpenRouter (Mistral)...")
    api_url = "https://openrouter.ai/api/v1/chat/completions"
    payload = {
        "model": "mistralai/mistral-7b-instruct:free",
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {"type": "json_object"}
    }
    headers = {"Authorization": f"Bearer {OPENROUTER_API_KEY}"}
    return make_api_request(api_url, headers, payload)

def resolve_reddit_leads_with_ai():
    """Uses a load-balanced AI router to link Reddit leads to projects."""
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    with driver.session() as session:
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        project_names = [row["name"] for row in projects_result]
        signals_result = session.run("MATCH (s:Signal:Reddit) WHERE NOT (s)<-[:HAS_SIGNAL]-() RETURN s.title AS title, s.url AS url")
        unlinked_signals = list(signals_result)
        print(f"  - Linking {len(unlinked_signals)} Reddit leads with Hardened AI Load Balancer...")
        linked_count = 0
        
        for i, signal in enumerate(unlinked_signals):
            prompt = f'''You are an expert entity resolver. Respond ONLY with a valid JSON object with one key: "best_match". If you find a high-confidence match between the Reddit Title and a name from the Project List, the value for "best_match" must be the exact project name. Otherwise, the value MUST be the string "None".
**Reddit Title:** "{signal["title"]}"
**Project List:** {json.dumps(project_names)}
**JSON Response:**'''

            ai_result = execute_gemini_fetch(prompt) if i % 2 == 0 else execute_openrouter_fetch(prompt)

            if ai_result == "RATE_LIMIT":
                print("      - Pausing for 30 seconds due to rate limit...")
                time.sleep(30)
                continue

            # This is the new, hardened check. We only proceed if we have a dictionary.
            if isinstance(ai_result, dict):
                best_match = ai_result.get("best_match")
                if best_match and best_match != "None" and best_match in project_names:
                    print(f"    - >>> AI MATCH FOUND: Linking '{signal['title'][:40]}...' to project '{best_match}'")
                    session.run("MATCH (p:Project {display_name: $p_name}), (s:Signal {url: $s_url}) MERGE (p)-[:HAS_SIGNAL]->(s)",
                                p_name=best_match, s_url=signal["url"])
                    linked_count += 1
            else:
                print(f"    - WARN: Received a non-dictionary response from AI. Skipping. Response: {ai_result}")
            
            time.sleep(5)

    print(f"  - AI resolution complete. {linked_count} new links found.")
    driver.close()

def run_resolver():
    print("  - Running Hardened AI-Powered Entity Resolver...")
    resolve_reddit_leads_with_ai()
    print("    - Hardened AI resolution finished.")

if __name__ == '__main__':
    run_resolver()
