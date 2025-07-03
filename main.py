# main.py
import pandas as pd
import os
import json
import sys
from pathlib import Path

# Add project root to sys.path to allow imports from sibling directories
sys.path.append(str(Path(__file__).resolve().parent))

from features.behavioral_extractor import get_commit_history
from learn.causal_discoverer import discover_causality
from learn.anomaly_detector import get_anomaly_scores
from learn.conviction_scorer import calculate_conviction_score
from predict.dlinear_forecaster import generate_forecast
from simulate.ecosystem_simulator import StartupEcosystem
from discovery.active_radar import discover_repos
from reporting.report_generator import MarkdownReport
from reporting.slack_notifier import send_slack_alert

def get_curator_data(repo_url: str) -> dict:
    cache_path = "discovery/curator_cache.json"
    if not os.path.exists(cache_path):
        return {}
    try:
        with open(cache_path, 'r') as f:
            cache = json.load(f)
        return cache.get(repo_url, {})
    except (json.JSONDecodeError, FileNotFoundError):
        return {}

def run_full_pipeline(project_id: str, repo_url: str, all_projects_data: dict):
    print(f"\n{'='*20} INTELLIGENCE BRIEFING: {project_id} {'='*20}")
    
    report = MarkdownReport(project_id, repo_url)
    
    curator_data = get_curator_data(repo_url)
    qualitative_score = curator_data.get('qualitative_score')
    
    print("\n[Phase 1/6] Calculating Anomaly Score...")
    anomaly_score = get_anomaly_scores(all_projects_data, project_id)
    
    print("\n[Phase 2/6] Performing Causal Analysis...")
    is_causal, p_value = None, None
    commit_data = get_commit_history(repo_url, days_back=180)
    
    if commit_data:
        raw_commits_df = pd.DataFrame(commit_data, columns=['createdAt', 'author'])
        raw_commits_df['createdAt'] = pd.to_datetime(raw_commits_df['createdAt'], utc=True)
        daily_commits = raw_commits_df.set_index('createdAt').resample('D').size().reset_index(name='daily_commit_velocity')
        first_seen_df = raw_commits_df.groupby('author')['createdAt'].min().reset_index()
        daily_new_contributors = first_seen_df.set_index('createdAt').resample('D').size().reset_index(name='daily_new_contributors')
        analysis_df = pd.merge(daily_commits, daily_new_contributors, on='createdAt', how='outer').fillna(0)
        is_causal, p_value = discover_causality(analysis_df, 'daily_new_contributors', 'daily_commit_velocity')
    
    print("\n[Phase 3/6] Generating Forecast...")
    forecast_df = pd.DataFrame()
    forecast_list = []
    INPUT_LEN, OUTPUT_LEN = 90, 30
    
    if 'analysis_df' in locals() and len(analysis_df) >= INPUT_LEN + OUTPUT_LEN:
        forecast_values = generate_forecast(data=analysis_df, target_column='daily_commit_velocity', input_seq_len=INPUT_LEN, output_seq_len=OUTPUT_LEN, epochs=150)
        last_date = analysis_df['createdAt'].iloc[-1]
        future_dates = pd.date_range(start=last_date + pd.Timedelta(days=1), periods=OUTPUT_LEN, freq='D')
        forecast_df = pd.DataFrame({'date': future_dates, 'forecasted_commits': [max(0, int(round(val))) for val in forecast_values]})
        forecast_list = forecast_df['forecasted_commits'].head(7).tolist()
    
    print("\n[Phase 4/6] Simulating Ecosystem Growth...")
    NUM_SIMULATIONS, SIMULATION_STEPS = 100, 50
    final_contributor_counts, peak_hype_levels, total_funding_events = [], [], 0
    for _ in range(NUM_SIMULATIONS):
        model = StartupEcosystem(num_casual_devs=195, num_core_devs=5)
        for _ in range(SIMULATION_STEPS):
            model.step()
        final_contributor_counts.append(model.project.contributors)
        peak_hype_levels.append(model.peak_hype)
        total_funding_events += model.funding_events
    avg_contributors = sum(final_contributor_counts) / NUM_SIMULATIONS
    max_contributors = max(final_contributor_counts)
    avg_peak_hype = sum(peak_hype_levels) / NUM_SIMULATIONS
    avg_funding_events = total_funding_events / NUM_SIMULATIONS

    conviction_score = calculate_conviction_score(
        qualitative_score=qualitative_score, anomaly_score=anomaly_score,
        is_causal=is_causal, forecast_list=forecast_list,
        avg_contributors=avg_contributors
    )

    print("\n[Phase 6/6] Generating Report & Sending Notification...")
    report.add_conviction_score(conviction_score)
    report.add_qualitative_score(qualitative_score)
    report.add_anomaly_score(anomaly_score)
    report.add_causal_analysis(is_causal, p_value)
    report.add_forecast(forecast_df)
    report.add_simulation(avg_contributors, max_contributors, avg_peak_hype, avg_funding_events)
    report.save()
    
    send_slack_alert(
        project_id=project_id, repo_url=repo_url,
        conviction_score=conviction_score, qualitative_score=qualitative_score,
        anomaly_score=anomaly_score
    )
    print(f"\n{'='*20} END BRIEFING: {project_id} {'='*20}\n")

if __name__ == '__main__':
    new_targets = discover_repos(topic="llm", language="python", random_n=3)
    if not new_targets:
        print("No new targets discovered. Exiting main pipeline.")
    else:
        print(f"\n--- Building context from {len(new_targets)} discovered targets ---")
        historical_data = {}
        for repo_url in new_targets:
            project_id = "/".join(repo_url.split('/')[-2:])
            print(f" - Analyzing history for: {project_id}")
            commits = get_commit_history(repo_url, days_back=180)
            if commits:
                df = pd.DataFrame(commits, columns=['createdAt', 'author'])
                df['createdAt'] = pd.to_datetime(df['createdAt'], utc=True)
                historical_data[project_id] = df.set_index('createdAt').resample('D').size().reset_index(name='velocity')
        
        print(f"\n--- BEGINNING DEEP ANALYSIS ---")
        for repo_url in new_targets:
            project_id = "/".join(repo_url.split('/')[-2:])
            if project_id not in historical_data:
                print(f"\nSkipping {project_id} due to no historical data.")
                continue
            run_full_pipeline(project_id=project_id, repo_url=repo_url, all_projects_data=historical_data)