import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset
import argparse
import numpy as np
import random

from .decision_transformer import DecisionTransformer

class TrajectoryDataset(Dataset):
    def __init__(self, trajectories, context_len):
        self.trajectories = trajectories
        self.context_len = context_len

    def __len__(self):
        return len(self.trajectories)

    def __getitem__(self, idx):
        traj = self.trajectories[idx]
        
        # Sample a random snippet from the trajectory
        start_idx = random.randint(0, max(0, len(traj['observations_np']) - 2))
        
        states = torch.from_numpy(traj['observations_np'][start_idx : start_idx + self.context_len]).float()
        actions = torch.from_numpy(traj['actions_np'][start_idx : start_idx + self.context_len]).long()
        returns_to_go = torch.from_numpy(traj['rtgs_np'][start_idx : start_idx + self.context_len]).float()
        timesteps = torch.arange(start_idx, start_idx + len(states)).long()
        
        # Pad sequences to context_len
        states = torch.nn.functional.pad(states, (0, 0, 0, self.context_len - len(states)))
        actions = torch.nn.functional.pad(actions, (0, self.context_len - len(actions)))
        returns_to_go = torch.nn.functional.pad(returns_to_go, (0, self.context_len - len(returns_to_go)))
        timesteps = torch.nn.functional.pad(timesteps, (0, self.context_len - len(timesteps)))

        return states, actions, returns_to_go, timesteps

def train_dt(data_file, output_path, epochs, batch_size, lr, context_len):
    print("--- Training Decision Transformer on REAL DATA ---")
    
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}")

    print(f"Loading real trajectory data from {data_file}...")
    trajectories = torch.load(data_file, weights_only=False)
    
    # Infer dimensions from the first trajectory
    state_dim = trajectories[0]['observations_np'].shape[1]
    act_dim = 7 # Based on our environment's action space

    dataset = TrajectoryDataset(trajectories, context_len=context_len)
    dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True)
    
    model = DecisionTransformer(
        state_dim=state_dim,
        act_dim=act_dim,
        hidden_size=128,
        max_ep_len=1000,
        n_layer=3,
        n_head=1
    ).to(device)
    
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.CrossEntropyLoss()

    model.train()
    for epoch in range(epochs):
        total_loss = 0
        for states, actions, returns_to_go, timesteps in dataloader:
            states, actions, returns_to_go, timesteps = states.to(device), actions.to(device), returns_to_go.to(device), timesteps.to(device)
            
            action_preds = model(
                states=states,
                actions=actions,
                returns_to_go=returns_to_go,
                timesteps=timesteps,
            )

            loss = loss_fn(action_preds.reshape(-1, act_dim), actions.reshape(-1))
            
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
        
        print(f"Epoch {epoch+1}/{epochs}, Loss: {loss.item():.6f}")

    print(f"Training complete. Saving model to {output_path}")
    torch.save(model.state_dict(), output_path)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data_file', type=str, default='dt_trajectories_v9.pt')
    parser.add_argument('--output_path', type=str, default='/content/drive/MyDrive/decision_transformer_v1.pth')
    parser.add_argument('--epochs', type=int, default=100)
    parser.add_argument('--batch_size', type=int, default=64)
    parser.add_argument('--lr', type=float, default=1e-4)
    parser.add_argument('--context_len', type=int, default=20)
    args = parser.parse_args()
    
    train_dt(args.data_file, args.output_path, args.epochs, args.batch_size, args.lr, args.context_len)