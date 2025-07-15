import torch
import numpy as np
import argparse
import json
import os

# --- NEW: RewardShaper class is now defined directly inside this script ---
class RewardShaper:
    def __init__(self, gamma=0.99, weights=None):
        self.gamma = gamma
        self.weights = weights if weights is not None else {
            "potential_survival": 1.0, "potential_growth": 0.5,
            "potential_efficiency": 0.3, "potential_sustainability": 0.4
        }
    def potential(self, state):
        capital = state.get('capital', 0)
        product_progress = state.get('product_progress', 0)
        team_size = state.get('team_size', 1)
        burn_rate = (team_size * 7000)
        phi_survival = self.weights["potential_survival"] * np.log(capital + 1e-9)
        phi_growth = self.weights["potential_growth"] * product_progress
        phi_efficiency = self.weights["potential_efficiency"] * (product_progress / (team_size + 1e-9))
        phi_sustainability = -self.weights["potential_sustainability"] * (burn_rate / (capital + 1e-9))
        return phi_survival + phi_growth + phi_efficiency + phi_sustainability
    def calculate_shaped_reward(self, state, next_state, done):
        base_reward = 0.0
        if done and next_state.get('capital', 0) <= 0:
            base_reward = -100.0
        base_reward += (next_state.get('product_progress', 0) - state.get('product_progress', 0))
        potential_current = self.potential(state)
        potential_next = self.potential(next_state)
        if done:
            potential_next = 0
        shaping_reward = (self.gamma * potential_next) - potential_current
        return base_reward + shaping_reward
# --- END NEW ---

def process_dagger_data(input_file, output_path):
    print(f"--- Processing DAgger data from '{input_file}' ---")
    try:
        with open(input_file, 'r') as f:
            dagger_data = json.load(f)
    except FileNotFoundError:
        print(f"ERROR: Could not find '{input_file}'. Please upload it to /content/ScoutIq/")
        return
    if not dagger_data:
        print("Error: DAgger data file is empty.")
        return

    action_map = {
        "hire_engineer": 0, "run_marketing_campaign": 1, "seek_funding": 2,
        "refactor_codebase": 3, "team_building_offsite": 4, "rest": 5, "wait": 6,
        "crunch_mode": 6
    }
    reward_shaper = RewardShaper()

    state_keys = list(dagger_data[0]['state'].keys())
    observations = np.array([[item['state'].get(key, 0) for key in state_keys] for item in dagger_data])
    actions = np.array([action_map.get(item['expert_action'], 6) for item in dagger_data])

    rewards = []
    for i in range(len(dagger_data)):
        state = dagger_data[i]['state']
        next_state = dagger_data[i+1]['state'] if i + 1 < len(dagger_data) else state
        done = next_state.get('done', False)
        reward = reward_shaper.calculate_shaped_reward(state, next_state, done)
        rewards.append(reward)
    rewards = np.array(rewards)

    rtgs = np.zeros_like(rewards, dtype=float)
    cumulative_reward = 0
    for t in reversed(range(len(rewards))):
        cumulative_reward += rewards[t]
        rtgs[t] = cumulative_reward

    processed_trajectory = {
        'observations_np': observations,
        'actions_np': actions,
        'rtgs_np': rtgs,
    }

    print(f"Processed {len(dagger_data)} expert data points.")
    with open(output_path, 'wb') as f:
        torch.save([processed_trajectory], f)
    print(f"Saved processed DAgger trajectory data to '{output_path}'")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--input_file', type=str, default='dareal.json')
    parser.add_argument('--output_path', type=str, default='dt_dagger_v13.pt')
    args = parser.parse_args()
    process_dagger_data(args.input_file, args.output_path)
