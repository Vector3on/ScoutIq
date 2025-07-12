# simulation/generate_self_play.py
import os
import time
import torch
import argparse
from simulation.env import StartupSimEnv
from control.world_model import WorldModel
from control.value_function import ValueFunction
from control.mcts_planner import MCTSPlanner

def generate_self_play_data(args):
    """Uses the MCTS planner to generate a new dataset of trajectories."""
    
    # Create the output directory if it doesn't exist
    if not os.path.exists(args.output_dir):
        os.makedirs(args.output_dir)
        print(f"Created directory: {args.output_dir}")

    # --- Load all necessary components ---
    print("Loading models and initializing planner...")
    env_for_config = StartupSimEnv()
    env_config = {
        'state_dim': env_for_config.state_dim, 'action_dim': env_for_config.action_dim,
        'state_keys': env_for_config.state_keys, 'action_space': env_for_config.action_space
    }
    
    world_model = WorldModel(state_dim=env_config['state_dim'], act_dim=env_config['action_dim'], hidden_size=64, n_layer=4, n_head=4)
    world_model.load_state_dict(torch.load(args.world_model_path))
    
    value_function = ValueFunction(state_dim=env_config['state_dim'])
    value_function.load_state_dict(torch.load(args.value_function_path))
    
    # Assuming v2 data is the basis for the scaling params
    scaling_params = torch.load('radt_preprocessed_data_v2.pt')['scaling_params']
    
    planner = MCTSPlanner(
        world_model=world_model, value_function=value_function,
        env_config=env_config, scaling_params=scaling_params, rollout_depth=5
    )
    print("Planner initialized successfully.")

    # --- Generation Loop ---
    start_time = time.time()
    for i in range(args.num_episodes):
        print(f"--- Generating Self-Play Episode {i+1}/{args.num_episodes} ---", end='\r')
        
        # Use a new env for each episode to ensure a clean start
        env = StartupSimEnv(seed=int(time.time()) + i)
        state = env.reset()
        done = False
        
        while not done:
            action_idx = planner.search(state, num_simulations=args.num_simulations_per_step)
            action_name = env.action_space[action_idx]
            state, reward, done, info = env.step(action_name)
            
            if env.env.now > args.max_ep_len:
                done = True

        # Save the trajectory
        episode_id = f"selfplay_{int(time.time() * 1000)}_{i}.json"
        output_path = os.path.join(args.output_dir, episode_id)
        env.export_trajectory(output_path)

    end_time = time.time()
    print(f"\n\nGenerated {args.num_episodes} self-play trajectories in {end_time - start_time:.2f} seconds.")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--world_model_path', type=str, default='world_model_v2.pth')
    parser.add_argument('--value_function_path', type=str, default='value_function_v2.pth')
    parser.add_argument('--num_episodes', type=int, default=500)
    parser.add_argument('--num_simulations_per_step', type=int, default=50) # Fewer sims per step to speed up data generation
    parser.add_argument('--max_ep_len', type=int, default=365)
    parser.add_argument('--output_dir', type=str, default='simulation/self_play_trajectories/')
    args = parser.parse_args()
    generate_self_play_data(args)