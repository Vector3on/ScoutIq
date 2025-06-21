import sqlite3
import os
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError
import pandas as pd

# --- CONFIGURATION ---
SLACK_BOT_TOKEN = os.environ.get("SLACK_BOT_TOKEN")
SLACK_CHANNEL_ID = "YOUR_CHANNEL_ID_HERE" # Make sure this is correct
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'leads.db')
NUM_PROJECTS = 5

def format_ai_message(df):
    header = {"type": "header", "text": {"type": "plain_text", "text": f"🧠 Bloodhound AI Briefing: Top {len(df)} Projects"}}
    blocks = [header, {"type": "divider"}]
    for _, row in df.iterrows():
        ai_summary = row.get('ai_summary') or "AI analysis pending."
        ai_hype = row.get('ai_hype_score') or "N/A"
        section_text = (f"*<{row['primary_url']}|{row['display_name']}>*\n"
                        f"🤖 *AI Summary:* {ai_summary}\n"
                        f"🔥 *AI Hype Score:* {ai_hype}/10")
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": section_text}})
        blocks.append({"type": "divider"})
    return blocks

def send_daily_digest():
    print("  - Running Slack Notifier...")
    if not SLACK_BOT_TOKEN: print("    - FATAL: Slack Token not set."); return
    if not SLACK_CHANNEL_ID or SLACK_CHANNEL_ID == "YOUR_CHANNEL_ID_HERE": print("    - FATAL: Slack Channel ID not set."); return

    try:
        con = sqlite3.connect(DB_PATH)
        query = f"SELECT display_name, primary_url, ai_summary, ai_hype_score FROM projects ORDER BY ai_hype_score DESC, id DESC LIMIT {NUM_PROJECTS}"
        df = pd.read_sql_query(query, con)
        con.close()
    except Exception as e:
        print(f"    - FATAL: Could not fetch projects. Error: {e}"); return

    if df.empty:
        print("    - No AI-analyzed projects found to report."); return

    client = WebClient(token=SLACK_BOT_TOKEN)
    try:
        client.chat_postMessage(channel=SLACK_CHANNEL_ID, text="Bloodhound AI Briefing", blocks=format_ai_message(df))
        print("    - SUCCESS: AI-powered Slack digest sent!")
    except SlackApiError as e:
        print(f"    - FATAL: Failed to send Slack message. Error: {e.response['error']}")

if __name__ == '__main__':
    send_daily_digest()
