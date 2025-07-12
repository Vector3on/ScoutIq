import torch
import numpy as np
import argparse

from simulation.env import StartupSimEnv
from control.radt_model import ReachAvoidDecisionTransformer

def get_goal_vector(goal_dict, all_keys):
    """Converts a dictionary of goals into a state vector."""
    goal_vec = torch.zeros(len(all_keys))
    for i, key in enumerate(all_keys):
        if key in goal_dict:
            goal_vec[i] = goal_dict[key]
    return goal_vec.unsqueeze(0)

def evaluate(args):
    print("--- Initializing Evaluation (Superbrain v2) ---")
    
    env = StartupSimEnv(seed=args.eval_seed)
    state = env.reset()
    
    state_dim, action_dim, max_ep_len = 10, 7, 200
    model = ReachAvoidDecisionTransformer(
        state_dim=state_dim, act_dim=action_dim, hidden_size=args.embed_dim,
        max_length=max_ep_len, n_layer=args.n_layer, n_head=args.n_head,
        n_inner=4*args.embed_dim
    )
    model.load_state_dict(torch.load(args.model_path))
    model.eval()
    print(f"Model weights loaded from {args.model_path}")

    # --- Define Evaluation Prompts ---
    strategic_roadmap = [
        {"goal_name": "Hire First Engineer", "criteria": lambda s: s["team_size"] >= 2, "vector": {"team_size": 2}},
        {"goal_name": "Build MVP", "criteria": lambda s: s["product_progress"] >= 50, "vector": {"product_progress": 50}},
        {"goal_name": "Get First Users", "criteria": lambda s: s["market_traction"] >= 10, "vector": {"market_traction": 10}},
        {"goal_name": "Achieve PMF", "criteria": lambda s: s["market_traction"] >= 50, "vector": {"market_traction": 50, "product_progress": 90}}
    ]
    # We will command the agent to avoid a state of near-bankruptcy
    avoid_prompt = {"capital": 1000}
    avoid_vec = get_goal_vector(avoid_prompt, env.state_keys)
    current_goal_idx = 0
    
    done = False
    episode_reward = 0
    states = torch.zeros(1, max_ep_len, state_dim)
    actions = torch.zeros(1, max_ep_len, 1, dtype=torch.long)
    returns_to_go = torch.zeros(1, max_ep_len, 1)
    timesteps = torch.zeros(1, max_ep_len, dtype=torch.long)
    
    states[:, 0] = torch.from_numpy(np.array(list(state.values())))
    returns_to_go[:, 0] = torch.tensor(args.target_rtg)

    print(f"Evaluation Goal: Follow Strategic Roadmap")
    print(f"Evaluation Avoid Condition: Avoid Capital < 1000")
    print("\n--- Starting Autonomous Run ---")

    for t in range(max_ep_len):
        if current_goal_idx < len(strategic_roadmap) and strategic_roadmap[current_goal_idx]["criteria"](state):
            print(f"--- STRATEGIC GOAL MET: {strategic_roadmap[current_goal_idx]['goal_name']} ---")
            current_goal_idx += 1
            if current_goal_idx < len(strategic_roadmap):
                 print(f"--- NEW STRATEGIC GOAL: {strategic_roadmap[current_goal_idx]['goal_name']} ---")

        current_goal_dict = strategic_roadmap[current_goal_idx]["vector"]
        goal_vec = get_goal_vector(current_goal_dict, env.state_keys)
        
        with torch.no_grad():
            action_preds = model.forward(
                states[:, :t+1], actions[:, :t+1], returns_to_go[:, :t+1],
                timesteps[:, :t+1], goal_vec, avoid_vec
            )
        
        predicted_action_idx = torch.argmax(action_preds[0, t]).item()
        action_name = env.action_space[predicted_action_idx]
        
        print(f"[Day {env.env.now:3}] Agent chose action: {action_name}")
        state, reward, done, info = env.step(action_name)
        
        if t < max_ep_len - 1:
            actions[:, t+1] = predicted_action_idx
            states[:, t+1] = torch.from_numpy(np.array(list(state.values())))
            returns_to_go[:, t+1] = returns_to_go[0, t] - reward
            timesteps[:, t+1] = t + 1
        
        episode_reward += reward

        if done:
            break

    print("\n--- Evaluation Complete ---")
    print(f"Final Day: {env.env.now}")
    print(f"Total Reward (Achievements Score): {episode_reward}")
    print("Final State:")
    for key, value in env.get_state().items():
        print(f"  {key:<25}: {value:.2f}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model_path', type=str, default='radt_superbrain_v2.pth') # Load the v2 model
    parser.add_argument('--embed_dim', type=int, default=64)
    parser.add_argument('--n_layer', type=int, default=4)
    parser.add_argument('--n_head', type=int, default=4)
    parser.add_argument('--target_rtg', type=float, default=20.0)
    parser.add_argument('--eval_seed', type=int, default=1337)
    args = parser.parse_args()
    evaluate(args)