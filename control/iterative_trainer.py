import torch
import argparse
import os
import time

from simulation.env import StartupSimEnv
from control.world_model import WorldModel
from control.value_function import ValueFunction
from control.mcts_planner import MCTSPlanner
from control.preprocess_data import preprocess_and_save
from control.train_world_model import train_world_model
from control.train_value_function import train_value_function

def generate_new_data(args, planner, env):
    """Uses the current best planner to generate a new batch of trajectories."""
    print(f"\n--- Generating {args.new_episodes_per_iteration} new trajectories with current planner ---")
    
    # Create a temporary directory for this iteration's data
    iteration_data_dir = os.path.join(args.self_play_dir, f"iteration_{args.current_iteration}")
    if not os.path.exists(iteration_data_dir):
        os.makedirs(iteration_data_dir)

    for i in range(args.new_episodes_per_iteration):
        print(f"Generating episode {i+1}/{args.new_episodes_per_iteration}...", end='\r')
        state = env.reset()
        done = False
        while not done:
            action_idx = planner.search(state, num_simulations=args.num_simulations)
            state, _, done, _ = env.step(env.action_space[action_idx])
            if env.env.now > args.max_ep_len:
                done = True
        
        episode_id = f"iter_{args.current_iteration}_ep_{i}.json"
        output_path = os.path.join(iteration_data_dir, episode_id)
        env.export_trajectory(output_path)

    print(f"\nGenerated {args.new_episodes_per_iteration} new trajectories in {iteration_data_dir}")
    return iteration_data_dir


def run_iteration(args):
    """Runs one full cycle of the Plan -> Generate -> Re-train loop."""
    print(f"\n{'='*60}\n--- Starting Self-Improvement Iteration {args.current_iteration} ---\n{'='*60}")
    
    # --- 1. Load current best models ---
    env = StartupSimEnv()
    env_config = {'state_dim': env.state_dim, 'action_dim': env.action_dim, 'state_keys': env.state_keys, 'action_space': env.action_space}
    
    world_model = WorldModel(state_dim=env.state_dim, act_dim=env.action_dim, hidden_size=64, n_layer=4, n_head=4)
    if os.path.exists(args.world_model_path):
        world_model.load_state_dict(torch.load(args.world_model_path))
    
    value_function = ValueFunction(state_dim=env.state_dim)
    if os.path.exists(args.value_function_path):
        value_function.load_state_dict(torch.load(args.value_function_path))

    scaling_params = torch.load(args.data_file)['scaling_params'] if os.path.exists(args.data_file) else None
    if scaling_params is None: # Failsafe for first run
        print("Warning: No scaling_params found. Using temporary ones. Re-run preprocess_data first.")
        scaling_params = {'min': torch.zeros(env.state_dim), 'range': torch.ones(env.state_dim)}

    planner = MCTSPlanner(world_model, value_function, env_config, scaling_params)

    # --- 2. Generate new data with the current planner ---
    new_data_dir = generate_new_data(args, planner, env)

    # --- 3. Re-process all data (expert + all self-play iterations) ---
    all_data_dirs = [args.expert_data_dir] + [os.path.join(args.self_play_dir, d) for d in os.listdir(args.self_play_dir)]
    preprocess_and_save(all_data_dirs, args.data_file)

    # --- 4. Re-train both models on the new, combined dataset ---
    print("\n--- Re-training World Model ---")
    train_world_model(args)
    print("\n--- Re-training Value Function ---")
    train_value_function(args)

    print(f"\n--- Iteration {args.current_iteration} Complete ---")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    # Paths
    parser.add_argument('--world_model_path', type=str, default='world_model_v1.pth')
    parser.add_argument('--value_function_path', type=str, default='value_function_v1.pth')
    parser.add_argument('--expert_data_dir', type=str, default='simulation/trajectories/')
    parser.add_argument('--self_play_dir', type=str, default='simulation/self_play_trajectories/')
    parser.add_argument('--data_file', type=str, default='radt_preprocessed_data.pt')
    
    # Loop Control
    parser.add_argument('--num_iterations', type=int, default=3) # Total self-improvement loops
    parser.add_argument('--new_episodes_per_iteration', type=int, default=10) # Number of new games to play each loop
    
    # MCTS Planner Config
    parser.add_argument('--num_simulations', type=int, default=50) # MCTS search depth
    parser.add_argument('--max_ep_len', type=int, default=365)
    
    # Training Config
    parser.add_argument('--epochs', type=int, default=10) # Fewer epochs for fine-tuning
    parser.add_argument('--batch_size', type=int, default=32)
    parser.add_argument('--lr', type=float, default=1e-4)
    parser.add_argument('--embed_dim', type=int, default=64)
    parser.add_argument('--n_layer', type=int, default=4)
    parser.add_argument('--n_head', type=int, default=4)
    
    args = parser.parse_args()

    # --- Run the main self-improvement loop ---
    for i in range(args.num_iterations):
        args.current_iteration = i + 1
        run_iteration(args)