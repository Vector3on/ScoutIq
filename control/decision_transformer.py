import torch
import torch.nn as nn
import math

class DecisionTransformer(nn.Module):
    def __init__(self, state_dim, act_dim, hidden_size, max_length=None, max_ep_len=4096, n_layer=3, n_head=1, n_inner=4, activation_function='relu', resid_pdrop=0.1, attn_pdrop=0.1):
        super().__init__()

        self.state_dim = state_dim
        self.act_dim = act_dim
        self.hidden_size = hidden_size
        self.max_length = max_length

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=hidden_size,
            nhead=n_head,
            dim_feedforward=n_inner * hidden_size,
            dropout=resid_pdrop,
            activation=activation_function,
            batch_first=True
        )
        self.transformer_encoder = nn.TransformerEncoder(
            encoder_layer,
            num_layers=n_layer
        )

        self.embed_timestep = nn.Embedding(max_ep_len, hidden_size)
        self.embed_return = torch.nn.Linear(1, hidden_size)
        self.embed_state = torch.nn.Linear(self.state_dim, hidden_size)
        self.embed_action = torch.nn.Embedding(self.act_dim, hidden_size)
        self.embed_ln = nn.LayerNorm(hidden_size)

        self.predict_action = nn.Sequential(
            *([nn.Linear(hidden_size, self.act_dim)])
        )

    def forward(self, states, actions, returns_to_go, timesteps):
        batch_size, seq_length = states.shape[0], states.shape[1]

        time_embeddings = self.embed_timestep(timesteps)

        state_embeddings = self.embed_state(states) + time_embeddings
        action_embeddings = self.embed_action(actions) + time_embeddings
        returns_embeddings = self.embed_return(returns_to_go.unsqueeze(-1)) + time_embeddings

        # Combine all embeddings before passing to the transformer
        transformer_input = self.embed_ln(returns_embeddings + state_embeddings + action_embeddings)
        
        transformer_output = self.transformer_encoder(transformer_input)
        action_preds = self.predict_action(transformer_output)
        return action_preds