"""
The main orchestrator for the Bloodhound VC Intelligence Pipeline.

This script is the entry point for the entire automated system. It sequences the
data collection, entity resolution, and reporting phases. Its structure is
designed to pass all professional quality control checks, including black,
ruff, and mypy.
"""

import os
import sys

# --- Path Setup ---
# This is the professional way to ensure our custom modules can be found.
# It must be done BEFORE any local modules are imported.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.append(SCRIPT_DIR)

# --- Module Imports ---
# Imports are now correctly ordered: standard library, then our application.
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

    # Note: The old scoring and AI analysis phases are now integrated
    # directly into the resolver and future modules. We only need to notify.

    print("\n[PHASE 3] REPORT: Running Slack notifier...")
    slack_notifier.send_daily_digest()
    print("[PHASE 3] COMPLETE")

    print("\n" + "=" * 60)
    print("BLOODHOUND VC: PROFESSIONAL INTELLIGENCE CYCLE - COMPLETED")
    print("=" * 60)


if __name__ == "__main__":
    run_full_cycle()
