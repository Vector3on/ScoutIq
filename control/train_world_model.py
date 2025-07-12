import torch
import torch.nn as nn
from torch.utils.data import DataLoader
import argparse

from control.radt_dataset import RADTTrajectoryDataset
from control.world_model import WorldModel

def train_world_model(args):
    dataset = RADTTrajectoryDataset(processed_file=args.data_file)
    dataloader = DataLoader(dataset, batch_size=args.batch_size, shuffle=True)
    print(f"Dataset loaded with {len(dataset)} pre-processed trajectories.")
    state_dim, action_dim = 10, 7
    model = WorldModel(
        state_dim=state_dim, act_dim=action_dim, hidden_size=args.embed_dim,
        n_layer=args.n_layer, n_head=args.n_head
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    loss_fn = nn.MSELoss()
    print("--- Starting World Model Training ---")
    for epoch in range(args.epochs):
        epoch_loss = 0.0
        for batch in dataloader:
            states, actions = batch['states'], batch['actions']
            input_states = states[:, :-1]
            input_actions = actions[:, :-1]
            target_next_states = states[:, 1:]
            predicted_next_states = model.forward(input_states, input_actions)
            loss = loss_fn(predicted_next_states, target_next_states)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            epoch_loss += loss.item()
        avg_epoch_loss = epoch_loss / len(dataloader)
        print(f"Epoch {epoch+1}/{args.epochs} | Average Prediction Error (MSE Loss): {avg_epoch_loss:.6f}")
    print("--- Training Complete ---")
    torch.save(model.state_dict(), args.output_path)
    print(f"World Model weights saved to {args.output_path}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data_file', type=str, default='radt_preprocessed_data.pt')
    parser.add_argument('--output_path', type=str, default='world_model_v1.pth')
    parser.add_argument('--epochs', type=int, default=50)
    parser.add_argument('--batch_size', type=int, default=32)
    parser.add_argument('--embed_dim', type=int, default=64)
    parser.add_argument('--n_layer', type=int, default=4)
    parser.add_argument('--n_head', type=int, default=4)
    parser.add_argument('--lr', type=float, default=1e-4)
    args = parser.parse_args()
    train_world_model(args)