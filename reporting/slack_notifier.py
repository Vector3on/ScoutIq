# reporting/slack_notifier.py
import os
from slack_sdk.webhook import WebhookClient
from slack_sdk.errors import SlackApiError

SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL")

def send_slack_alert(project_id: str, repo_url: str, conviction_score: float, qualitative_score: float, anomaly_score: float):
    if not SLACK_WEBHOOK_URL:
        # This block was missing
        print(" - WARN: SLACK_WEBHOOK_URL not set. Skipping Slack notification.")
        return

    webhook = WebhookClient(SLACK_WEBHOOK_URL)

    if conviction_score and conviction_score > 0.7:
        title_text = f"🔥🔥 High-Conviction Discovery: {project_id}"
    elif conviction_score and conviction_score > 0.5:
        title_text = f"🔎 Promising Project Analyzed: {project_id}"
    else:
        title_text = f"New Project Analyzed: {project_id}"

    blocks = [
        {"type": "section", "text": {"type": "mrkdwn", "text": f"<{repo_url}|*{title_text}*>"}},
        {"type": "divider"},
        {"type": "section", "fields": [
            {"type": "mrkdwn", "text": f"*🎯 Conviction Score:*\n*{conviction_score:.3f}*"},
            {"type": "mrkdwn", "text": f"*🤖 AI Readme Score:*\n{qualitative_score:.2f} / 5.0" if qualitative_score is not None else 'N/A'},
            {"type": "mrkdwn", "text": f"*Anomaly Score:*\n{anomaly_score:.4f}" if anomaly_score is not None else 'N/A'},
        ]},
        {"type": "context", "elements": [{"type": "mrkdwn", "text": "ScoutIQ Final Analysis"}]}
    ]

    try:
        response = webhook.send(text=f"ScoutIQ Alert: {project_id}", blocks=blocks)
        if response.status_code == 200:
            print("✅ Slack notification sent successfully.")
        else:
            print(f" - X ERROR: Failed to send Slack notification. Status: {response.status_code}, Body: {response.body}")
    except SlackApiError as e:
        print(f" - X ERROR: Failed to send Slack notification. Reason: {e.response['error']}")