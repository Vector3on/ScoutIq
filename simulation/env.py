import simpy
import random
import json
from typing import Dict, Any, List, Tuple
import os
import copy
import math
import numpy as np

class RewardShaper:
    def __init__(self, gamma=0.99, weights=None):
        self.gamma = gamma
        self.weights = weights if weights is not None else {
            "potential_survival": 1.0, "potential_growth": 0.5,
            "potential_efficiency": 0.3, "potential_sustainability": 0.4
        }
    def potential(self, state):
        capital = state.get('capital', 0)
        product_progress = state.get('product_progress', 0)
        team_size = state.get('team_size', 1)
        burn_rate = (team_size * 7000)
        phi_survival = self.weights["potential_survival"] * np.log(capital + 1e-9)
        phi_growth = self.weights["potential_growth"] * product_progress
        phi_efficiency = self.weights["potential_efficiency"] * (product_progress / (team_size + 1e-9))
        phi_sustainability = -self.weights["potential_sustainability"] * (burn_rate / (capital + 1e-9))
        return phi_survival + phi_growth + phi_efficiency + phi_sustainability
    def calculate_shaped_reward(self, state, next_state, done):
        base_reward = 0.0
        if done and next_state.get('capital', 0) <= 0:
            base_reward = -100.0
        base_reward += (next_state.get('product_progress', 0) - state.get('product_progress', 0))
        potential_current = self.potential(state)
        potential_next = self.potential(next_state)
        if done:
            potential_next = 0
        shaping_reward = (self.gamma * potential_next) - potential_current
        return base_reward + shaping_reward

class StartupSimEnv:
    def __init__(self, seed: int = None):
        self.seed = seed
        self.reward_shaper = RewardShaper()
        self.day = 0
        self.reset()

    def reset(self) -> Dict[str, Any]:
        if self.seed is not None: self.seed += 1
        random.seed(self.seed)
        self.day = 0
        self._initialize_state()
        self.history = []
        return self.get_state()

    def _initialize_state(self):
        # --- FIX for SyntaxError ---
        # Added the missing closing bracket ']'
        self.state_keys: List[str] = [
            "capital", "team_size", "product_progress", "market_traction",
            "founder_burnout", "team_alignment", "technical_debt", "investor_interest",
            "hiring_market_strength", "competitive_pressure", "runway_in_months"
        ]
        # --- END FIX ---
        self.state: Dict[str, Any] = {key: 0.0 for key in self.state_keys}
        self.state.update({
            "capital": 50000.0, "team_size": 1, "product_progress": 5.0, "founder_burnout": 10.0,
            "team_alignment": 90.0, "technical_debt": 10.0, "investor_interest": 20.0,
            "hiring_market_strength": 70.0, "competitive_pressure": 10.0
        })
        self.state['done'] = False
        self.action_space: List[str] = [
            "hire_engineer", "run_marketing_campaign", "seek_funding",
            "refactor_codebase", "team_building_offsite", "rest", "wait"
        ]
        self.state_dim = len(self.state_keys)
        self.action_dim = len(self.action_space)
        self._update_cfo_metrics()

    def _update_cfo_metrics(self):
        burn_rate = (self.state["team_size"] * 7000)
        self.state['runway_in_months'] = self.state['capital'] / (burn_rate + 1e-9)

    def step(self, action: str) -> Tuple[Dict[str, Any], float, bool, Dict[str, Any]]:
        if self.state['done']: return self.get_state(), 0, self.state['done'], {}
        
        state_before = self.get_state()
        
        # Simulate 7 days passing for each action
        for _ in range(7):
            self.day += 1
            self.state['founder_burnout'] = min(100, self.state['founder_burnout'] + 0.1)
            self.state['product_progress'] = min(100, self.state['product_progress'] + (0.05 + (0.1 * math.log1p(self.state["team_size"]))))
            self.state['capital'] -= (self.state['team_size'] * 7000) / 30

        if action == "hire_engineer":
            if self.state["capital"] > 5000: self.state["capital"] -= 5000; self.state["team_size"] += 1
        elif action == "run_marketing_campaign":
            if self.state["capital"] > 10000: self.state["capital"] -= 10000; self.state["market_traction"] += 5
        elif action == "seek_funding":
            if self.state['capital'] < 300000 and random.random() < self.state["investor_interest"] / 100:
                self.state["capital"] += random.uniform(50000, 250000)
        elif action == "refactor_codebase":
            self.state["technical_debt"] = max(0, self.state["technical_debt"] - 20); self.state['founder_burnout'] += 5
        elif action == "team_building_offsite":
            if self.state["capital"] > 2000 * self.state["team_size"]: self.state["capital"] -= 2000 * self.state["team_size"]; self.state['founder_burnout'] = max(0, self.state['founder_burnout'] - 40)
        elif action == "rest":
            self.state['founder_burnout'] = max(0, self.state['founder_burnout'] - 20)
        
        self._update_cfo_metrics()
        done = self.state['capital'] <= 0 or self.state['founder_burnout'] >= 100
        self.state['done'] = done
        
        next_state = self.get_state()
        reward = self.reward_shaper.calculate_shaped_reward(state_before, next_state, done)
        
        return next_state, reward, done, {}

    def get_state(self) -> Dict[str, Any]: return self.state.copy()
