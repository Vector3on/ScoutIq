import pandas as pd
import os
# --- Import all our project modules ---
from features.behavioral_extractor import get_commit_history
from learn.causal_discoverer import discover_causality
from learn.anomaly_detector import get_anomaly_scores
from predict.dlinear_forecaster import generate_forecast
from simulate.ecosystem_simulator import StartupEcosystem
from discovery.active_radar import discover_repos
from reporting.report_generator import MarkdownReport
from reporting.slack_notifier import send_slack_alert # <-- NEW IMPORT

def run_full_pipeline(project_id: str, repo_url: str, all_projects_data: dict):
    """
    Runs the full intelligence pipeline, generates a report, and sends a Slack alert.
    """
    print(f"\n{'='*20} INTELLIGENCE BRIEFING: {project_id} {'='*20}")
    report = MarkdownReport(project_id, repo_url)

    # --- Phase 1: Anomaly Detection ---
    print("\n[Phase 1/6] 🔬 Calculating Anomaly Score...")
    anomaly_score = get_anomaly_scores(all_projects_data, project_id)
    report.add_anomaly_score(anomaly_score)

    # --- Phase 2: Causal Analysis ---
    print("\n[Phase 2/6] 🧠 Performing Causal Analysis...")
    commit_data = get_commit_history(repo_url, days_back=180)
    if not commit_data:
        print(f"--- Briefing Complete for {project_id}: No recent commit data. ---")
        report.save()
        return

    raw_commits_df = pd.DataFrame(commit_data, columns=['createdAt', 'author'])
    raw_commits_df['createdAt'] = pd.to_datetime(raw_commits_df['createdAt'], utc=True)
    daily_commits = raw_commits_df.set_index('createdAt').resample('D').size().reset_index(name='daily_commit_velocity')
    first_seen_df = raw_commits_df.groupby('author')['createdAt'].min().reset_index()
    daily_new_contributors = first_seen_df.set_index('createdAt').resample('D').size().reset_index(name='daily_new_contributors')
    analysis_df = pd.merge(daily_commits, daily_new_contributors, on='createdAt', how='outer').fillna(0)
    is_causal, p_value = discover_causality(analysis_df, 'daily_new_contributors', 'daily_commit_velocity')
    report.add_causal_analysis(is_causal, p_value)

    # --- Phase 3: Prediction ---
    print("\n[Phase 3/6] 📈 Generating Forecast...")
    INPUT_LEN, OUTPUT_LEN = 90, 30
    forecast_df = pd.DataFrame()
    forecast_list = []
    if len(analysis_df) >= INPUT_LEN:
        forecast_values = generate_forecast(
            data=analysis_df, target_column='daily_commit_velocity',
            input_seq_len=INPUT_LEN, output_seq_len=OUTPUT_LEN, epochs=150
        )
        last_date = analysis_df['createdAt'].iloc[-1]
        future_dates = pd.date_range(start=last_date + pd.Timedelta(days=1), periods=OUTPUT_LEN, freq='D')
        forecast_df = pd.DataFrame({
            'date': future_dates,
            'forecasted_commits': [max(0, int(round(val))) for val in forecast_values]
        })
        forecast_list = forecast_df['forecasted_commits'].head(7).tolist()
        print(f"  - Forecasted commits for the next 7 days: {forecast_list}")
    else:
        print("  - Not enough data to generate a forecast.")
    report.add_forecast(forecast_df)

    # --- Phase 4: Simulation ---
    print("\n[Phase 4/6] 🎲 Simulating Ecosystem Growth...")
    NUM_SIMULATIONS, SIMULATION_STEPS = 100, 50
    final_contributor_counts = []
    for _ in range(NUM_SIMULATIONS):
        model = StartupEcosystem(num_developers=200)
        for _ in range(SIMULATION_STEPS):
            model.step()
        final_contributor_counts.append(model.project.contributors)
    avg_contributors = sum(final_contributor_counts) / NUM_SIMULATIONS
    max_contributors = max(final_contributor_counts)
    report.add_simulation(avg_contributors, max_contributors)
    print(f"  - Monte Carlo Simulation: Average final contributors = {avg_contributors:.2f}")

    # --- Phase 5: Save Report ---
    print("\n[Phase 5/6] 📄 Saving Report...")
    report.save()
    
    # --- Phase 6: Send Notification ---
    print("\n[Phase 6/6] 📣 Sending Slack Notification...")
    send_slack_alert(
        project_id=project_id,
        repo_url=repo_url,
        anomaly_score=anomaly_score,
        is_causal=is_causal,
        p_value=p_value,
        forecast=forecast_list
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
            print(f"  - Analyzing history for: {project_id}")
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
            
            run_full_pipeline(
                project_id=project_id,
                repo_url=repo_url,
                all_projects_data=historical_data
            )
