import torch
import torch.nn as nn
import transformers

class WorldModel(nn.Module):
    def __init__(self, state_dim: int, act_dim: int, hidden_size: int, **kwargs):
        super().__init__()
        self.state_dim = state_dim
        self.act_dim = act_dim
        self.hidden_size = hidden_size
        config = transformers.GPT2Config(vocab_size=1, n_embd=hidden_size, **kwargs)
        self.transformer = transformers.GPT2Model(config)
        self.embed_state = nn.Linear(state_dim, hidden_size)
        self.embed_action = nn.Embedding(act_dim, hidden_size)
        self.embed_ln = nn.LayerNorm(hidden_size)
        self.predict_state = nn.Linear(hidden_size, state_dim)

    def forward(self, states, actions):
        state_embeddings = self.embed_state(states)
        action_embeddings = self.embed_action(actions)
        token_embeddings = torch.stack([state_embeddings, action_embeddings], dim=2)
        batch_size, seq_len, _, _ = token_embeddings.shape
        stacked_inputs = token_embeddings.reshape(batch_size * seq_len, 2, self.hidden_size)
        stacked_inputs = self.embed_ln(stacked_inputs)
        transformer_outputs = self.transformer(inputs_embeds=stacked_inputs)
        x = transformer_outputs['last_hidden_state']
        x = x[:, 1]
        next_state_preds = self.predict_state(x)
        return next_state_preds.reshape(batch_size, seq_len, self.state_dim)