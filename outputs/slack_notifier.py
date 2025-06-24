import os
from neo4j import GraphDatabase
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError
import pandas as pd

# --- CONFIGURATION ---
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")
SLACK_BOT_TOKEN = os.environ.get("SLACK_BOT_TOKEN")
SLACK_CHANNEL_ID = "YOUR_CHANNEL_ID_HERE" # Make sure this is correct
NUM_PROJECTS = 5

def format_founder_message(df):
    """Formats the top projects and their founders into a Slack message."""
    header = {"type": "header", "text": {"type": "plain_text", "text": f"🔥 Bloodhound Founder Report: Top {len(df)} Projects"}}
    blocks = [header, {"type": "divider"}]
    
    for _, row in df.iterrows():
        section_text = (
            f"*<{row['project_url']}|{row['project_name']}>*\n"
            f"👤 *Founder:* `{row['founder_name']}`\n"
            f"⭐ *Stars:* {row['project_stars']:,}"
        )
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": section_text}})
        blocks.append({"type": "divider"})
    return blocks

def send_daily_digest():
    """Fetches top projects and their founders from the graph and sends to Slack."""
    print("  - Preparing Founder-Aware Slack digest...")
    if not URI or not SLACK_BOT_TOKEN or SLACK_CHANNEL_ID == "YOUR_CHANNEL_ID_HERE":
        print("    - FATAL: Database or Slack credentials are not configured.")
        return

    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    
    with driver.session() as session:
        # This query now traverses the graph to get founders and their projects
        query = f"""
        MATCH (f:Founder)-[:FOUNDED]->(p:Project)
        RETURN f.name AS founder_name, p.display_name AS project_name, p.stars AS project_stars, p.url AS project_url
        ORDER BY p.stars DESC
        LIMIT {NUM_PROJECTS}
        """
        result = session.run(query)
        df = pd.DataFrame([r.data() for r in result])

    driver.close()

    if df.empty:
        print("    - No founder-linked projects found to report."); return

    client = WebClient(token=SLACK_BOT_TOKEN)
    try:
        client.chat_postMessage(channel=SLACK_CHANNEL_ID, text="Bloodhound Founder Report", blocks=format_founder_message(df))
        print("    - SUCCESS: Founder-Aware Slack digest sent!")
    except SlackApiError as e:
        print(f"    - FATAL: Failed to send Slack message. Error: {e.response['error']}")

if __name__ == '__main__':
    send_daily_digest()
