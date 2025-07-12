import torch
import torch.nn as nn
from torch.utils.data import DataLoader
import argparse
import os
import time
import numpy as np

from simulation.env import StartupSimEnv
from control.radt_dataset import RADTTrajectoryDataset
from control.radt_model import ReachAvoidDecisionTransformer
from control.preprocess_data import preprocess_and_save

def collect_experience(args, model, env):
    """Has the current model 'play' one episode to generate a new trajectory."""
    print("\n--- Collecting New Experience ---")
    state = env.reset()
    model.eval()

    goal_vec = torch.zeros(env.state_dim).unsqueeze(0)
    avoid_vec = torch.zeros(env.state_dim).unsqueeze(0)
    
    done = False
    states = torch.zeros(1, args.max_ep_len, env.state_dim)
    actions = torch.zeros(1, args.max_ep_len, 1, dtype=torch.long)
    returns_to_go = torch.zeros(1, args.max_ep_len, 1)
    timesteps = torch.zeros(1, args.max_ep_len, dtype=torch.long)
    
    # --- THIS IS THE CORRECTED LINE ---
    # Create the state vector using the canonical key order, which excludes 'done'
    initial_state_vec = np.array([state[key] for key in env.state_keys])
    states[:, 0] = torch.from_numpy(initial_state_vec)
    returns_to_go[:, 0] = torch.tensor(args.target_rtg)

    for t in range(args.max_ep_len):
        with torch.no_grad():
            action_preds = model.forward(
                states[:, :t+1], actions[:, :t+1], returns_to_go[:, :t+1],
                timesteps[:, :t+1], goal_vec, avoid_vec
            )
        
        predicted_action_idx = torch.argmax(action_preds[0, t]).item()
        next_state, reward, done, info = env.step(env.action_space[predicted_action_idx])
        
        if t < args.max_ep_len - 1:
            actions[:, t+1] = predicted_action_idx
            # Also fix the state vector creation here
            next_state_vec = np.array([next_state[key] for key in env.state_keys])
            states[:, t+1] = torch.from_numpy(next_state_vec)
            returns_to_go[:, t+1] = returns_to_go[0, t] - reward
            timesteps[:, t+1] = t + 1
        if done:
            break
            
    episode_id = f"selfplay_ep_{int(time.time() * 1000)}.json"
    output_path = os.path.join(args.self_play_dir, episode_id)
    env.export_trajectory(output_path)
    print(f"New experience collected and saved to {output_path}")

def fine_tune_model(args, model):
    """Re-trains the model on the pre-processed combined dataset."""
    print("\n--- Fine-Tuning Model on New Experience ---")
    
    dataset = RADTTrajectoryDataset(processed_file=args.data_file)
    dataloader = DataLoader(
        dataset, batch_size=args.batch_size, shuffle=True
    )
    print(f"Combined dataset loaded with {len(dataset)} total trajectories.")

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    loss_fn = nn.CrossEntropyLoss()
    model.train()
    
    state_dim, action_dim = 10, 7

    for epoch in range(args.epochs):
        epoch_loss = 0.0
        for batch in dataloader:
            states, actions, rtgs, goals, avoids = (
                batch['states'], batch['actions'], batch['returns_to_go'], 
                batch['goal'], batch['avoid']
            )
            attention_mask = torch.ones(states.shape[0], states.shape[1] * 3)
            timesteps = torch.arange(states.shape[1]).expand(states.shape[0], -1)

            action_preds = model.forward(
                states, actions, rtgs, timesteps, goals, avoids, attention_mask=attention_mask
            )
            
            action_mask = (actions != 0).reshape(-1)
            loss = loss_fn(
                action_preds.reshape(-1, action_dim)[action_mask], 
                actions.reshape(-1)[action_mask]
            )

            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            epoch_loss += loss.item()

        avg_epoch_loss = epoch_loss / len(dataloader)
        print(f"Fine-tune Epoch {epoch+1}/{args.epochs} | Average Loss: {avg_epoch_loss:.4f}")

    torch.save(model.state_dict(), args.model_path)
    print(f"Model weights updated and saved to {args.model_path}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model_path', type=str, default='radt_superbrain_online.pth')
    parser.add_argument('--expert_data_dir', type=str, default='simulation/trajectories/')
    parser.add_argument('--self_play_dir', type=str, default='simulation/self_play_trajectories/')
    parser.add_argument('--data_file', type=str, default='radt_preprocessed_data.pt')
    parser.add_argument('--epochs', type=int, default=5)
    parser.add_argument('--batch_size', type=int, default=8)
    parser.add_argument('--lr', type=float, default=5e-5)
    parser.add_argument('--embed_dim', type=int, default=64)
    parser.add_argument('--n_layer', type=int, default=4)
    parser.add_argument('--n_head', type=int, default=4)
    parser.add_argument('--target_rtg', type=float, default=20.0)
    parser.add_argument('--max_ep_len', type=int, default=200)
    args = parser.parse_args()

    env = StartupSimEnv()
    state_dim, action_dim = env.state_dim, env.action_dim
    model = ReachAvoidDecisionTransformer(
        state_dim=state_dim, act_dim=action_dim, hidden_size=args.embed_dim,
        max_length=args.max_ep_len, n_layer=args.n_layer, n_head=args.n_head,
        n_inner=4*args.embed_dim
    )
    
    if os.path.exists('radt_superbrain_v4.pth'):
        print("Loading existing model weights...")
        model.load_state_dict(torch.load('radt_superbrain_v4.pth'))

    # --- THE ONLINE LOOP ---
    collect_experience(args, model, env)
    all_data_dirs = [args.expert_data_dir, args.self_play_dir]
    preprocess_and_save(all_data_dirs, args.data_file)
    fine_tune_model(args, model)