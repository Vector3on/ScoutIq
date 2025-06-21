import os
import sys
import time

PROJECT_PATH = "/content/drive/MyDrive/bloodhound-vc"
sys.path.append(PROJECT_PATH)

from collectors import github_scraper, reddit_scraper
from processors import entity_resolver, score_engine, ai_analyzer
from outputs import slack_notifier

def run_full_cycle():
    print("="*50+"\nBLOODHOUND VC: AI-POWERED CYCLE - INITIATED\n"+"="*50)
    
    print("\n[PHASE 1] COLLECT: Running collectors...")
    github_scraper.scrape_github_trending()
    reddit_scraper.scrape_reddit_submissions()
    
    print("\n[PHASE 1.5] RESOLVE: Running entity resolver...")
    entity_resolver.run_resolver()
    
    print("\n[PHASE 2] SCORE: Running unified scoring engine...")
    score_engine.calculate_project_scores()

    print("\n[PHASE 2.5] ANALYZE: Running AI analysis engine...")
    ai_analyzer.run_ai_analysis_on_new_projects()

    print("\n[PHASE 3] REPORT: Running Slack notifier...")
    slack_notifier.send_daily_digest()
    
    print("\n"+"="*50+"\nBLOODHOUND VC: AI-POWERED CYCLE COMPLETED\n"+"="*50)

if __name__ == '__main__':
    os.chdir(PROJECT_PATH)
    run_full_cycle()

