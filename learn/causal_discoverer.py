# learn/causal_discoverer.py
import pandas as pd
from statsmodels.tsa.stattools import grangercausalitytests
import numpy as np

def discover_causality(data: pd.DataFrame, var1: str, var2: str, max_lag: int = 5):
    """
    Performs a Granger Causality test using the statsmodels library.
    Includes a guardrail to prevent errors on short time series.
    """
    print(f"\n🔬 Testing if '{var1}' Granger-causes '{var2}'...")
    
    test_data = data[[var2, var1]]
    
    # --- THIS IS THE FIX ---
    # Check if we have enough data to perform the test with the given lag.
    # The test needs more data points than twice the lag number.
    if len(test_data) < (max_lag * 2):
        print(f"  - ⚠️ WARN: Insufficient data for Granger causality test (found {len(test_data)} data points, need > {max_lag * 2}). Skipping.")
        return None, None
    # --- END FIX ---
        
    try:
        results = grangercausalitytests(test_data, maxlag=max_lag, verbose=False)
        p_value = results[max_lag][0]['ssr_ftest'][1]
        is_causal = p_value < 0.05
        
        if is_causal:
            print(f"  - ✅ Result: Found significant causal link (p-value: {p_value:.4f})")
        else:
            print(f"  - ❌ Result: No significant causal link found (p-value: {p_value:.4f})")
            
        return is_causal, p_value
    except Exception as e:
        print(f"  - ❌ ERROR: Granger causality test failed. Reason: {e}")
        return None, None

if __name__ == '__main__':
    # --- Example Usage (remains the same) ---
    dates = pd.to_datetime(pd.date_range(start='2024-01-01', periods=100, freq='D'))
    contributors = np.random.randint(0, 3, 100)
    commits = np.zeros(100)
    
    for i in range(1, 100):
        commits[i] = max(0, commits[i-1] * 0.5 + contributors[i-2] * 5 + np.random.randint(-1, 2))
        
    mock_df = pd.DataFrame({'date': dates, 'new_contributors': contributors, 'commits': commits})
    
    print("--- Running Causal Discovery Example ---")
    
    discover_causality(mock_df, 'new_contributors', 'commits', max_lag=5)
    discover_causality(mock_df, 'commits', 'new_contributors', max_lag=5)
