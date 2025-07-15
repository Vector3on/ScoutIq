import torch
import numpy as np
import argparse

from control.decision_transformer import DecisionTransformer
from simulation.env import StartupSimEnv

def evaluate_dt(model_path, target_return, seed):
    print("--- Evaluating Decision Transformer (Corrected Version) ---")
    
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}")

    try:
        checkpoint = torch.load(model_path, map_location=device)
    except FileNotFoundError:
        print(f"ERROR: Model file not found at '{model_path}'.")
        return
    
    state_dim = checkpoint['state_dim']
    act_dim = checkpoint['act_dim']
    context_len = checkpoint['context_len']
    
    print(f"Loaded model metadata: state_dim={state_dim}, act_dim={act_dim}, context_len={context_len}")

    model = DecisionTransformer(
        state_dim=state_dim,
        act_dim=act_dim,
        hidden_size=128,
        max_ep_len=1000,
        n_layer=3,
        n_head=1
    ).to(device)
    
    model.load_state_dict(checkpoint['model_state_dict'])
    model.eval()
    print(f"Model weights loaded successfully from {model_path}")

    env = StartupSimEnv(seed=seed)
    state = env.reset()
    done = False
    
    total_reward = 0
    target_return_tensor = torch.tensor(target_return, device=device, dtype=torch.float32).reshape(1, 1)
    
    states = torch.from_numpy(np.array([state[key] for key in env.state_keys])).to(device).float().unsqueeze(0)
    actions = torch.zeros((0), device=device, dtype=torch.long)
    timesteps = torch.tensor([0], device=device, dtype=torch.long)

    action_map = {
        0: "hire_engineer", 1: "run_marketing_campaign", 2: "seek_funding",
        3: "refactor_codebase", 4: "team_building_offsite", 5: "rest", 6: "wait"
    }
    
    for t in range(365):
        actions_input = torch.cat([torch.zeros(1, device=device, dtype=torch.long), actions], dim=0)
        states_input = states.clone()
        timesteps_input = timesteps.clone()
        
        states_input = states_input[-context_len:]
        actions_input = actions_input[-context_len:]
        timesteps_input = timesteps_input[-context_len:]

        states_input = torch.nn.functional.pad(states_input, (0, 0, 0, context_len - states_input.shape[0]))
        actions_input = torch.nn.functional.pad(actions_input, (0, context_len - actions_input.shape[0]))
        timesteps_input = torch.nn.functional.pad(timesteps_input, (0, context_len - timesteps_input.shape[0]))

        with torch.no_grad():
            action_preds = model(
                states=states_input.unsqueeze(0),
                actions=actions_input.unsqueeze(0),
                returns_to_go=target_return_tensor,
                timesteps=timesteps_input.unsqueeze(0)
            )
            action_idx = torch.argmax(action_preds[0, -1, :]).item()

        action_name = action_map.get(action_idx, "wait")
        print(f"[Day {t*7:3}] Planner chose action: {action_name}")

        state, reward, done, _ = env.step(action_name)
        total_reward += reward
        
        actions = torch.cat([actions, torch.tensor([action_idx], device=device, dtype=torch.long)], dim=0)
        current_state_np = np.array([state[key] for key in env.state_keys])
        states = torch.cat([states, torch.from_numpy(current_state_np).to(device).float().unsqueeze(0)], dim=0)
        timesteps = torch.cat([timesteps, torch.tensor([t + 1], device=device, dtype=torch.long)], dim=0)

        if done:
            break
            
    print("\n--- Final Evaluation Complete ---")
    print(f"Total Reward: {total_reward:.2f}")
    print("Final State:")
    for key, value in env.get_state().items():
        if isinstance(value, float):
            print(f"  {key:<25}: {value:.2f}")
        else:
            print(f"  {key:<25}: {value}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model_path', type=str, default='/content/drive/MyDrive/decision_transformer_v12_dagger.pth')
    parser.add_argument('--target_return', type=int, default=500)
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()
    
    evaluate_dt(args.model_path, args.target_return, args.seed)
