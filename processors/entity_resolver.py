import os
from neo4j import GraphDatabase
import time
import json
import requests

# --- CONFIGURATION ---
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

def execute_live_gemini_fetch(reddit_title, project_list_str):
    """
    Executes a REAL fetch call to the Gemini API with a retry mechanism for rate limiting.
    """
    if not GEMINI_API_KEY:
        print("    - FATAL: GEMINI_API_KEY not found in environment.")
        return None

    print(f"    - Querying Gemini API for: '{reddit_title[:40]}...'")
    
    prompt = f"""
Analyze the following Reddit post title and determine if it is about any of the projects in the provided list.
The project name might be slightly different or misspelled. Use semantic understanding.
Respond with a JSON object containing one key: "best_match".
If you find a confident match, the value should be the project name from the list.
If you find no confident match, the value should be the string "None".

---
Reddit Title: "{reddit_title}"
---
Project List: "{project_list_str}"
---

JSON Response:
"""

    api_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key={GEMINI_API_KEY}"
    payload = {"contents": [{"parts": [{"text": prompt}]}]}
    headers = {'Content-Type': 'application/json'}

    # Retry logic for handling rate limits
    for attempt in range(3): # Try up to 3 times
        try:
            response = requests.post(api_url, headers=headers, json=payload, timeout=45)
            
            # If we get a rate limit error, wait and retry
            if response.status_code == 429:
                print(f"      - WARN: Rate limit hit. Waiting 20 seconds... (Attempt {attempt + 1}/3)")
                time.sleep(20)
                continue # Go to the next attempt

            response.raise_for_status() # Raise an exception for other bad status codes
            
            result = response.json()
            if result.get("candidates") and result["candidates"][0].get("content", {}).get("parts"):
                raw_text = result["candidates"][0]["content"]["parts"][0]["text"]
                clean_text = raw_text.strip().replace("```json", "").replace("```", "").strip()
                return json.loads(clean_text)
            else:
                return {"best_match": "None"}
        
        except requests.exceptions.RequestException as e:
            print(f"    - ERROR: API request failed: {e}")
            return None
        except (json.JSONDecodeError, KeyError) as e:
            print(f"    - ERROR: Failed to parse AI response: {e}")
            return None

    print(f"    - FATAL: Failed to get response after multiple retries for '{reddit_title[:40]}...'")
    return None # Return None if all retries fail

def resolve_reddit_leads_with_ai():
    """Uses a live LLM to link Reddit leads to existing projects."""
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    with driver.session() as session:
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        project_names = [row["name"] for row in projects_result]
        signals_result = session.run("MATCH (s:Signal:Reddit) WHERE NOT (s)<-[:HAS_SIGNAL]-() RETURN s.title AS title, s.url AS url")
        unlinked_signals = list(signals_result)

        print(f"  - Linking {len(unlinked_signals)} Reddit leads with LIVE Gemini AI...")
        linked_count = 0
        project_list_str = ", ".join(project_names)
        
        for signal in unlinked_signals:
            ai_result = execute_live_gemini_fetch(signal["title"], project_list_str)
            if ai_result:
                best_match = ai_result.get("best_match")
                if best_match and best_match != "None" and best_match in project_names:
                    print(f"    - >>> AI MATCH FOUND: Linking '{signal['title'][:40]}...' to project '{best_match}'")
                    session.run("MATCH (p:Project {display_name: $p_name}), (s:Signal {url: $s_url}) MERGE (p)-[:HAS_SIGNAL]->(s)", 
                                p_name=best_match, s_url=signal["url"])
                    linked_count += 1
            # Increased delay between PRIMARY calls to be respectful of the API
            time.sleep(15)

    print(f"  - AI resolution complete. {linked_count} new links found.")
    driver.close()

def run_resolver():
    print("  - Running LIVE AI-Powered Entity Resolver...")
    resolve_reddit_leads_with_ai()
    print("    - LIVE AI resolution finished.")

if __name__ == '__main__':
    run_resolver()
