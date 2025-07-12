import os
import time
import random
from simulation.env import StartupSimEnv

class ExpertAgent:
    """A simple scripted agent that follows a logical strategy."""
    def __init__(self, action_space):
        self.action_space = action_space

    def get_action(self, state):
        if state['team_size'] < 3:
            return "hire_engineer"
        elif state['product_progress'] < 50:
            return "wait"
        elif state['market_traction'] < 15:
            return "run_marketing_campaign"
        elif state['technical_debt'] > 60:
            return "refactor_codebase"
        else:
            return "wait"

def generate_data(num_episodes: int, trajectories_dir: str = "simulation/trajectories"):
    if not os.path.exists(trajectories_dir):
        os.makedirs(trajectories_dir)
    env = StartupSimEnv()
    expert = ExpertAgent(env.action_space)
    start_time = time.time()
    for i in range(num_episodes):
        print(f"--- Generating Episode {i+1}/{num_episodes} ---", end='\r')
        state = env.reset()
        done = False
        step_count = 0
        while not done:
            action = expert.get_action(state) if random.random() < 0.8 else random.choice(env.action_space)
            state, reward, done, info = env.step(action)
            step_count += 1
            if step_count > 200:
                done = True
        episode_id = f"ep_{int(time.time() * 1000)}_{i}.json"
        output_path = os.path.join(trajectories_dir, episode_id)
        env.export_trajectory(output_path)
    end_time = time.time()
    print(f"\n\nGenerated {num_episodes} expert trajectories in {end_time - start_time:.2f} seconds.")

if __name__ == '__main__':
    NUM_EPISODES_TO_GENERATE = 1000
    generate_data(NUM_EPISODES_TO_GENERATE)