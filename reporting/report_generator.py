# reporting/report_generator.py
import pandas as pd
from datetime import datetime
from pathlib import Path

class MarkdownReport:
    """
    Generates a Markdown intelligence briefing for a single project.
    """
    def __init__(self, project_id: str, repo_url: str):
        self.project_id = project_id
        self.repo_url = repo_url
        self.report_path = Path("reporting") / f"{project_id.replace('/', '_')}_briefing.md"
        self.sections = [f"# 📈 Intelligence Briefing: {project_id}\n"]
        self.sections.append(f"**Repository:** [{repo_url}]({repo_url})")
        self.sections.append(f"**Report Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

    def add_anomaly_score(self, score: float):
        """Adds the anomaly detection results to the report."""
        if score is not None:
            self.sections.append("## 🔬 Anomaly Score")
            self.sections.append(f"> This project's activity has an anomaly score of **{score:.4f}** compared to its peers. A higher score indicates more unusual activity.")
        else:
            self.sections.append("> Anomaly score could not be calculated.")
        self.sections.append("\n")

    def add_causal_analysis(self, is_causal: bool, p_value: float):
        """Adds the causal analysis results to the report."""
        self.sections.append("## 🧠 Causal Analysis: New Contributors vs. Commits")
        if is_causal is not None and p_value is not None:
            if is_causal:
                self.sections.append(f"> ✅ **Significant Causal Link Found** (p-value: {p_value:.4f}). An increase in new contributors is a statistically significant predictor of an increase in commit activity.")
            else:
                self.sections.append(f"> ❌ **No Significant Causal Link Found** (p-value: {p_value:.4f}). The data does not suggest that new contributors directly cause a change in commit velocity.")
        else:
            self.sections.append("> Causal analysis could not be performed (likely due to insufficient data).")
        self.sections.append("\n")

    def add_forecast(self, forecast_df: pd.DataFrame):
        """Adds the commit velocity forecast to the report."""
        self.sections.append("## 📈 30-Day Commit Velocity Forecast")
        if not forecast_df.empty:
            # Convert DataFrame to Markdown table
            self.sections.append(forecast_df.to_markdown(index=False))
        else:
            self.sections.append("> Forecast could not be generated.")
        self.sections.append("\n")

    def add_simulation(self, avg_contributors: float, max_contributors: int):
        """Adds the agent-based simulation results to the report."""
        self.sections.append("## 🎲 Ecosystem Growth Simulation")
        self.sections.append(f"> A Monte Carlo simulation of 100 runs, each simulating 50 days of growth in an ecosystem of 200 potential developers, yielded:")
        self.sections.append(f"- **Average Final Contributors:** {avg_contributors:.2f}")
        self.sections.append(f"- **Maximum Final Contributors:** {max_contributors}")
        self.sections.append("\n")

    def save(self):
        """Saves the completed report to a Markdown file."""
        with open(self.report_path, 'w', encoding='utf-8') as f:
            f.write("\n".join(self.sections))
        print(f"  - ✅ Intelligence briefing saved to: {self.report_path}")

