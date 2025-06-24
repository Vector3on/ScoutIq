import os
import time
import json
import requests
from neo4j import GraphDatabase

# =========================
# CONFIG
# =========================
BATCH_SIZE = 20           # Process this many signals per batch
SLEEP_BETWEEN_BATCHES = 5 # Seconds
MAX_RETRIES = 3
RETRY_DELAY = 5

# =========================
# ENVIRONMENT VARIABLES
# =========================
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")
HF_TOKEN = os.environ.get("HUGGINGFACE_TOKEN")      # Hugging Face
TOGETHER_KEY = os.environ.get("TOGETHER_API_KEY")  # Together AI
GROQ_KEY = os.environ.get("GROQ_API_KEY")           # Groq

# =========================
# AI Provider Functions
# =========================
def call_huggingface(prompt, model_id):
    """Call Hugging Face Inference API."""
    if not HF_TOKEN:
        return None
    url = f"https://api-inference.huggingface.co/models/{model_id}"
    headers = {"Authorization": f"Bearer {HF_TOKEN}"}
    payload = {"inputs": prompt, "parameters": {"max_new_tokens": 100, "return_full_text": False}}

    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=60)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            result = resp.json()
            text = result[0]["generated_text"]
            json_start = text.find("{")
            if json_start != -1:
                return json.loads(text[json_start:])
        except Exception as e:
            print(f"    - Hugging Face error [{model_id}], attempt {attempt + 1}: {e}")
            time.sleep(RETRY_DELAY)

    return None


def call_together(prompt, model_name):
    """Call Together AI Chat Completion."""
    if not TOGETHER_KEY:
        return None
    url = "https://api.together.xyz/v1/chat/completions"
    headers = {"Authorization": f"Bearer {TOGETHER_KEY}"}
    payload = {
        "model": model_name,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 100,
        "temperature": 0.2
    }
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=60)
            resp.raise_for_status()
            result = resp.json()
            text = result["choices"][0]["message"]["content"]
            json_start = text.find("{")
            if json_start != -1:
                return json.loads(text[json_start:])
        except Exception as e:
            print(f"    - Together AI error [{model_name}], attempt {attempt + 1}: {e}")
            time.sleep(RETRY_DELAY)
    return None


def call_groq(prompt, model_name):
    """Call Groq Chat Completion."""
    if not GROQ_KEY:
        return None
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {GROQ_KEY}"}
    payload = {
        "model": model_name,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 100,
        "temperature": 0.2
    }
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=60)
            resp.raise_for_status()
            result = resp.json()
            text = result["choices"][0]["message"]["content"]
            json_start = text.find("{")
            if json_start != -1:
                return json.loads(text[json_start:])
        except Exception as e:
            print(f"    - Groq error [{model_name}], attempt {attempt + 1}: {e}")
            time.sleep(RETRY_DELAY)
    return None


# =========================
# MAIN LOGIC
# =========================
def resolve_reddit_leads_with_ai():
    """Link Reddit leads using Hugging Face -> Together AI -> Groq fallback."""
    if not URI:
        print("    - FATAL: Neo4j credentials not found."); return
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))

    ai_providers = [
        ("Hugging Face", lambda p: call_huggingface(p, "HuggingFaceHUB/gpt2")),
        ("Together AI", lambda p: call_together(p, "mistralai/Mistral-7B-Instruct-v0.2")),
        ("Groq", lambda p: call_groq(p, "llama3-8b-8192"))
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

        total_count = len(unlinked_signals)
        linked_count = 0
        print(f"  - TOTAL Reddit leads to link: {total_count}")

        for batch_start in range(0, total_count, BATCH_SIZE):
            batch = unlinked_signals[batch_start:batch_start + BATCH_SIZE]
            print(f"  - Processing batch {batch_start // BATCH_SIZE + 1}/{(total_count // BATCH_SIZE) + 1}")

            for signal in batch:
                prompt = (
                    "You are an expert entity resolver. Respond ONLY with JSON object: "
                    '{"best_match": "<Project Name or None>"}. '
                    "If no match, use None.\n"
                    f"**Reddit Title:** \"{signal['title']}\"\n"
                    f"**Project List:** {json.dumps(project_names)}\n"
                    "**JSON Response:**"
                )
                for name, fetch_func in ai_providers:
                    result = fetch_func(prompt)
                    if isinstance(result, dict):
                        best_match = result.get("best_match")
                        if best_match and best_match != "None" and best_match in project_names:
                            print(f"    - ✅ [{name}] MATCH: \"{signal['title'][:40]}...\" -> \"{best_match}\"")
                            session.run("""
                                MATCH (p:Project {display_name: $p_name}), (s:Signal {url: $s_url})
                                MERGE (p)-[:HAS_SIGNAL]->(s)
                            """, p_name=best_match, s_url=signal["url"])
                            linked_count += 1
                            break
                time.sleep(1)

            # End batch wait
            time.sleep(SLEEP_BETWEEN_BATCHES)

    print(f"  - AI Resolution Complete. {linked_count}/{total_count} links created.")
    driver.close()


def run_resolver():
    """Run the bulletproof multi-provider entity resolver."""
    print("\n=== Starting BULLETPROOF Reddit Lead Resolution ===")
    resolve_reddit_leads_with_ai()
    print("=== Done ===\n")


if __name__ == '__main__':
    run_resolver()
