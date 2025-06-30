# daily_run.py (Final Corrected Version)
import os
import json
import ssl # <--- IMPORT SSL
from collectors import gemini_github_collector, gemini_hacker_news_collector, gemini_reddit_collector, gemini_twitter_collector
from loaders import neo4j_loader
from predict import prepare_opal_data, run_tft_predictor
from act import format_slack_message

# ==============================================================================
# --- FINAL FIX for SSL: CERTIFICATE_VERIFY_FAILED ---
# This globally overrides the default SSL context to bypass verification.
# It's a powerful workaround for stubborn SSL issues in environments like GHA.
print("--> Applying SSL context workaround for scrapers...")
ssl._create_default_https_context = ssl._create_unverified_context
# ==============================================================================

RESULTS_DIR = "results"

def run_collect_and_load():
    """Runs all collectors, saves their output, and loads it to Neo4j."""
    print("\n[Phase 1/4] Collecting and Loading Signals...")
    os.makedirs(RESULTS_DIR, exist_ok=True)
    
    all_collectors = {
        "github": gemini_github_collector.collect_signals,
        "hackernews": gemini_hacker_news_collector.collect_signals,
        "reddit": gemini_reddit_collector.collect_signals,
        "twitter": gemini_twitter_collector.collect_signals,
    }
    
    for name, collector_func in all_collectors.items():
        signals = collector_func()
        if signals:
            file_path = os.path.join(RESULTS_DIR, f"signals-{name}.json")
            with open(file_path, 'w') as f:
                json.dump(signals, f, indent=2)
            print(f"  ✅ Output for {name} saved to {file_path}")

    neo4j_loader.load_all_signals(RESULTS_DIR)

def main():
    print("--- Starting Bloodhound OPAL Daily Run ---")
    
    run_collect_and_load()

    print("\n[Phase 2/4] Preparing Prediction Data...")
    prepare_opal_data.create_real_timeseries_data()

    print("\n[Phase 3/4] Running Predictions...")
    run_tft_predictor.run_predictions()

    print("\n[Phase 4/4] Formatting Slack Message...")
    format_slack_message.format_message()

    print("\n--- Bloodhound OPAL Daily Run Complete ---")

if __name__ == "__main__":
    main()
