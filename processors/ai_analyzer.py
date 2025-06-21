import sqlite3
import os
import requests
import json
import time

# NOTE: This script is designed for a Colab/Canvas environment that provides
# the Gemini API via a specific `fetch` mechanism. It will not run locally
# without modification. This is a simulation of that environment's fetch call.
# The `execute_gemini_fetch` is a placeholder for that built-in functionality.

DB_PATH = '/content/drive/MyDrive/bloodhound-vc/data/leads.db'

def get_readme_content(github_url):
    """Fetches the raw README content from a GitHub repository."""
    try:
        # Construct the raw content URL
        # e.g., https://github.com/user/repo -> https://raw.githubusercontent.com/user/repo/main/README.md
        parts = github_url.split('/')
        user, repo = parts[-2], parts[-1]
        
        # Try common main branch names and README filenames
        possible_urls = [
            f"https://raw.githubusercontent.com/{user}/{repo}/main/README.md",
            f"https://raw.githubusercontent.com/{user}/{repo}/master/README.md",
            f"https://raw.githubusercontent.com/{user}/{repo}/main/readme.md"
        ]
        
        for url in possible_urls:
            response = requests.get(url)
            if response.status_code == 200:
                # Return first 4000 characters to avoid huge contexts
                return response.text[:4000]
        return None # No README found
    except Exception as e:
        print(f"    - Could not fetch README for {github_url}. Error: {e}")
        return None

def execute_gemini_fetch(prompt):
    """
    PLACEHOLDER for the actual environment's Gemini API fetch call.
    In a real scenario, this would be a `fetch` call to the API endpoint.
    For this simulation, we return a mock response.
    """
    print("    - SIMULATING Gemini API call...")
    time.sleep(2) # Simulate network latency
    # This is the structure the real API call would aim for.
    mock_response = {
        "summary": "This is a simulated AI summary of the project based on the provided data.",
        "hype_score": 7,
        "reasoning": "The project addresses a growing market and has clear documentation."
    }
    # In the real implementation, you would parse the JSON from the API response.
    # const result = await response.json();
    # const text = result.candidates[0].content.parts[0].text;
    # const parsedJson = JSON.parse(text);
    return mock_response


def analyze_project_with_ai(project_id):
    """
    Gathers all data for a project, sends it to the Gemini LLM for analysis,
    and updates the project record with the AI's insights.
    """
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    # Get project details
    cur.execute("SELECT * FROM projects WHERE id = ?", (project_id,))
    project = cur.fetchone()
    
    # Get associated GitHub lead
    cur.execute("SELECT * FROM github_leads WHERE project_id = ?", (project_id,))
    github_lead = cur.fetchone()
    
    # Get associated Reddit leads
    cur.execute("SELECT title FROM reddit_leads WHERE project_id = ?", (project_id,))
    reddit_leads = cur.fetchall()
    
    # --- Build the context for the AI ---
    context = f"Project Name: {project['display_name']}\n"
    
    if github_lead:
        readme_content = get_readme_content(github_lead['url'])
        if readme_content:
            context += f"\n--- GitHub README ---\n{readme_content}\n"
            
    if reddit_leads:
        context += "\n--- Relevant Reddit Post Titles ---\n"
        for lead in reddit_leads:
            context += f"- {lead['title']}\n"

    # --- Construct the AI Prompt ---
    prompt = f"""
Analyze the following project data. Based ONLY on the information provided, return a JSON object with three keys: "summary" (a one-sentence description), "hype_score" (an integer from 1 to 10 based on its potential), and "reasoning" (a brief explanation for the score).

--- START OF DATA ---
{context}
--- END OF DATA ---

Your JSON response:
"""

    print(f"  - Analyzing project '{project['display_name']}' with Gemini...")
    # This is where the real API call would happen
    ai_result = execute_gemini_fetch(prompt)

    if ai_result and "summary" in ai_result and "hype_score" in ai_result:
        try:
            cur.execute("""
                UPDATE projects 
                SET ai_summary = ?, ai_hype_score = ?, ai_last_analyzed = CURRENT_TIMESTAMP
                WHERE id = ?
            """, (ai_result['summary'], ai_result['hype_score'], project_id))
            con.commit()
            print(f"    - SUCCESS: AI analysis saved for '{project['display_name']}'. Hype Score: {ai_result['hype_score']}")
        except Exception as e:
            print(f"    - FAILED: Could not save AI analysis to DB. Error: {e}")
    else:
        print("    - FAILED: AI analysis did not return the expected result.")

    con.close()


def run_ai_analysis_on_new_projects():
    """Finds projects that haven't been analyzed and sends them to the AI."""
    print("Initiating AI Analysis cycle...")
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    # Find projects that have never been analyzed
    cur.execute("SELECT id FROM projects WHERE ai_last_analyzed IS NULL")
    project_ids_to_analyze = [row[0] for row in cur.fetchall()]
    con.close()

    if not project_ids_to_analyze:
        print("  - No new projects to analyze.")
        return
        
    print(f"Found {len(project_ids_to_analyze)} new projects for AI analysis.")
    for project_id in project_ids_to_analyze:
        analyze_project_with_ai(project_id)
        time.sleep(5) # Rate limit our API calls

if __name__ == '__main__':
    run_ai_analysis_on_new_projects()

