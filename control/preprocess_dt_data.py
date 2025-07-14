import torch
import numpy as np
import argparse
import json
import os
import random

def process_trajectories(input_dir, output_path, max_trajectories=None):
    """
    Loads raw JSON trajectories, calculates returns-to-go, and saves them
    in a format suitable for the Decision Transformer.
    """
    print(f"--- Processing trajectories from '{input_dir}' ---")
    
    trajectory_files = [f for f in os.listdir(input_dir) if f.endswith('.json')]
    if max_trajectories:
        trajectory_files = trajectory_files[:max_trajectories]

    all_trajectories = []
    state_dim = None
    action_map = {
        "hire_engineer": 0, "run_marketing_campaign": 1, "seek_funding": 2,
        "refactor_codebase": 3, "team_building_offsite": 4, "rest": 5, "wait": 6
    }

    for filename in trajectory_files:
        filepath = os.path.join(input_dir, filename)
        with open(filepath, 'r') as f:
            history = json.load(f)

        step_data = [item for item in history if item.get('type') == 'step_data']
        if not step_data:
            continue

        # Extract sequences
        observations_list = []
        # Infer state keys from the first entry to maintain order
        state_keys = [k for k in step_data[0]['state'].keys() if k not in ['done', 'delta_progress', 'delta_traction']]
        if state_dim is None:
            state_dim = len(state_keys)
        
        for item in step_data:
            state_vector = [item['state'][key] for key in state_keys]
            observations_list.append(state_vector)

        observations = np.array(observations_list)
        actions = np.array([action_map.get(item['action'], 6) for item in step_data]) # Default to 'wait'
        rewards = np.array([item['reward'] for item in step_data])
        
        # Calculate returns-to-go (RTG)
        rtgs = np.zeros_like(rewards, dtype=float)
        cumulative_reward = 0
        for t in reversed(range(len(rewards))):
            cumulative_reward += rewards[t]
            rtgs[t] = cumulative_reward

        all_trajectories.append({
            'observations_np': observations,
            'actions_np': actions,
            'rtgs_np': rtgs,
        })
    
    print(f"Processed {len(all_trajectories)} trajectories.")
    
    # Save the processed data
    with open(output_path, 'wb') as f:
        torch.save(all_trajectories, f)
        
    print(f"Saved processed trajectory data to '{output_path}'")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--input_dir', type=str, default='simulation/self_play_trajectories_v9/')
    parser.add_argument('--output_path', type=str, default='dt_trajectories_v9.pt')
    args = parser.parse_args()
    process_trajectories(args.input_dir, args.output_path)