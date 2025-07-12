import torch
import torch.nn as nn
from torch.utils.data import DataLoader
import argparse

from control.radt_dataset import RADTTrajectoryDataset
from control.value_function import ValueFunction

def train_value_function(args):
    dataset = RADTTrajectoryDataset(processed_file=args.data_file)
    dataloader = DataLoader(dataset, batch_size=args.batch_size, shuffle=True)
    print(f"Dataset loaded with {len(dataset)} pre-processed trajectories.")
    state_dim = 10
    model = ValueFunction(state_dim=state_dim, hidden_size=args.embed_dim)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    loss_fn = nn.MSELoss()
    print("--- Starting Value Function Training ---")
    for epoch in range(args.epochs):
        epoch_loss = 0.0
        for batch in dataloader:
            states, rtgs = batch['states'], batch['returns_to_go']
            states_flat = states.reshape(-1, state_dim)
            rtgs_flat = rtgs.reshape(-1, 1)
            mask = (states_flat.sum(dim=1) != 0)
            
            predicted_values = model.forward(states_flat[mask])
            loss = loss_fn(predicted_values, rtgs_flat[mask])
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            epoch_loss += loss.item()
        avg_epoch_loss = epoch_loss / len(dataloader)
        print(f"Epoch {epoch+1}/{args.epochs} | Average Value Prediction Error (MSE Loss): {avg_epoch_loss:.4f}")
    print("--- Training Complete ---")
    torch.save(model.state_dict(), args.output_path)
    print(f"Value Function weights saved to {args.output_path}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data_file', type=str, default='radt_preprocessed_data.pt')
    parser.add_argument('--output_path', type=str, default='value_function_v1.pth')
    parser.add_argument('--epochs', type=int, default=30)
    parser.add_argument('--batch_size', type=int, default=32)
    parser.add_argument('--embed_dim', type=int, default=128)
    parser.add_argument('--lr', type=float, default=1e-4)
    args = parser.parse_args()
    train_value_function(args)