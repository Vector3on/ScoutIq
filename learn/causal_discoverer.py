# learn/causal_discoverer.py
import pandas as pd
from statsmodels.tsa.stattools import grangercausalitytests

def discover_causality(data: pd.DataFrame, var1: str, var2: str, max_lag: int = 5):
    """
    Performs a Granger Causality test using the statsmodels library.
    Includes guardrails for short time series and constant data.
    """
    print(f"\n🔬 Testing if '{var1}' Granger-causes '{var2}'...")
    
    test_data = data[[var2, var1]]
    
    # Check if the causal variable is constant (has no variance).
    if test_data[var1].nunique() <= 1:
        print(f" - ⚠️ WARN: Skipping Granger causality because the input series '{var1}' is constant.")
        return None, None

    # Check if there is enough data for the given lag.
    if len(test_data) < (max_lag * 2):
        print(f" - ⚠️ WARN: Insufficient data for Granger causality test (found {len(test_data)} data points, need > {max_lag * 2}). Skipping.")
        return None, None
        
    try:
        results = grangercausalitytests(test_data, maxlag=max_lag, verbose=False)
        # Get the p-value for the final lag
        p_value = results[max_lag][0]['ssr_ftest'][1]
        is_causal = p_value < 0.05
        
        if is_causal:
            print(f" - ✅ Result: Found significant causal link (p-value: {p_value:.4f})")
        else:
            print(f" - ❌ Result: No significant causal link found (p-value: {p_value:.4f})")
            
        return is_causal, p_value
        
    except Exception as e:
        print(f" - ❌ ERROR: Granger causality test failed. Reason: {e}")
        return None, None