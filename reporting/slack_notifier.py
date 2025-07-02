# reporting/slack_notifier.py
import os
# --- THIS IS THE FIX ---
# Import the correct client for Incoming Webhooks
from slack_sdk.webhook import WebhookClient
# --- END FIX ---
from slack_sdk.errors import SlackApiError

SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL")

def send_slack_alert(project_id: str, repo_url: str, anomaly_score: float, is_causal: bool, p_value: float, forecast: list):
    """
    Formats and sends a discovery alert to a Slack channel using a webhook.
    """
    if not SLACK_WEBHOOK_URL:
        print("  - WARN: SLACK_WEBHOOK_URL not set. Skipping Slack notification.")
        return

    # --- THIS IS THE FIX ---
    # Initialize the WebhookClient with the URL
    webhook = WebhookClient(SLACK_WEBHOOK_URL)
    # --- END FIX ---

    # --- Build the Slack Message ---
    if anomaly_score and anomaly_score > 0.5:
        title_text = f"🔥 High-Potential Project Discovered: {project_id}"
    else:
        title_text = f"New Project Analyzed: {project_id}"

    if is_causal is not None:
        causal_text = f"✅ *Significant Causal Link Found* (p={p_value:.3f})" if is_causal else f"❌ *No Significant Causal Link Found* (p={p_value:.3f})"
    else:
        causal_text = "N/A"

    # The block kit structure remains the same
    blocks = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"<{repo_url}|*{title_text}*>"
            }
        },
        {
            "type": "divider"
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*Anomaly Score:*\n`{anomaly_score if anomaly_score is not None else 'N/A'}`"},
                {"type": "mrkdwn", "text": f"*7-Day Commit Forecast:*\n`{forecast}`"},
                {"type": "mrkdwn", "text": f"*Contributor Causality:*\n{causal_text}"}
            ]
        },
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": "ScoutIQ Active Radar"
                }
            ]
        }
    ]

    # --- Send the Message ---
    try:
        # --- THIS IS THE FIX ---
        # The WebhookClient uses a simple .send() method
        response = webhook.send(
            text=f"ScoutIQ Alert: {project_id}", # Fallback text for notifications
            blocks=blocks
        )
        # --- END FIX ---
        
        if response.status_code == 200:
            print("  - ✅ Slack notification sent successfully.")
        else:
            print(f"  - ❌ ERROR: Failed to send Slack notification. Status: {response.status_code}, Body: {response.body}")

    except SlackApiError as e:
        print(f"  - ❌ ERROR: Failed to send Slack notification. Reason: {e.response['error']}")
