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

def execute_live_gemini_fetch(prompt):
    """Executes a REAL fetch call to the Gemini API."""
    if not GEMINI_API_KEY:
        print("    - FATAL: GEMINI_API_KEY not found in environment.")
        return None

    api_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key={GEMINI_API_KEY}"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json"}
    }
    headers = {'Content-Type': 'application/json'}

    try:
        response = requests.post(api_url, headers=headers, json=payload, timeout=60)
        response.raise_for_status()
        result = response.json()
        if result.get("candidates") and result["candidates"][0].get("content", {}).get("parts"):
            response_text = result["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(response_text)
        else:
            print("    - WARN: AI response was valid but empty.")
            return {"best_match": "None"}
    except requests.exceptions.RequestException as e:
        print(f"    - ERROR: API request failed: {e}")
        return None
    except json.JSONDecodeError as e:
        print(f"    - ERROR: Failed to parse AI JSON response: {e}")
        return None

def resolve_reddit_leads_with_ai():
    """Uses a live LLM to link Reddit leads to existing projects with a better prompt."""
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    with driver.session() as session:
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        project_names = [row["name"] for row in projects_result]
        signals_result = session.run("MATCH (s:Signal:Reddit) WHERE NOT (s)<-[:HAS_SIGNAL]-() RETURN s.title AS title, s.url AS url")
        unlinked_signals = list(signals_result)

        print(f"  - Linking {len(unlinked_signals)} Reddit leads with DEFINITIVE Gemini AI...")
        linked_count = 0
        
        for signal in unlinked_signals:
            # This is the new, more effective prompt structure.
            prompt = f"""
You are an expert entity resolver. Your task is to determine if a Reddit post is about a specific software project.
Read the Reddit Title carefully. Compare it semantically to the list of known Project Names.
Your response MUST be a single JSON object with one key: "best_match".
If you find a high-confidence match, the value for "best_match" must be the exact project name from the list.
If you are not highly confident, the value for "best_match" MUST be the string "None".

**Reddit Title:**
"{signal["title"]}"

**List of known Project Names:**
{json.dumps(project_names)}

**JSON Response:**
"""
            print(f"    - Querying Gemini for: '{signal['title'][:50]}...'")
            ai_result = execute_live_gemini_fetch(prompt)
            
            if ai_result:
                best_match = ai_result.get("best_match")
                if best_match and best_match != "None" and best_match in project_names:
                    print(f"    - >>> AI MATCH FOUND: Linking to project '{best_match}'")
                    session.run("MATCH (p:Project {display_name: $p_name}), (s:Signal {url: $s_url}) MERGE (p)-[:HAS_SIGNAL]->(s)",
                                p_name=best_match, s_url=signal["url"])
                    linked_count += 1
            # We are rate limiting to be respectful of the API
            time.sleep(5)

    print(f"  - AI resolution complete. {linked_count} new links found.")
    driver.close()

def run_resolver():
    """Main function to run the AI-powered entity resolution."""
    print("  - Running DEFINITIVE AI-Powered Entity Resolver...")
    resolve_reddit_leads_with_ai()
    print("    - DEFINITIVE AI resolution finished.")

if __name__ == '__main__':
    run_resolver()
