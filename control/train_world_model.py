import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
import argparse
import os

from control.world_model import WorldModel 
from simulation.env import StartupSimEnv # NEW: Import the environment

def train_world_model(data_file, output_path, resume_from_checkpoint, checkpoint_interval, epochs, batch_size, lr):
    print("--- Training World Model ---")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}")
    # Load data
    data = torch.load(data_file)
    states_tensor = data['states']
    actions_tensor = data['actions']
    next_states_tensor = states_tensor[1:]
    states_tensor = states_tensor[:-1]
    actions_tensor = actions_tensor[:-1]

    dataset = TensorDataset(states_tensor, actions_tensor, next_states_tensor)
    dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    # --- NEW FIX for RuntimeError ---
    # Initialize a temporary environment to get the correct model dimensions.
    print("Initializing temp environment to get correct model dimensions...")
    temp_env = StartupSimEnv()
    state_dim = temp_env.state_dim
    act_dim = temp_env.action_dim
    print(f"Correct dimensions from env: state_dim={state_dim}, act_dim={act_dim}")
    # --- END FIX ---

    model = WorldModel(state_dim=state_dim, act_dim=act_dim, hidden_size=64, n_layer=4, n_head=4).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.MSELoss()

    start_epoch = 0

    if resume_from_checkpoint and os.path.exists(resume_from_checkpoint):
        print(f"Resuming training from checkpoint: {resume_from_checkpoint}")
        checkpoint = torch.load(resume_from_checkpoint)
        model.load_state_dict(checkpoint['model_state_dict'])
        optimizer.load_state_dict(checkpoint['optimizer_state_dict'])
        start_epoch = checkpoint['epoch'] + 1
        print(f"Resumed from epoch {start_epoch-1}.")

    model.train()
    for epoch in range(start_epoch, epochs):
        total_loss = 0
        for batch_states, batch_actions, batch_next_states in dataloader:
            batch_states, batch_actions, batch_next_states = batch_states.to(device), batch_actions.to(device), batch_next_states.to(device)

            optimizer.zero_grad()
            predicted_next_states = model(batch_states, batch_actions)
            loss = loss_fn(predicted_next_states, batch_next_states)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

        avg_loss = total_loss / len(dataloader)
        print(f"Epoch {epoch+1}/{epochs}, Average Loss: {avg_loss:.6f}")

        if (epoch + 1) % checkpoint_interval == 0:
            checkpoint_path = f"{output_path.replace('.pth', '')}_epoch_{epoch+1}.pth"
            print(f"Saving checkpoint to {checkpoint_path}")
            torch.save({
                'epoch': epoch,
                'model_state_dict': model.state_dict(),
                'optimizer_state_dict': optimizer.state_dict(),
                'loss': avg_loss,
            }, checkpoint_path)

    print(f"Training complete. Saving final model to {output_path}")
    torch.save(model.state_dict(), output_path)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data_file', type=str, default='radt_preprocessed_data_v8.pt')
    parser.add_argument('--output_path', type=str, default='world_model_v8.pth')
    parser.add_argument('--epochs', type=int, default=1000)
    parser.add_argument('--batch_size', type=int, default=64)
    parser.add_argument('--lr', type=float, default=1e-4)
    parser.add_argument('--resume_from_checkpoint', type=str, default=None, help="Path to checkpoint file to resume training.")
    parser.add_argument('--checkpoint_interval', type=int, default=50, help="Save a checkpoint every N epochs.")
    args = parser.parse_args()

    train_world_model(args.data_file, args.output_path, args.resume_from_checkpoint, args.checkpoint_interval, args.epochs, args.batch_size, args.lr)