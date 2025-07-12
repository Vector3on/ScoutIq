import torch
from torch.nn.utils.rnn import pad_sequence
import os
import json
import numpy as np
import argparse
from typing import List

def parse_trajectories(trajectories_dirs: List[str]):
    all_states, all_actions, all_rewards = [], [], []
    state_keys = [
        "capital", "team_size", "product_progress", "market_traction", "founder_burnout", 
        "team_alignment", "technical_debt", "investor_interest", "hiring_market_strength", "competitive_pressure"
    ]
    action_space = [
        "hire_engineer", "run_marketing_campaign", "seek_funding", "refactor_codebase", 
        "team_building_offsite", "rest", "wait"
    ]
    file_list = []
    for directory in trajectories_dirs:
        if os.path.exists(directory):
            file_list.extend([os.path.join(directory, f) for f in os.listdir(directory) if f.endswith('.json')])
    for i, filepath in enumerate(file_list):
        print(f"Parsing trajectory {i+1}/{len(file_list)}...", end='\r')
        with open(filepath, 'r') as f: full_log = json.load(f)
        steps = [entry for entry in full_log if entry.get('type') == 'step_data']
        if not steps: continue
        states, actions, rewards = [], [], []
        for step in steps:
            states.append([step['state'][key] for key in state_keys])
            actions.append(action_space.index(step['action']))
            rewards.append(step['reward'])
        all_states.append(torch.from_numpy(np.array(states, dtype=np.float32)))
        all_actions.append(torch.from_numpy(np.array(actions, dtype=np.int64)))
        all_rewards.append(torch.from_numpy(np.array(rewards, dtype=np.float32)))
    print(f"\nParsing complete. Found {len(all_states)} valid trajectories.")
    return all_states, all_actions, all_rewards, state_keys

def preprocess_and_save(data_dirs, output_file):
    print("--- Starting Data Pre-processing ---")
    states, actions, rewards, state_keys = parse_trajectories(data_dirs)
    if not states: print("No valid trajectories found to process."); return
    full_states_tensor = torch.cat(states, dim=0)
    min_vals, _ = torch.min(full_states_tensor, dim=0)
    max_vals, _ = torch.max(full_states_tensor, dim=0)
    scaling_range = max_vals - min_vals + 1e-6 
    normalized_states = [((s - min_vals) / scaling_range) for s in states]
    scaling_params = {"min": min_vals, "range": scaling_range, "keys": state_keys}
    print("Data normalized successfully.")
    all_data = {'states': normalized_states, 'actions': actions, 'returns_to_go': [], 'goal': [], 'avoid': [], 'scaling_params': scaling_params}
    for i in range(len(states)):
        returns_to_go = torch.zeros_like(rewards[i])
        running_return = 0
        for t in reversed(range(len(rewards[i]))):
            running_return += rewards[i][t]
            returns_to_go[t] = running_return
        all_data['returns_to_go'].append(returns_to_go.unsqueeze(1))
        all_data['goal'].append((states[i][-1] - min_vals) / scaling_range)
        capital_values = states[i][:, 0]
        lowest_capital_idx = torch.argmin(capital_values)
        all_data['avoid'].append((states[i][lowest_capital_idx] - min_vals) / scaling_range)
    max_len = max(len(s) for s in all_data['states'])
    print(f"Found max sequence length: {max_len}")
    all_data['states'] = pad_sequence(all_data['states'], batch_first=True, padding_value=0)
    all_data['actions'] = pad_sequence(all_data['actions'], batch_first=True, padding_value=0)
    all_data['returns_to_go'] = pad_sequence(all_data['returns_to_go'], batch_first=True, padding_value=0)
    all_data['goal'] = torch.stack(all_data['goal'])
    all_data['avoid'] = torch.stack(all_data['avoid'])
    print(f"Saving pre-processed and normalized data to {output_file}...")
    torch.save(all_data, output_file)
    print("--- Pre-processing Complete ---")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data_dirs', nargs='+', default=['simulation/trajectories/', 'simulation/self_play_trajectories/'])
    parser.add_argument('--output_file', type=str, default='radt_preprocessed_data.pt')
    args = parser.parse_args()
    preprocess_and_save(args.data_dirs, args.output_file)