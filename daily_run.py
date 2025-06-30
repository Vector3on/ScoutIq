# daily_run.py
from collectors import gemini_github_collector, gemini_hacker_news_collector, gemini_reddit_collector, gemini_twitter_collector
from loaders import neo4j_loader
from predict import prepare_opal_data, run_tft_predictor
from act import format_slack_message # Assuming your slack formatter is in act/

def main():
    """
    Orchestrates the lightweight daily run:
    1. Collects fresh signals from the last 24 hours.
    2. Loads them into Neo4j.
    3. Updates the time-series data artifact.
    4. Runs predictions using the pre-trained model.
    5. Formats the final Slack message.
    """
    print("--- Starting Bloodhound OPAL Daily Run ---")
    
    # Phase 1: Collect and Load fresh signals
    print("\n[Phase 1/4] Collecting and Loading Signals...")
    # This assumes your collectors are now modified to only fetch recent data if needed
    # For now, we'll run them as is.
    all_collectors = { "github": gemini_github_collector.collect_signals, "hackernews": gemini_hacker_news_collector.collect_signals, "reddit": gemini_reddit_collector.collect_signals, "twitter": gemini_twitter_collector.collect_signals }
    for name, collector_func in all_collectors.items():
        signals = collector_func()
        if signals:
            # You could save these to a temp location if needed, but we load them directly
            pass 
    neo4j_loader.load_all_signals("results") # Assuming collectors save to "results"

    # Phase 2: Prepare data with the latest signals
    print("\n[Phase 2/4] Preparing Prediction Data...")
    prepare_opal_data.create_real_timeseries_data()

    # Phase 3: Run predictions using the model from Colab
    print("\n[Phase 3/4] Running Predictions...")
    run_tft_predictor.run_predictions()

    # Phase 4: Format the Slack message for delivery
    print("\n[Phase 4/4] Formatting Slack Message...")
    format_slack_message.format_message()

    print("\n--- Bloodhound OPAL Daily Run Complete ---")

if __name__ == "__main__":
    main()
