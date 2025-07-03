# reporting/report_generator.py
import pandas as pd
from datetime import datetime
from pathlib import Path

class MarkdownReport:
    def __init__(self, project_id: str, repo_url: str):
        self.project_id = project_id
        self.repo_url = repo_url
        self.report_path = Path("reporting") / f"{project_id.replace('/', '_')}_briefing.md"
        self.sections = [
            f"# Intelligence Briefing: {project_id}\n",
            f"**[{repo_url}]({repo_url})**",
            f"**Report Generated**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
        ]

    def add_conviction_score(self, score: float):
        self.sections.append(f"## 🎯 Final Conviction Score: {score:.2f} / 1.0\n")

    def add_qualitative_score(self, score: float):
        self.sections.append("## 🤖 AI Readme Analysis")
        if score is not None:
            self.sections.append(f"> This project's documentation scored **{score:.2f} / 5.0** on our custom AI quality model.")
        else:
            self.sections.append("> Qualitative score could not be determined.")
        self.sections.append("\n")

    def add_anomaly_score(self, score: float):
        self.sections.append("## Anomaly Score")
        if score is not None:
            self.sections.append(f"> This project's activity has an anomaly score of **{score:.4f}** compared to its peers. A higher score indicates more unusual activity.")
        else:
            self.sections.append("> Anomaly score could not be calculated.")
        self.sections.append("\n")

    def add_causal_analysis(self, is_causal: bool, p_value: float):
        self.sections.append("## Causal Analysis: New Contributors vs. Commits")
        if is_causal is not None and p_value is not None:
            if is_causal:
                self.sections.append(f"> **Significant Causal Link Found** (p-value: {p_value:.4f}).")
            else:
                self.sections.append(f"> **No Significant Causal Link Found** (p-value: {p_value:.4f}).")
        else:
            self.sections.append("> Causal analysis could not be performed.")
        self.sections.append("\n")

    def add_forecast(self, forecast_df: pd.DataFrame):
        self.sections.append("## 30-Day Commit Velocity Forecast")
        if not forecast_df.empty:
            self.sections.append(forecast_df.to_markdown(index=False))
        else:
            self.sections.append("> Forecast could not be generated.")
        self.sections.append("\n")

    def add_simulation(self, avg_contributors: float, max_contributors: int, avg_peak_hype: float, avg_funding_events: float):
        self.sections.append("## 📈 Ecosystem Growth Simulation (Digital Twin)")
        self.sections.append(f"> A Monte Carlo simulation of 100 runs yielded:")
        self.sections.append(f"- **Average Final Contributors:** {avg_contributors:.2f}")
        self.sections.append(f"- **Maximum Final Contributors:** {max_contributors}")
        self.sections.append(f"- **Average Peak Hype Level:** {avg_peak_hype:.2%}")
        self.sections.append(f"- **Average Funding Events:** {avg_funding_events:.2f} per run")
        self.sections.append("\n")

    def save(self):
        self.report_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.report_path, 'w', encoding='utf-8') as f:
            f.write("\n".join(self.sections))
        print(f"✅ Intelligence briefing saved to: {self.report_path}")