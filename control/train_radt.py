import torch
import torch.nn as nn
from torch.utils.data import DataLoader
import argparse

from control.radt_dataset import RADTTrajectoryDataset
from control.radt_model import ReachAvoidDecisionTransformer

def train(args):
    dataset = RADTTrajectoryDataset(processed_file=args.data_file)
    dataloader = DataLoader(
        dataset, batch_size=args.batch_size, shuffle=True,
    )
    print(f"Dataset loaded with {len(dataset)} pre-processed trajectories.")

    state_dim, action_dim, max_ep_len = 10, 7, 200
    model = ReachAvoidDecisionTransformer(
        state_dim=state_dim, act_dim=action_dim, hidden_size=args.embed_dim,
        max_length=max_ep_len, n_layer=args.n_layer, n_head=args.n_head,
        n_inner=4*args.embed_dim
    )

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    loss_fn = nn.CrossEntropyLoss()
    
    print(f"--- Starting Training for Model: {args.output_path} ---")
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
        print(f"Epoch {epoch+1}/{args.epochs} | Average Loss: {avg_epoch_loss:.4f}")

    print("--- Training Complete ---")
    torch.save(model.state_dict(), args.output_path)
    print(f"Model weights saved to {args.output_path}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data_file', type=str, default='radt_preprocessed_data.pt')
    parser.add_argument('--output_path', type=str, default='radt_superbrain_v4.pth') # Argument for save path
    parser.add_argument('--epochs', type=int, default=50)
    parser.add_argument('--batch_size', type=int, default=8)
    parser.add_argument('--embed_dim', type=int, default=64)
    parser.add_argument('--n_layer', type=int, default=4)
    parser.add_argument('--n_head', type=int, default=4)
    parser.add_argument('--lr', type=float, default=1e-4)
    args = parser.parse_args()
    train(args)