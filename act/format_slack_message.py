# act/format_slack_message.py (Corrected)

import json
import os

# --- Configuration ---
# --- THIS IS THE FIX ---
# Point to the correct path where the predictor saves the file.
INPUT_SCORES_PATH = "results/hype_scores.json"
OUTPUT_PAYLOAD_PATH = "slack_payload.json"
TOP_N_PROJECTS = 5

def format_message():
    print("--- Formatting Slack Message ---")
    try:
        with open(INPUT_SCORES_PATH, 'r') as f:
            data = json.load(f)
            projects = data.get("projects", [])
    except FileNotFoundError:
        # This error message is now more accurate.
        print(f"❌ Error: Scores file not found at '{INPUT_SCORES_PATH}'")
        with open(OUTPUT_PAYLOAD_PATH, 'w') as f:
            json.dump({"text": f"Bloodhound OPAL Run: Failed to find artifact at {INPUT_SCORES_PATH}"}, f)
        return

    if not isinstance(projects, list) or not projects:
        print("❌ Error: No valid project scores found in the input file.")
        with open(OUTPUT_PAYLOAD_PATH, 'w') as f:
            json.dump({"text": "Bloodhound OPAL Run: No valid hype scores found."}, f)
        return

    # Sort by tft_score (hype score proxy)
    sorted_projects = sorted(projects, key=lambda p: p["tft_score"], reverse=True)

    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "🚀 Bloodhound OPAL Run Complete"}
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

    for p in sorted_projects[:TOP_N_PROJECTS]:
        repo_id = p.get("series_id", "Unknown Project")
        score = p.get("tft_score", 0)
        project_name = repo_id.split("/")[-1]

        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*{project_name}*\n*Hype Score:* `{score:.4f}`"
            },
            "accessory": {
                "type": "button",
                "text": {"type": "plain_text", "text": "View Project", "emoji": True},
                "url": f"https://github.com/{repo_id}",
                "action_id": f"view_project_{project_name}"
            }
        })

    # Add GitHub Actions link footer
    run_id = os.environ.get("GITHUB_RUN_ID")
    repo = os.environ.get("GITHUB_REPOSITORY")
    server_url = os.environ.get("GITHUB_SERVER_URL")

    if run_id and repo and server_url:
        blocks.append({"type": "divider"})
        blocks.append({
            "type": "context",
            "elements": [{
                "type": "mrkdwn",
                "text": f"<{server_url}/{repo}/actions/runs/{run_id}|View full run details>"
            }]
        })

    # Final Slack message payload
    final_payload = {
        "text": f"Bloodhound Run Complete: Top project is {sorted_projects[0]['series_id']} with score {sorted_projects[0]['tft_score']:.4f}",
        "blocks": blocks
    }

    with open(OUTPUT_PAYLOAD_PATH, 'w') as f:
        json.dump(final_payload, f, indent=2)

    print(f"✅ Slack payload written to {OUTPUT_PAYLOAD_PATH}")

if __name__ == "__main__":
    format_message()
