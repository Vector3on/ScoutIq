import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
import argparse
import os

from control.value_function import ValueFunction

def train_value_function(data_file, output_path, resume_from_checkpoint, checkpoint_interval, epochs, batch_size, lr):
    print("--- Training Value Function with Gradient Penalty ---")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}")

    data = torch.load(data_file)
    states = data['states']
    rewards_to_go = data['returns_to_go']

    dataset = TensorDataset(states, rewards_to_go)
    dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    state_dim = states.shape[-1]

    model = ValueFunction(state_dim=state_dim).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    mse_loss_fn = nn.MSELoss()

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
        for batch_states, batch_rtg in dataloader:
            batch_states, batch_rtg = batch_states.to(device), batch_rtg.to(device)

            # --- NEW: Gradient Alignment Loss ---
            batch_states.requires_grad_(True) # We need to track gradients for the input

            optimizer.zero_grad()

            num_sequences, seq_len, state_dim = batch_states.shape
            reshaped_states = batch_states.reshape(num_sequences * seq_len, state_dim)
            reshaped_rtg = batch_rtg.reshape(num_sequences * seq_len)

            predicted_values = model(reshaped_states)

            # 1. Standard Mean Squared Error Loss
            mse_loss = mse_loss_fn(predicted_values.squeeze(), reshaped_rtg)

            # 2. Gradient Penalty Loss
            # Get the gradient of the value function's output with respect to its input states
            value_gradients = torch.autograd.grad(
                outputs=predicted_values.sum(),
                inputs=reshaped_states,
                create_graph=True # Keep the graph for the backward pass
            )[0]

            # Assuming 'capital' is the first feature in the state vector (index 0)
            capital_gradients = value_gradients[:, 0]

            # Penalize any instance where the gradient of Value w.r.t Capital is not positive
            # torch.relu(-x) is 0 if x > 0, and |x| if x < 0.
            gradient_penalty = torch.relu(-capital_gradients).mean()

            # 3. Combine the losses
            lambda_grad_penalty = 0.1 # Hyperparameter to weight the penalty
            loss = mse_loss + lambda_grad_penalty * gradient_penalty
            # --- END NEW ---

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
    parser.add_argument('--data_file', type=str, default='radt_preprocessed_data_v9.pt')
    parser.add_argument('--output_path', type=str, default='value_function_v9.pth')
    parser.add_argument('--epochs', type=int, default=1000)
    parser.add_argument('--batch_size', type=int, default=64)
    parser.add_argument('--lr', type=float, default=1e-4)
    parser.add_argument('--resume_from_checkpoint', type=str, default=None, help="Path to checkpoint file to resume training.")
    parser.add_argument('--checkpoint_interval', type=int, default=50, help="Save a checkpoint every N epochs.")
    args = parser.parse_args()

    train_value_function(args.data_file, args.output_path, args.resume_from_checkpoint, args.checkpoint_interval, args.epochs, args.batch_size, args.lr)