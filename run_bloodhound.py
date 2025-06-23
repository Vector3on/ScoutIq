import os
import sys

# Get the directory where this script is located.
# This must be done BEFORE we try to import our custom modules.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# Add the project's root directory to the system path.
sys.path.append(SCRIPT_DIR)

# NOW we can safely import our modules because they are in proper packages.
from collectors import github_scraper, reddit_scraper
from processors import entity_resolver
from outputs import slack_notifier

def run_full_cycle():
    """
    The main orchestrator that runs the entire, professional-grade pipeline.
    """
    print("="*50+"\nBLOODHOUND VC: PROFESSIONAL CYCLE v4 - INITIATED\n"+"="*50)
    
    print("\n[PHASE 1] COLLECT: Running collectors...")
    github_scraper.scrape_github_trending()
    reddit_scraper.scrape_reddit_submissions()
    
    print("\n[PHASE 1.5] RESOLVE: Running entity resolver...")
    entity_resolver.run_resolver()

    print("\n[PHASE 3] REPORT: Running Slack notifier...")
    slack_notifier.send_daily_digest()
    
    print("\n"+"="*50+"\nBLOODHOUND VC: PROFESSIONAL CYCLE COMPLETED\n"+"="*50)

if __name__ == '__main__':
    run_full_cycle()
