import torch
import numpy as np
import argparse

from simulation.env import StartupSimEnv
from control.world_model import WorldModel

def score_predicted_state(state_vec, state_keys):
    """A simple heuristic to score the desirability of a predicted state."""
    # We want high progress and traction, and low burnout and debt.
    score = (state_vec[state_keys.index('product_progress')] + 
             state_vec[state_keys.index('market_traction')] -
             state_vec[state_keys.index('founder_burnout')] - 
             state_vec[state_keys.index('technical_debt')])
    return score

def plan_and_evaluate(args):
    print("--- Initializing Evaluation (World Model Planner) ---")
    
    env = StartupSimEnv(seed=args.eval_seed)
    current_state_dict = env.reset()
    
    # Load the trained World Model
    state_dim, action_dim = env.state_dim, env.action_dim
    world_model = WorldModel(
        state_dim=state_dim, act_dim=action_dim, hidden_size=args.embed_dim,
        n_layer=args.n_layer, n_head=args.n_head
    )
    world_model.load_state_dict(torch.load(args.model_path))
    world_model.eval()
    print(f"World Model weights loaded from {args.model_path}")

    # Load the normalization parameters
    scaling_params = torch.load('radt_preprocessed_data.pt')['scaling_params']
    min_vals = scaling_params['min']
    range_vals = scaling_params['range']

    print("\n--- Starting Autonomous Planning Run ---")
    for t in range(args.max_ep_len):
        
        # --- The Planning Loop ---
        possible_next_states = []
        # 1. For every possible action...
        for i, action_name in enumerate(env.action_space):
            # Normalize the current state for the model
            current_state_vec = torch.tensor(list(current_state_dict.values()), dtype=torch.float32)
            normalized_state = (current_state_vec - min_vals) / range_vals
            
            # Prepare inputs for the World Model
            input_state = normalized_state.unsqueeze(0).unsqueeze(0) # (1, 1, state_dim)
            input_action = torch.tensor([[i]]) # (1, 1)

            # 2. Use the World Model to predict the future
            with torch.no_grad():
                predicted_normalized_next_state = world_model.forward(input_state, input_action)
            
            possible_next_states.append(predicted_normalized_next_state.squeeze())

        # 3. Evaluate which predicted future is best
        scores = [score_predicted_state(s, env.state_keys) for s in possible_next_states]
        best_action_idx = np.argmax(scores)
        best_action_name = env.action_space[best_action_idx]

        print(f"[Day {env.env.now:3}] Planner chose action: {best_action_name} (Predicted Score: {scores[best_action_idx]:.2f})")
        
        # 4. Take the best action in the *real* simulation
        current_state_dict, reward, done, info = env.step(best_action_name)
        
        if done:
            break

    print("\n--- Evaluation Complete ---")
    print(f"Final Day: {env.env.now}")
    print("Final State:")
    for key, value in env.get_state().items():
        print(f"  {key:<25}: {value:.2f}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model_path', type=str, default='world_model_v1.pth')
    parser.add_argument('--embed_dim', type=int, default=64)
    parser.add_argument('--n_layer', type=int, default=4)
    parser.add_argument('--n_head', type=int, default=4)
    parser.add_argument('--eval_seed', type=int, default=42)
    parser.add_argument('--max_ep_len', type=int, default=200)
    args = parser.parse_args()
    plan_and_evaluate(args)