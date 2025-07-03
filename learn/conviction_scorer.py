# learn/conviction_scorer.py
import numpy as np

# Define the weights for each signal. These can be tuned over time.
# They should sum to 1.0
WEIGHTS = {
    "qualitative": 0.35,  # The score from our custom AI model
    "anomaly": 0.25,      # How unusual the project's activity is
    "simulation": 0.20,   # The project's potential for community growth
    "causality": 0.10,    # If new contributors lead to more commits
    "forecast": 0.10      # The predicted momentum
}

def _normalize(value, min_val, max_val):
    """Normalize a value to a 0-1 scale."""
    if value is None:
        return 0
    return max(0, min(1, (value - min_val) / (max_val - min_val)))

def calculate_conviction_score(**kwargs) -> float:
    """
    Calculates a final conviction score from all pipeline signals.
    """
    print("\n[Phase 5/6] Calculating Final Conviction Score...")

    # Normalize each signal to a 0-1 score
    s_qualitative = _normalize(kwargs.get('qualitative_score'), 1, 5)
    s_anomaly = _normalize(kwargs.get('anomaly_score'), 0, 1) # Assumes anomaly is already 0-1
    
    # For simulation, score based on average contributors (cap at 200 for normalization)
    s_simulation = _normalize(kwargs.get('avg_contributors'), 0, 200)

    # For causality, score is 1 if causal, 0 otherwise.
    s_causality = 1.0 if kwargs.get('is_causal') else 0.0
    
    # For forecast, score based on the sum of commits in the next 7 days
    forecast_sum = sum(kwargs.get('forecast_list', []))
    s_forecast = _normalize(forecast_sum, 0, 50) # Normalize against a max of 50 commits/week

    # Calculate the weighted average
    final_score = (
        s_qualitative * WEIGHTS["qualitative"] +
        s_anomaly * WEIGHTS["anomaly"] +
        s_simulation * WEIGHTS["simulation"] +
        s_causality * WEIGHTS["causality"] +
        s_forecast * WEIGHTS["forecast"]
    )
    
    print(f" - ✅ Final Conviction Score: {final_score:.4f}")
    return final_score