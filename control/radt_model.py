import torch
import torch.nn as nn
import numpy as np
import transformers

class ReachAvoidDecisionTransformer(nn.Module):
    """
    Final architecture with a dedicated Goal-Conditioning Gate to
    force the model to adhere to goal prompts.
    """
    def __init__(self, state_dim: int, act_dim: int, hidden_size: int, max_length: int, **kwargs):
        super().__init__()
        self.state_dim = state_dim
        self.act_dim = act_dim
        self.hidden_size = hidden_size

        config = transformers.GPT2Config(
            vocab_size=1, n_embd=hidden_size, **kwargs
        )
        self.transformer = transformers.GPT2Model(config)

        # --- NEW: Goal-Conditioning Gate ---
        # This small network learns to modify the action prediction based on the goal.
        self.gating_network = nn.Sequential(
            nn.Linear(hidden_size, hidden_size),
            nn.ReLU(),
            nn.Linear(hidden_size, act_dim)
        )

        # Input embedding layers
        self.embed_timestep = nn.Embedding(max_length, hidden_size)
        self.embed_return = nn.Linear(1, hidden_size)
        self.embed_state = nn.Linear(self.state_dim, hidden_size)
        self.embed_action = nn.Embedding(self.act_dim, hidden_size)
        self.embed_goal = nn.Linear(self.state_dim, hidden_size)
        self.embed_ln = nn.LayerNorm(hidden_size)
        self.predict_action = nn.Linear(hidden_size, self.act_dim)

    def forward(self, states, actions, returns_to_go, timesteps, goals, avoids, attention_mask=None):
        batch_size, seq_len = states.shape[0], states.shape[1]

        time_embeddings = self.embed_timestep(timesteps)
        state_embeddings = self.embed_state(states)
        action_embeddings = self.embed_action(actions.squeeze(-1))
        returns_embeddings = self.embed_return(returns_to_go)
        goal_embeddings = self.embed_goal(goals).unsqueeze(1).repeat(1, seq_len, 1)
        
        # We simplify away the avoid prompt for this test to focus on goal-conditioning
        conditioned_state_embeddings = state_embeddings + goal_embeddings + time_embeddings
        
        stacked_inputs = torch.stack(
            (returns_embeddings + time_embeddings, conditioned_state_embeddings, action_embeddings + time_embeddings), dim=2
        ).reshape(batch_size, 3 * seq_len, self.hidden_size)
        stacked_inputs = self.embed_ln(stacked_inputs)

        transformer_outputs = self.transformer(
            inputs_embeds=stacked_inputs,
            attention_mask=attention_mask,
        )
        x = transformer_outputs['last_hidden_state']

        x = x.reshape(batch_size, seq_len, 3, self.hidden_size).permute(0, 2, 1, 3)
        state_outputs = x[:, 1]
        
        # Base action prediction from the transformer
        action_preds = self.predict_action(state_outputs)

        # --- NEW: Apply the Gating Mechanism ---
        # 1. Calculate the "gate" values based on the state outputs
        gate = self.gating_network(state_outputs)
        # 2. Use a sigmoid to scale the gate between 0 and 1
        gate = torch.sigmoid(gate)
        # 3. Multiply the original prediction by the gate. This allows the goal-aware
        #    gating network to amplify or suppress certain actions.
        gated_action_preds = action_preds * gate

        return gated_action_preds

if __name__ == '__main__':
    print("--- Testing Gated RADT Model Architecture ---")
    
    STATE_DIM, ACTION_DIM, HIDDEN_SIZE = 10, 7, 64
    N_LAYER, N_HEAD, MAX_LENGTH = 4, 4, 200
    
    model = ReachAvoidDecisionTransformer(
        state_dim=STATE_DIM, act_dim=ACTION_DIM, hidden_size=HIDDEN_SIZE,
        max_length=MAX_LENGTH, n_layer=N_LAYER, n_head=N_HEAD, n_inner=4*HIDDEN_SIZE
    )
    
    BATCH_SIZE, SEQ_LEN = 4, 10
    
    dummy_states = torch.randn(BATCH_SIZE, SEQ_LEN, STATE_DIM)
    dummy_actions = torch.randint(0, ACTION_DIM, (BATCH_SIZE, SEQ_LEN, 1))
    dummy_rtgs = torch.randn(BATCH_SIZE, SEQ_LEN, 1)
    dummy_timesteps = torch.randint(0, MAX_LENGTH, (BATCH_SIZE, SEQ_LEN))
    dummy_goals = torch.randn(BATCH_SIZE, STATE_DIM)
    dummy_avoids = torch.randn(BATCH_SIZE, STATE_DIM)
    
    action_predictions = model.forward(
        dummy_states, dummy_actions, dummy_rtgs, dummy_timesteps, dummy_goals, dummy_avoids
    )
    
    print("Model instantiated successfully.")
    print(f"Input batch size: {BATCH_SIZE}, sequence length: {SEQ_LEN}")
    print(f"Output (predicted actions) shape: {action_predictions.shape}")
    print(f"Expected output shape: ({BATCH_SIZE}, {SEQ_LEN}, {ACTION_DIM})")