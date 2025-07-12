# scanners/github_activity_scanner.py
import os
import sys
import json
import requests
from datetime import datetime, timedelta

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
HEADERS = {'Authorization': f'token {GITHUB_TOKEN}'} if GITHUB_TOKEN else {}
BASELINE_PERIOD_DAYS = 90
RECENT_PERIOD_DAYS = 14
ACTIVITY_THRESHOLD = 0.20

def get_all_user_events(username: str) -> list:
    if not GITHUB_TOKEN: return []
    print(f"[SCANNER:GH_ACTIVITY] Fetching events for {username}...", file=sys.stderr)
    api_url = f"https://api.github.com/users/{username}/events?per_page=100"
    all_events = []
    page = 1
    while api_url:
        try:
            response = requests.get(api_url, headers=HEADERS)
            response.raise_for_status()
            events = response.json()
            if not events: break
            all_events.extend(events)
            api_url = response.links.get('next', {}).get('url')
            page += 1
        except requests.exceptions.RequestException as e:
            print(f"[SCANNER:GH_ACTIVITY] ERROR: API request failed: {e}", file=sys.stderr)
            return []
    return all_events

def analyze_activity(username: str, events: list) -> dict:
    now = datetime.utcnow()
    baseline_start_date = now - timedelta(days=BASELINE_PERIOD_DAYS)
    recent_start_date = now - timedelta(days=RECENT_PERIOD_DAYS)
    baseline_events = [e for e in events if datetime.strptime(e['created_at'], "%Y-%m-%dT%H:%M:%SZ") >= baseline_start_date and datetime.strptime(e['created_at'], "%Y-%m-%dT%H:%M:%SZ") < recent_start_date]
    recent_events = [e for e in events if datetime.strptime(e['created_at'], "%Y-%m-%dT%H:%M:%SZ") >= recent_start_date]
    baseline_weeks = (BASELINE_PERIOD_DAYS - RECENT_PERIOD_DAYS) / 7.0
    baseline_events_per_week = len(baseline_events) / baseline_weeks if baseline_weeks > 0 else 0
    recent_weeks = RECENT_PERIOD_DAYS / 7.0
    recent_events_per_week = len(recent_events) / recent_weeks if recent_weeks > 0 else 0
    activity_drop = False
    if baseline_events_per_week > 2 and (recent_events_per_week / baseline_events_per_week) < ACTIVITY_THRESHOLD:
        activity_drop = True
    drop_percentage = (1 - (recent_events_per_week / baseline_events_per_week)) * 100 if baseline_events_per_week > 0 else 0
    return {
        "username": username, "activity_drop": activity_drop,
        "baseline_events_per_week": round(baseline_events_per_week, 2),
        "recent_events_per_week": round(recent_events_per_week, 2),
        "reason": f"Public activity dropped by {drop_percentage:.1f}% against a {BASELINE_PERIOD_DAYS}-day baseline." if activity_drop else "No significant drop in public activity detected."
    }

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python github_activity_scanner.py <username>"}), file=sys.stderr); sys.exit(1)
    target_username = sys.argv[1]
    if not GITHUB_TOKEN:
        print(json.dumps({"error": "GITHUB_TOKEN environment variable not set."}), file=sys.stderr); sys.exit(1)
    all_events = get_all_user_events(target_username)
    if not all_events:
        print(json.dumps({"error": f"No events found or API error for user {target_username}."})); sys.exit(0)
    analysis_result = analyze_activity(target_username, all_events)
    print(json.dumps(analysis_result, indent=2))

if __name__ == "__main__":
    main()