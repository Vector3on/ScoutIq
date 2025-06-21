import sqlite3
import os
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError
import pandas as pd

# INSECURE - TOKEN IS HARDCODED
SLACK_BOT_TOKEN = "xoxb-9071042028198-9077000692802-dyWaT05SnazZtLjxB45NoUHz"
SLACK_CHANNEL_ID = "C0928V1HUSE"
DB_PATH = '/content/drive/MyDrive/bloodhound-vc/data/leads.db'
NUM_PROJECTS = 5 # Number of top projects to report

def format_ai_message(top_projects_df):
    """Formats the top projects DataFrame into an AI-powered Slack message."""
    header = {"type": "header", "text": {"type": "plain_text", "text": f"🧠 Bloodhound AI Briefing: Top {len(top_projects_df)} Projects"}}
    blocks = [header, {"type": "divider"}]
    
    for _, row in top_projects_df.iterrows():
        # Handle cases where AI analysis might not have run or is null
        ai_summary = row.get('ai_summary') or "AI analysis pending."
        ai_hype = row.get('ai_hype_score') or "N/A"
        
        section_text = (
            f"*<{row['primary_url']}|{row['display_name']}>*\n"
            f"🤖 *AI Summary:* {ai_summary}\n"
            f"🔥 *AI Hype Score:* {ai_hype}/10"
        )
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": section_text}})
        blocks.append({"type": "divider"})
    return blocks

def send_daily_digest():
    """Fetches the top PROJECTS and their AI analysis and sends them to Slack."""
    print("Preparing AI-powered Slack digest...")
    if SLACK_BOT_TOKEN.startswith("PASTE_"): print("FATAL: Slack Token not set."); return
    if SLACK_CHANNEL_ID.startswith("PASTE_"): print("FATAL: Slack Channel ID not set."); return

    try:
        con = sqlite3.connect(DB_PATH)
        # Query the MASTER 'projects' table, now including the AI fields!
        # We will order by the new AI hype score.
        query = f"SELECT display_name, primary_url, ai_summary, ai_hype_score FROM projects ORDER BY ai_hype_score DESC, id DESC LIMIT {NUM_PROJECTS}"
        df = pd.read_sql_query(query, con)
        con.close()
        print(f"Successfully fetched {len(df)} top AI-analyzed projects.")
    except Exception as e:
        print(f"FATAL: Could not fetch AI-analyzed projects. Error: {e}"); return

    if df.empty:
        print("No AI-analyzed projects found to report."); return

    client = WebClient(token=SLACK_BOT_TOKEN)
    try:
        client.chat_postMessage(channel=SLACK_CHANNEL_ID, text="Bloodhound AI Briefing", blocks=format_ai_message(df))
        print("SUCCESS: AI-powered Slack digest sent successfully!")
    except SlackApiError as e:
        print(f"FATAL: Failed to send Slack message. Error: {e.response['error']}")

if __name__ == '__main__':
    send_daily_digest()
