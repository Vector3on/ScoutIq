import json
import pandas as pd
import argparse
import logging

# This script requires libraries listed in your requirements.txt:
# pandas, dowhy, graphviz
try:
    from dowhy import CausalModel
except ImportError:
    print("Warning: 'dowhy' is not installed. This script requires it to function.")
    print("Please run 'pip install dowhy' when the main process is complete.")

# Suppress excessive logging from the library
logging.getLogger("dowhy").setLevel(logging.WARNING)

def build_causal_graph(trajectory_path: str, output_path: str):
    """
    Analyzes an agent's trajectory to infer a causal graph of its decisions.
    """
    print(f"--- Building Causal Graph from '{trajectory_path}' ---")
    try:
        with open(trajectory_path, 'r') as f:
            history = json.load(f)
    except FileNotFoundError:
        print(f"Error: Trajectory file not found at {trajectory_path}")
        return

    step_data = [item for item in history if item.get('type') == 'step_data']
    if not step_data:
        print("No 'step_data' found in trajectory. Cannot build graph.")
        return

    records = [entry['state'] for entry in step_data]
    df = pd.DataFrame(records)

    # A simplified causal graph definition based on the simulation's logic.
    # This graph hypothesizes that the core state variables influence the agent's
    # choice of action, which in turn influences the reward.
    causal_graph_dot = """
    digraph {
        capital -> reward;
        market_traction -> reward;
        product_progress -> reward;
        founder_burnout -> reward;
    }
    """

    print("Initializing CausalModel...")
    model = CausalModel(
        data=df,
        graph=causal_graph_dot.replace('\\n', ''),
        treatment='capital', # Example: let's see how capital affects reward
        outcome='reward'
    )

    model.view_model(file_name=output_path)
    print(f"\n--- Causal graph visualization saved to {output_path}.png ---")
    print("Note: This is a structural model. Further analysis would estimate causal effects.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build and visualize a causal graph from an agent trajectory.")
    parser.add_argument('--trajectory_path', type=str, required=True, help='Path to the simulation trajectory JSON file.')
    parser.add_argument('--output_path', type=str, default='analysis_outputs/causal_graph', help='Path to save the output graph file (without extension).')
    args = parser.parse_args()

    # Create output directory if it doesn't exist
    os.makedirs(os.path.dirname(args.output_path), exist_ok=True)
    build_causal_graph(args.trajectory_path, args.output_path)