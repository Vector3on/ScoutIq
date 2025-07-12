# control/evaluate_mcts.py
import torch
import numpy as np
import argparse
import json
from datetime import datetime

from simulation.env import StartupSimEnv
from control.world_model import WorldModel
from control.value_function import ValueFunction
from control.mcts_planner import MCTSPlanner

def evaluate_mcts_planner(args):
    print("--- Initializing MCTS Evaluation ---")
    
    env = StartupSimEnv(seed=args.eval_seed)
    initial_state = env.reset()
    
    # --- Load all necessary components ---
    env_config = {
        'state_dim': env.state_dim, 'action_dim': env.action_dim,
        'state_keys': env.state_keys, 'action_space': env.action_space
    }
    
    print(f"Loading models: {args.world_model_path}, {args.value_function_path}")
    world_model = WorldModel(state_dim=env.state_dim, act_dim=env.action_dim, hidden_size=64, n_layer=4, n_head=4)
    world_model.load_state_dict(torch.load(args.world_model_path))
    
    value_function = ValueFunction(state_dim=env.state_dim)
    value_function.load_state_dict(torch.load(args.value_function_path))
    
    print(f"Loading scaling parameters from: {args.data_file}")
    scaling_params = torch.load(args.data_file)['scaling_params']
    
    # --- Instantiate the planner(s) ---
    deep_planner = MCTSPlanner(
        world_model=world_model, value_function=value_function,
        env_config=env_config, scaling_params=scaling_params, rollout_depth=5
    )
    
    # If comparing, create a second, "myopic" planner
    if args.compare_rollouts:
        print("Initializing myopic planner for comparison (rollout_depth=0)")
        myopic_planner = MCTSPlanner(
            world_model=world_model, value_function=value_function,
            env_config=env_config, scaling_params=scaling_params, rollout_depth=0
        )

    print("\n--- Starting Autonomous Run ---")
    state = initial_state
    done = False
    value_log = []
    
    while not done:
        # Get the action from our main deep planner
        best_action_index = deep_planner.search(state, num_simulations=args.num_simulations)
        action_name = env.action_space[best_action_index]
        
        log_line = f"[Day {env.env.now:3}] Planner chose action: {action_name}"

        # If comparing, get the myopic planner's choice and log the comparison
        if args.compare_rollouts:
            myopic_action_index = myopic_planner.search(state, num_simulations=args.num_simulations)
            myopic_action_name = env.action_space[myopic_action_index]
            if action_name != myopic_action_name:
                log_line += f" (Myopic planner would have chosen: {myopic_action_name})"
        
        print(log_line)

        # Log latent value attribution if enabled
        if args.log_values:
            norm_state = deep_planner._normalize_state(state)
            with torch.no_grad():
                value = value_function(norm_state.unsqueeze(0)).item()
            value_log.append({
                "day": env.env.now,
                "estimated_value": value,
                "capital": state['capital'],
                "team_size": state['team_size'],
                "product_progress": state['product_progress'],
                "market_traction": state['market_traction'],
                "founder_burnout": state['founder_burnout']
            })
            
        state, reward, done, info = env.step(action_name)
        
        if env.env.now > args.max_ep_len:
            print("Max episode length reached.")
            done = True

    print("\n--- Final Evaluation Complete ---")
    print(f"Final Day: {env.env.now}")
    print(f"Achievements Unlocked: {env.unlocked_achievements or 'None'}")
    print("Final State:")
    for key, value in env.get_state().items():
        print(f"  {key:<25}: {value:.2f}")

    # Save the value log to a file
    if args.log_values:
        log_filename = f"value_log_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(log_filename, 'w') as f:
            json.dump(value_log, f, indent=2)
        print(f"\nValue attribution log saved to: {log_filename}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data_file', type=str, default='radt_preprocessed_data_v2.pt')
    parser.add_argument('--world_model_path', type=str, default='world_model_v2.pth')
    parser.add_argument('--value_function_path', type=str, default='value_function_v2.pth')
    parser.add_argument('--num_simulations', type=int, default=100)
    parser.add_argument('--max_ep_len', type=int, default=365)
    parser.add_argument('--eval_seed', type=int, default=42)
    # NEW FLAGS FOR OBSERVABILITY
    parser.add_argument('--log_values', action='store_true', help="Enable logging of latent value attribution.")
    parser.add_argument('--compare_rollouts', action='store_true', help="Log a comparison between deep and myopic planners.")
    args = parser.parse_args()
    evaluate_mcts_planner(args)