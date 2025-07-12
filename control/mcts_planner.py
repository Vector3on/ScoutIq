# control/mcts_planner.py
import torch
import numpy as np
import math
import random

from control.world_model import WorldModel
from control.value_function import ValueFunction

class MCTSNode:
    def __init__(self, state, parent=None, action_idx=None):
        self.state = state
        self.parent = parent
        self.action_idx = action_idx
        self.children = []
        self.visits = 0
        self.value = 0.0

    def is_fully_expanded(self, num_actions):
        return len(self.children) == num_actions

    def uct_score(self, exploration_param=1.41):
        if self.visits == 0:
            return float('inf')
        exploitation = self.value / self.visits
        exploration = exploration_param * math.sqrt(math.log(self.parent.visits) / self.visits)
        return exploitation + exploration

class MCTSPlanner:
    def __init__(self, world_model: WorldModel, value_function: ValueFunction, env_config: dict, scaling_params: dict, rollout_depth: int = 5):
        self.world_model = world_model
        self.value_function = value_function
        self.env_config = env_config
        self.scaling_params = scaling_params
        self.rollout_depth = rollout_depth
        self.world_model.eval()
        self.value_function.eval()
        print(f"MCTS Planner initialized with rollout_depth={self.rollout_depth}.")

    def _normalize_state(self, state_dict):
        # THE FIX: Explicitly use the 10 keys the model was trained on, ignoring any others.
        state_values = [state_dict[key] for key in self.env_config['state_keys']]
        state_vec = torch.tensor(state_values, dtype=torch.float32)
        return (state_vec - self.scaling_params['min']) / self.scaling_params['range']

    def _denormalize_state(self, norm_state_vec):
        state_vec = norm_state_vec * self.scaling_params['range'] + self.scaling_params['min']
        state_dict = {key: val.item() for key, val in zip(self.env_config['state_keys'], state_vec)}
        state_dict['done'] = state_dict['capital'] <= 0 or state_dict['founder_burnout'] >= 100
        return state_dict

    def _select(self, node: MCTSNode) -> MCTSNode:
        while not node.state['done'] and node.is_fully_expanded(self.env_config['action_dim']):
            node = max(node.children, key=lambda n: n.uct_score())
        return node

    def _expand(self, node: MCTSNode) -> MCTSNode:
        if node.state['done']:
            return node
        tried_actions = {child.action_idx for child in node.children}
        for action_idx in range(self.env_config['action_dim']):
            if action_idx not in tried_actions:
                normalized_state = self._normalize_state(node.state).unsqueeze(0).unsqueeze(0)
                action_tensor = torch.tensor([[action_idx]])
                with torch.no_grad():
                    predicted_norm_next_state = self.world_model(normalized_state, action_tensor).squeeze()
                
                next_state_dict = self._denormalize_state(predicted_norm_next_state)
                child_node = MCTSNode(next_state_dict, parent=node, action_idx=action_idx)
                node.children.append(child_node)
                return child_node
        return node

    def _simulate(self, node: MCTSNode) -> float:
        if node.state['done']:
            return -1.0
        
        current_norm_state = self._normalize_state(node.state).unsqueeze(0).unsqueeze(0)
        
        for _ in range(self.rollout_depth):
            action_idx = random.randrange(self.env_config['action_dim'])
            action_tensor = torch.tensor([[action_idx]])

            with torch.no_grad():
                current_norm_state = self.world_model(current_norm_state, action_tensor)

            temp_state_dict = self._denormalize_state(current_norm_state.squeeze())
            if temp_state_dict['done']:
                return -1.0

        final_dream_state = current_norm_state.squeeze()
        with torch.no_grad():
            value = self.value_function(final_dream_state.unsqueeze(0)).item()
        return value

    def _backpropagate(self, node: MCTSNode, value: float):
        while node is not None:
            node.visits += 1
            node.value += value
            node = node.parent

    def search(self, initial_state, num_simulations):
        root = MCTSNode(initial_state)
        for _ in range(num_simulations):
            node = self._select(root)
            if not node.state['done']:
                node = self._expand(node)
            
            value = self._simulate(node)
            self._backpropagate(node, value)
        
        if not root.children:
            return random.choice(range(self.env_config['action_dim']))

        best_child = max(root.children, key=lambda n: n.visits)
        return best_child.action_idx