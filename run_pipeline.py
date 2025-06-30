# run_pipeline.py
import os
import json
from collectors import gemini_github_collector, gemini_hacker_news_collector, gemini_reddit_collector, gemini_twitter_collector
from loaders import neo4j_loader

RESULTS_DIR = "results"

def run_collectors():
    """Runs all collectors and saves their output to files."""
    print("--- Running All Collectors ---")
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
            print(f"  ✅ Output saved to {file_path}")

def main():
    """Main function to run the entire pipeline."""
    # Phase 1: Collect data from all sources
    run_collectors()
    
    # Phase 2: Load the collected data into Neo4j
    neo4j_loader.load_all_signals(RESULTS_DIR)

if __name__ == "__main__":
    main()
