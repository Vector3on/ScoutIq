import sqlite3
import os
import requests
import time

# --- CONFIGURATION ---
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'leads.db')

def get_readme_content(github_url):
    try:
        parts = github_url.split('/')
        user, repo = parts[-2], parts[-1]
        possible_urls = [
            f"https://raw.githubusercontent.com/{user}/{repo}/main/README.md",
            f"https://raw.githubusercontent.com/{user}/{repo}/master/README.md",
        ]
        for url in possible_urls:
            response = requests.get(url)
            if response.status_code == 200:
                return response.text[:4000]
        return None
    except Exception:
        return None

def execute_gemini_fetch(prompt):
    print("    - SIMULATING Gemini API call...")
    time.sleep(1)
    mock_response = {
        "summary": "Simulated AI summary of the project.",
        "hype_score": 7,
        "reasoning": "Project shows potential based on simulated analysis."
    }
    return mock_response

def analyze_project_with_ai(project_id):
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    cur.execute("SELECT * FROM projects WHERE id = ?", (project_id,))
    project = cur.fetchone()
    cur.execute("SELECT * FROM github_leads WHERE project_id = ?", (project_id,))
    github_lead = cur.fetchone()
    context = f"Project Name: {project['display_name']}\n"
    if github_lead:
        readme_content = get_readme_content(github_lead['url'])
        if readme_content: context += f"\n--- README ---\n{readme_content}\n"
    
    prompt = f"Analyze: {context}. Return JSON with keys: summary, hype_score, reasoning."
    ai_result = execute_gemini_fetch(prompt)
    if ai_result:
        cur.execute("UPDATE projects SET ai_summary = ?, ai_hype_score = ?, ai_last_analyzed = CURRENT_TIMESTAMP WHERE id = ?", 
                    (ai_result['summary'], ai_result['hype_score'], project_id))
        con.commit()
    con.close()

def run_ai_analysis_on_new_projects():
    print("  - Running AI Analysis Engine...")
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute("SELECT id FROM projects WHERE ai_last_analyzed IS NULL")
    project_ids = [row[0] for row in cur.fetchall()]
    con.close()
    if not project_ids:
        print("    - No new projects to analyze.")
        return
    for project_id in project_ids:
        analyze_project_with_ai(project_id)
        time.sleep(2)
    print(f"    - AI analysis complete. Processed {len(project_ids)} projects.")

if __name__ == '__main__':
    run_ai_analysis_on_new_projects()
