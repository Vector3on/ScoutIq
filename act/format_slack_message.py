# act/format_slack_message.py
#
# Part of the ACT LAYER
#
# Objective:
# 1. Read the hype_scores.json artifact.
# 2. Format the top N projects into a readable, markdown-formatted block.
# 3. Print the final JSON payload for the Slack action to use.

import json
import os

# --- Configuration ---
INPUT_SCORES_PATH = "hype_scores.json"
TOP_N_PROJECTS = 5 # Number of top projects to include in the message

def format_message():
    """
    Reads scores, formats them, and prints a Slack-compatible JSON payload.
    """
    print("--- Formatting Slack Message ---")
    try:
        with open(INPUT_SCORES_PATH, 'r') as f:
            scores = json.load(f)
    except FileNotFoundError:
        print(f"Error: Scores file not found at {INPUT_SCORES_PATH}")
        # Output a simple error message for Slack
        print(json.dumps({"text": "Bloodhound OPAL Run: Failed to find hype_scores.json artifact."}))
        return

    # Sort projects by hype score, descending
    sorted_projects = sorted(scores.items(), key=lambda item: item[1]['hype_score'], reverse=True)
    
    # --- Build the Slack Message ---
    
    # Header
    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": "🚀 Bloodhound OPAL Run Complete"
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"The full OPAL pipeline has successfully executed. *Top {TOP_N_PROJECTS} projects* by hype score are listed below."
            }
        },
        {"type": "divider"}
    ]

    # Add a section for each of the top N projects
    for project_id, data in sorted_projects[:TOP_N_PROJECTS]:
        score = data['hype_score']
        project_name = project_id.split('/')[-1]
        
        project_block = {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*{project_name}*\n*Hype Score:* `{score:.4f}`"
            },
            "accessory": {
                "type": "button",
                "text": {
                    "type": "plain_text",
                    "text": "View Project"
                },
                "url": f"https://github.com/{project_id}",
                "action_id": f"view_project_{project_name}"
            }
        }
        blocks.append(project_block)

    # Footer with link to the full run
    run_id = os.environ.get("GITHUB_RUN_ID")
    repo = os.environ.get("GITHUB_REPOSITORY")
    server_url = os.environ.get("GITHUB_SERVER_URL")

    if run_id and repo and server_url:
        blocks.append({"type": "divider"})
        blocks.append({
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": f"<{server_url}/{repo}/actions/runs/{run_id}|View full run details>"
                }
            ]
        })

    # The final payload must be a JSON object with a 'blocks' key
    final_payload = {"blocks": blocks}
    
    # We print the JSON string to stdout. The workflow will capture this.
    print(json.dumps(final_payload))

if __name__ == "__main__":
    format_message()
