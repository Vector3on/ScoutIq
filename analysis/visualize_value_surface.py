# analysis/visualize_value_surface.py
import torch
import numpy as np
import seaborn as sns
import matplotlib.pyplot as plt
import pandas as pd
import argparse
import sys
from pathlib import Path

# Add project root to sys.path to allow imports
sys.path.append(str(Path(__file__).resolve().parent.parent))
from control.value_function import ValueFunction

def visualize_surface(args):
    print("--- Visualizing Value Surface ---")

    # --- Load Model and Scaling Parameters ---
    print(f"Loading value function from: {args.value_function_path}")
    value_function = ValueFunction(state_dim=10)
    value_function.load_state_dict(torch.load(args.value_function_path))
    value_function.eval()

    print(f"Loading scaling parameters from: {args.data_file}")
    scaling_params = torch.load(args.data_file)['scaling_params']
    state_keys = scaling_params['keys']
    min_vals = scaling_params['min']
    scaling_range = scaling_params['range']

    # --- Create a Grid for Visualization ---
    # We will vary 'capital' and 'product_progress' while keeping others at a "typical" value
    capital_steps = 50
    progress_steps = 50
    
    # Create a base state vector with typical/average values
    base_state = {key: min_vals[i] + (scaling_range[i] * 0.5) for i, key in enumerate(state_keys)}
    base_state['team_size'] = 3.0
    base_state['founder_burnout'] = 20.0
    base_state['technical_debt'] = 20.0
    
    capital_range = np.linspace(min_vals[state_keys.index('capital')], min_vals[state_keys.index('capital')] + scaling_range[state_keys.index('capital')], capital_steps)
    progress_range = np.linspace(min_vals[state_keys.index('product_progress')], 100, progress_steps)

    value_grid = np.zeros((progress_steps, capital_steps))

    # --- Evaluate Value Function over the Grid ---
    print("Evaluating value function over state grid...")
    for i, progress in enumerate(progress_range):
        for j, capital in enumerate(capital_range):
            temp_state_dict = base_state.copy()
            temp_state_dict['capital'] = capital
            temp_state_dict['product_progress'] = progress

            state_vec = torch.tensor([temp_state_dict[key] for key in state_keys], dtype=torch.float32)
            norm_state_vec = (state_vec - min_vals) / scaling_range
            
            with torch.no_grad():
                value = value_function(norm_state_vec.unsqueeze(0)).item()
            value_grid[i, j] = value
            
    # --- Plot the Heatmap ---
    df = pd.DataFrame(value_grid, 
                      index=[int(p) for p in progress_range], 
                      columns=[f"${int(c/1000)}k" for c in capital_range])

    plt.figure(figsize=(16, 12))
    sns.heatmap(df, annot=False, cmap="viridis", cbar_kws={'label': 'Estimated State Value'})
    plt.title('Value Function Surface', fontsize=20)
    plt.xlabel('Capital', fontsize=16)
    plt.ylabel('Product Progress (%)', fontsize=16)
    
    output_path = "value_surface_heatmap.png"
    plt.savefig(output_path)
    print(f"\n--- Heatmap saved to: {output_path} ---")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data_file', type=str, default='radt_preprocessed_data_v2.pt')
    parser.add_argument('--value_function_path', type=str, default='value_function_v2.pth')
    args = parser.parse_args()
    visualize_surface(args)