# simulation/env.py
import simpy
import random
import json
from typing import Dict, Any, List, Tuple
import os
import copy
import math

class StartupSimEnv:
    def __init__(self, seed: int = None):
        self.seed = seed
        self.reset()

    def reset(self) -> Dict[str, Any]:
        if self.seed is not None:
            self.seed += 1
            random.seed(self.seed)
        self.env = simpy.Environment()
        self._initialize_state()
        self.history = []
        self.unlocked_achievements = set()
        self.last_action = "None"
        self.env.process(self._burn_rate_process())
        self.env.process(self._passive_state_evolution())
        self.env.process(self._competitor_launch_event())
        self.env.process(self._economic_downturn_event())
        self.env.process(self._engineer_quits_event())
        return self.get_state()

    def _initialize_state(self):
        self.state_keys: List[str] = [
            "capital", "team_size", "product_progress", "market_traction", "founder_burnout", 
            "team_alignment", "technical_debt", "investor_interest", "hiring_market_strength", "competitive_pressure"
        ]
        self.state: Dict[str, Any] = {key: 0.0 for key in self.state_keys}
        self.state.update({
            "capital": 50000.0, "team_size": 1, "product_progress": 5.0, "founder_burnout": 10.0, 
            "team_alignment": 90.0, "technical_debt": 10.0, "investor_interest": 20.0, 
            "hiring_market_strength": 70.0, "competitive_pressure": 10.0
        })
        self.state['done'] = False
        self.action_space: List[str] = [
            "hire_engineer", "run_marketing_campaign", "seek_funding", "refactor_codebase", 
            "team_building_offsite", "rest", "wait"
        ]
        self.state_dim = len(self.state_keys)
        self.action_dim = len(self.action_space)

    def _log_entry(self, log_type: str, details: Dict[str, Any]):
        entry = {"timestamp": int(self.env.now), "type": log_type, **details}
        self.history.append(entry)

    def _update_done_status(self):
        if self.state['capital'] <= 0 or self.state['founder_burnout'] >= 100:
            if not self.state['done']:
                reason = "bankruptcy" if self.state['capital'] <= 0 else "founder_burnout"
                self._log_entry("sim_event", {"name": f"failure_{reason}"})
            self.state['done'] = True
        return self.state['done']

    def _burn_rate_process(self):
        base_salary_per_month = 7000
        while not self.state['done']:
            self.state["capital"] -= (self.state["team_size"] * base_salary_per_month) / 30
            self._update_done_status()
            yield self.env.timeout(1)

    def _passive_state_evolution(self):
        prev_progress = self.state["product_progress"]
        prev_traction = self.state["market_traction"]

        while not self.state['done']:
            self.state["founder_burnout"] = min(100, self.state["founder_burnout"] + 0.1)
            
            # FINAL FIX: Product progress is now heavily dependent on team size.
            # A solo founder makes very slow progress.
            progress_rate = 0.05 + (0.1 * math.log1p(self.state["team_size"]))
            self.state["product_progress"] = min(100, self.state["product_progress"] + progress_rate)
            self.state["technical_debt"] = min(100, self.state["technical_debt"] + (progress_rate * 0.5))
            
            interest_growth = (self.state['market_traction'] / 50.0) + (self.state['team_size'] / 10.0)
            self.state['investor_interest'] = min(100, self.state['investor_interest'] + (interest_growth * 0.1))
            
            self.state['delta_progress'] = self.state["product_progress"] - prev_progress
            self.state['delta_traction'] = self.state["market_traction"] - prev_traction
            prev_progress = self.state["product_progress"]
            prev_traction = self.state["market_traction"]

            self._update_done_status()
            yield self.env.timeout(1)

    def _calculate_rewards(self) -> float:
        reward = 0.0
        
        if "hire_first_engineer" not in self.unlocked_achievements and self.state["team_size"] > 1:
            reward += 5.0; self.unlocked_achievements.add("hire_first_engineer")
        if "build_MVP" not in self.unlocked_achievements and self.state["product_progress"] > 50:
            reward += 10.0; self.unlocked_achievements.add("build_MVP")
        if "first_10_users" not in self.unlocked_achievements and self.state["market_traction"] > 10:
            reward += 10.0; self.unlocked_achievements.add("first_10_users")
        
        reward += self.state.get('delta_progress', 0) * 0.1
        reward += self.state.get('delta_traction', 0) * 0.2
        reward -= (self.state['founder_burnout'] / 100.0) * 0.1

        if self.last_action == "wait":
            reward -= 0.1
        if self.last_action == "rest" and self.state['founder_burnout'] < 20:
            reward -= 0.15

        if reward != 0: self._log_entry("reward_event", {"amount": round(reward, 3)})
        return reward
        
    def _apply_action_consequences(self, action: str):
        if action == "hire_engineer":
            traction_modifier = 1 + (self.state['market_traction'] / 100.0)
            cost = 5000 * (1 - self.state["hiring_market_strength"] / 200) / traction_modifier
            if self.state["capital"] > cost: self.state["capital"] -= cost; self.state["team_size"] += 1; self.state["team_alignment"] -= 5
        elif action == "run_marketing_campaign":
            cost = 10000
            if self.state["capital"] > cost:
                self.state["capital"] -= cost
                product_multiplier = 0.2 + (self.state['product_progress'] / 100.0)
                traction_gain = 5 * (1 - self.state["competitive_pressure"] / 150) * product_multiplier
                self.state["market_traction"] += traction_gain
        elif action == "seek_funding":
            if self.state['capital'] < 300000 and random.random() < self.state["investor_interest"] / 100:
                funding = random.uniform(50000, 250000); self.state["capital"] += funding
                if "secure_seed_round" not in self.unlocked_achievements: self.unlocked_achievements.add("secure_seed_round");
        elif action == "refactor_codebase":
            self.state["technical_debt"] = max(0, self.state["technical_debt"] - 20); self.state["founder_burnout"] += 5
        elif action == "team_building_offsite":
            cost = 2000 * self.state["team_size"]
            if self.state["capital"] > cost: self.state["capital"] -= cost; self.state["team_alignment"] = min(100, self.state["team_alignment"] + 15); self.state["founder_burnout"] = max(0, self.state["founder_burnout"] - 10)
        elif action == "rest":
            self.state["founder_burnout"] = max(0, self.state["founder_burnout"] - 20)
        
        self.last_action = action

    def _competitor_launch_event(self):
        yield self.env.timeout(random.uniform(80, 120))
        if not self.state['done']: self.state["competitive_pressure"] = min(100, self.state["competitive_pressure"] + 40)

    def _economic_downturn_event(self):
        while not self.state['done']:
            yield self.env.timeout(random.uniform(50, 100))
            if random.random() < 0.15:
                if not self.state['done']: self.state["hiring_market_strength"] = max(10, self.state["hiring_market_strength"] - 30)

    def _engineer_quits_event(self):
        while not self.state['done']:
            if self.state["team_size"] > 1 and self.state["team_alignment"] < 40 and random.random() < 0.05:
                if not self.state['done']: self.state["team_size"] -= 1
            yield self.env.timeout(1)

    def step(self, action: str) -> Tuple[Dict[str, Any], float, bool, Dict[str, Any]]:
        if self.state['done']: return self.get_state(), 0, self.state['done'], {}
        
        state_before = self.get_state()
        self._apply_action_consequences(action)
        self.env.run(until=self.env.now + 7)
        reward = self._calculate_rewards()
        done = self._update_done_status()
        
        self._log_entry("step_data", {"state": state_before, "action": action, "reward": reward, "next_state": self.get_state(), "done": done})
        return self.get_state(), reward, done, {}

    def get_state(self) -> Dict[str, Any]:
        return self.state.copy()
        
    def export_trajectory(self, path: str):
        self._log_entry("sim_event", {"name": "simulation_end", "final_state": self.get_state()})
        with open(path, 'w') as f: json.dump(self.history, f, indent=2)
