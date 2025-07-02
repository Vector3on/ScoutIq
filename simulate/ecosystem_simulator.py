from mesa import Agent, Model
from mesa.time import RandomActivation

class DeveloperAgent(Agent):
    """An agent representing a developer."""

    def __init__(self, unique_id, model):
        super().__init__(unique_id, model)
        self.is_contributing = False

    def step(self):
        if not self.is_contributing:
            if self.random.random() < self.model.project.hype:
                self.is_contributing = True
                self.model.project.add_contributor()


class ProjectAgent:
    """A special object representing the startup project itself."""

    def __init__(self):
        self.hype = 0.1  # Initial hype level
        self.contributors = 0

    def add_contributor(self):
        self.contributors += 1
        self.hype += 0.05
        self.hype = min(self.hype, 0.8)  # Cap hype


class StartupEcosystem(Model):
    """A model containing developers and a project."""

    def __init__(self, num_developers):
        super().__init__()
        self.num_developers = num_developers
        self.schedule = RandomActivation(self)
        self.project = ProjectAgent()

        for i in range(self.num_developers):
            dev = DeveloperAgent(i, self)
            self.schedule.add(dev)

    def step(self):
        self.schedule.step()


if __name__ == '__main__':
    import statistics

    NUM_SIMULATIONS = 100
    SIMULATION_STEPS = 50
    final_contributor_counts = []

    print(f"--- Running {NUM_SIMULATIONS} Monte Carlo Simulations of Project Growth ---")

    for i in range(NUM_SIMULATIONS):
        model = StartupEcosystem(100)
        for _ in range(SIMULATION_STEPS):
            model.step()
        final_contributor_counts.append(model.project.contributors)

    avg = sum(final_contributor_counts) / NUM_SIMULATIONS
    std = statistics.stdev(final_contributor_counts)
    max_val = max(final_contributor_counts)

    print("\n--- Simulation Results ---")
    print(f"Average final contributors: {avg:.2f}")
    print(f"Standard deviation: {std:.2f}")
    print(f"Maximum contributors: {max_val}")
    print("This shows a distribution of possible futures for the project.")
