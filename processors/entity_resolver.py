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
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")  # Our new backup key

def execute_openrouter_fetch(prompt):
    """
    Executes a fetch call to OpenRouter to run a free, open-source model
    as a backup or alternative to Gemini.
    """
    if not OPENROUTER_API_KEY:
        print("      - WARN: OPENROUTER_API_KEY not found. Cannot use backup AI.")
        return None

    print("      - Attempting fallback with OpenRouter AI...")
    try:
        response = requests.post(
            url="https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}"
            },
            data=json.dumps({
                "model": "mistralai/mistral-7b-instruct:free",  # Using a fast, free model
                "messages": [{"role": "user", "content": prompt}]
            })
        )
        response.raise_for_status()
        result = response.json()
        raw_text = result['choices'][0]['message']['content']
        # The response from OpenRouter is usually clean JSON already
        clean_text = raw_text.strip().replace("```json", "").replace("```", "").strip()
        return json.loads(clean_text)
    except Exception as e:
        print(f"      - ERROR: OpenRouter request failed: {e}")
        return None


def execute_live_gemini_fetch(prompt):
    """
    Executes the primary fetch call to Gemini, with OpenRouter as a fallback.
    """
    if not GEMINI_API_KEY:
        print("    - FATAL: GEMINI_API_KEY not found. Attempting fallback...")
        return execute_openrouter_fetch(prompt)

    print(f"    - Querying Primary AI (Gemini)...")

    api_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key={GEMINI_API_KEY}"
    payload = {"contents": [{"parts": [{"text": prompt}]}]}
    headers = {'Content-Type': 'application/json'}

    try:
        response = requests.post(api_url, headers=headers, json=payload, timeout=45)
        if response.status_code == 429:  # Rate limit
            print(f"      - WARN: Gemini rate limit hit. Switching to fallback.")
            return execute_openrouter_fetch(prompt)

        response.raise_for_status()
        result = response.json()
        if result.get("candidates") and result["candidates"][0].get("content", {}).get("parts"):
            raw_text = result["candidates"][0]["content"]["parts"][0]["text"]
            clean_text = raw_text.strip().replace("```json", "").replace("```", "").strip()
            return json.loads(clean_text)
        else:  # If Gemini gives a weird response, try the backup
            return execute_openrouter_fetch(prompt)

    except Exception as e:
        print(f"    - ERROR: Primary AI (Gemini) failed: {e}. Attempting fallback...")
        return execute_openrouter_fetch(prompt)


def resolve_reddit_leads_with_ai():
    """Uses a multi-model AI router to link Reddit leads to projects."""
    from neo4j import GraphDatabase  # Import here to avoid issues if neo4j isn't installed for some reason
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    with driver.session() as session:
        projects_result = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        project_names = [row["name"] for row in projects_result]
        signals_result = session.run("MATCH (s:Signal:Reddit) WHERE NOT (s)<-[:HAS_SIGNAL]-() RETURN s.title AS title, s.url AS url")
        unlinked_signals = list(signals_result)

        print(f"  - Linking {len(unlinked_signals)} Reddit leads with Multi-Model AI Router...")
        linked_count = 0
        project_list_str = ", ".join(project_names)

        for signal in unlinked_signals:
            prompt = f"""
Analyze the following Reddit post title and determine if it is about any of the projects in the provided list.
The project name might be slightly different or misspelled. Use semantic understanding.
Respond with a JSON object containing one key: "best_match".
If you find a confident match, the value should be the project name from the list.
If you find no confident match, the value should be the string "None".

---
Reddit Title: "{signal["title"]}"
---
Project List: "{project_list_str}"
---

JSON Response:
"""
            ai_result = execute_live_gemini_fetch(prompt)

            if ai_result:
                best_match = ai_result.get("best_match")
                if best_match and best_match != "None" and best_match in project_names:
                    print(f"    - >>> AI MATCH FOUND: Linking '{signal['title'][:40]}...' to project '{best_match}'")
                    session.run(
                        "MATCH (p:Project {display_name: $p_name}), (s:Signal {url: $s_url}) MERGE (p)-[:HAS_SIGNAL]->(s)",
                        p_name=best_match, s_url=signal["url"]
                    )
                    linked_count += 1
            time.sleep(10)

    print(f"  - AI resolution complete. {linked_count} new links found.")
    driver.close()


def run_resolver():
    print("  - Running Resilient, AI-Powered Entity Resolver...")
    resolve_reddit_leads_with_ai()
    print("    - Resilient AI resolution finished.")


if __name__ == '__main__':
    run_resolver()
