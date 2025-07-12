# control/rl_agent.py
import numpy as np

ARMS = [
    {"scanner_name": "tech_stack_scanner", "scanner_path": "scanners/tech_stack_scanner.js"},
    {"scanner_name": "github_scanner", "scanner_path": "scanners/github_scanner.py"},
    {"scanner_name": "reddit_scanner", "scanner_path": "scanners/reddit_scanner.py"},
    # New arm added for the activity scanner
    {"scanner_name": "github_activity_scanner", "scanner_path": "scanners/github_activity_scanner.py"}
]

class ContextualBanditAgent:
    def __init__(self, n_features: int, alpha: float = 1.0):
        self.n_arms = len(ARMS)
        self.n_features = n_features
        self.alpha = alpha

        # Initialize LinUCB parameters
        self.A = [np.identity(self.n_features) for _ in range(self.n_arms)]  # Identity matrices
        self.b = [np.zeros((self.n_features, 1)) for _ in range(self.n_arms)]  # Zero vectors

        print(f" [RL_AGENT] Contextual Bandit (LinUCB) initialized with {self.n_arms} arms and {self.n_features} features.")

    def choose_action(self, context: np.array) -> tuple[dict, int]:
        x = context.reshape(-1, 1)  # Reshape context to a column vector

        p = np.zeros(self.n_arms)
        for i in range(self.n_arms):
            A_inv = np.linalg.inv(self.A[i])
            theta = A_inv @ self.b[i]  # Calculate coefficient vector
            p[i] = (theta.T @ x) + self.alpha * np.sqrt(x.T @ A_inv @ x) # UCB calculation

        arm_index = np.argmax(p)
        selected_arm = ARMS[arm_index]
        
        print(f" [RL_AGENT] Bandit chose arm {arm_index}: '{selected_arm['scanner_name']}' with UCB {p[arm_index]:.2f}.")
        return selected_arm, arm_index

    def update_policy(self, context: np.array, chosen_arm_index: int, reward: float):
        x = context.reshape(-1, 1)
        self.A[chosen_arm_index] += x @ x.T
        self.b[chosen_arm_index] += reward * x
        print(f" [RL_AGENT] Policy updated for arm {chosen_arm_index} with reward {reward:.2f}.")