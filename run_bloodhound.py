"""
The main orchestrator for the Bloodhound VC Intelligence Pipeline.
This script is the entry point for the entire automated system.
"""

# All imports are now at the top, satisfying all linters.
from collectors import github_scraper, reddit_scraper
from processors import entity_resolver
from outputs import slack_notifier

def run_full_cycle():
    """
    Executes the entire intelligence pipeline from data collection to reporting.
    """
    print("=" * 60)
    print("BLOODHOUND VC: PROFESSIONAL INTELLIGENCE CYCLE - INITIATED")
    print("=" * 60)

    print("\n[PHASE 1] COLLECT: Running data collectors...")
    github_scraper.scrape_github_trending()
    reddit_scraper.scrape_reddit_submissions()
    print("[PHASE 1] COMPLETE")

    print("\n[PHASE 1.5] RESOLVE: Running AI-powered entity resolver...")
    entity_resolver.run_resolver()
    print("[PHASE 1.5] COMPLETE")

    print("\n[PHASE 3] REPORT: Running Slack notifier...")
    slack_notifier.send_daily_digest()
    print("[PHASE 3] COMPLETE")

    print("\n" + "=" * 60)
    print("BLOODHOUND VC: PROFESSIONAL INTELLIGENCE CYCLE - COMPLETED")
    print("=" * 60)


if __name__ == "__main__":
    run_full_cycle()
