# act/format_slack_message.py
#
# Part of the ACT LAYER
#
# FINAL CORRECTED VERSION: This version adds the mandatory top-level "text"
# field to the Slack payload to resolve the "no_text" API error.

import json
import os

# --- Configuration ---
INPUT_SCORES_PATH = "hype_scores.json"
OUTPUT_PAYLOAD_PATH = "slack_payload.json" # The output file
TOP_N_PROJECTS = 5 

def format_message():
    """
    Reads scores, formats them, and writes a Slack-compatible JSON payload to a file.
    """
    print("--- Formatting Slack Message ---")
    try:
        with open(INPUT_SCORES_PATH, 'r') as f:
            scores = json.load(f)
    except FileNotFoundError:
        print(f"Error: Scores file not found at {INPUT_SCORES_PATH}")
        error_payload = {"text": "Bloodhound OPAL Run: Failed to find hype_scores.json artifact."}
        with open(OUTPUT_PAYLOAD_PATH, 'w') as f:
            json.dump(error_payload, f)
        return

    sorted_projects = sorted(scores.items(), key=lambda item: item[1]['hype_score'], reverse=True)
    
    # --- Build the Slack Message ---
    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": "🚀 Bloodhound OPAL Run Complete"}},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"The full OPAL pipeline has successfully executed. *Top {TOP_N_PROJECTS} projects* by hype score are listed below."}},
        {"type": "divider"}
    ]

    for project_id, data in sorted_projects[:TOP_N_PROJECTS]:
        score = data['hype_score']
        project_name = project_id.split('/')[-1]
        
        project_block = {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*{project_name}*\n*Hype Score:* `{score:.4f}`"},
            "accessory": {
                "type": "button",
                "text": {"type": "plain_text", "text": "View Project", "emoji": True},
                "url": f"https://github.com/{project_id}",
                "action_id": f"view_project_{project_name}"
            }
        }
        blocks.append(project_block)

    run_id = os.environ.get("GITHUB_RUN_ID")
    repo = os.environ.get("GITHUB_REPOSITORY")
    server_url = os.environ.get("GITHUB_SERVER_URL")

    if run_id and repo and server_url:
        blocks.append({"type": "divider"})
        blocks.append({
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"<{server_url}/{repo}/actions/runs/{run_id}|View full run details>"}]
        })

    # --- THE FIX IS HERE ---
    # The final payload must be a JSON object that contains BOTH a "blocks" key
    # for the rich content, and a top-level "text" key for fallbacks.
    final_payload = {
        "text": f"Bloodhound Run Complete: Top project is {sorted_projects[0][0]} with score {sorted_projects[0][1]['hype_score']:.4f}",
        "blocks": blocks
    }
    
    # --- Write to File ---
    with open(OUTPUT_PAYLOAD_PATH, 'w') as f:
        json.dump(final_payload, f)
        
    print(f"Successfully wrote Slack payload to {OUTPUT_PAYLOAD_PATH}")

if __name__ == "__main__":
    format_message()
