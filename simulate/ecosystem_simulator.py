# simulate/ecosystem_simulator.py
from mesa import Agent, Model
from mesa.time import RandomActivation

# --- Agent Types ---
class CasualContributorAgent(Agent):
    """A developer who is attracted by hype but may leave quickly."""
    def __init__(self, unique_id, model):
        super().__init__(unique_id, model)
        self.is_contributing = False
        self.is_active = True

    def step(self):
        if not self.is_active:
            return
        
        if not self.is_contributing:
            # Higher chance to join based on hype
            if self.random.random() < self.model.project.hype * 1.5:
                self.is_contributing = True
                self.model.project.add_contributor("casual")
        else:
            # Chance to become inactive after contributing
            if self.random.random() < 0.25:
                self.is_active = False

class CoreMaintainerAgent(Agent):
    """A loyal developer who contributes consistently."""
    def __init__(self, unique_id, model):
        super().__init__(unique_id, model)
        self.is_contributing = True # Starts as a contributor

    def step(self):
        # Core maintainers always contribute and boost hype
        if self.random.random() < 0.95: # Very small chance of leaving
             self.model.project.add_contributor("core")

# --- Project & Model ---
class ProjectAgent:
    """Represents the project, tracking its hype and contributors."""
    def __init__(self):
        self.hype = 0.1
        self.contributors = 0

    def add_contributor(self, contributor_type: str):
        self.contributors += 1
        # Core maintainers have a bigger impact on hype
        if contributor_type == "core":
            self.hype += 0.07
        else:
            self.hype += 0.04
        self.hype = min(self.hype, 1.0) # Cap hype at 1.0

    def get_shocked(self, shock_type: str):
        if shock_type == "funding":
            self.hype += 0.5 # Major boost
        elif shock_type == "competitor":
            self.hype *= 0.7 # Lose 30% of hype
        self.hype = min(self.hype, 1.0)

class StartupEcosystem(Model):
    """The main model for the Digital Twin simulation."""
    def __init__(self, num_casual_devs, num_core_devs):
        self.schedule = RandomActivation(self)
        self.project = ProjectAgent()
        self.peak_hype = 0.0
        self.funding_events = 0

        # Create agents
        for i in range(num_core_devs):
            a = CoreMaintainerAgent(f"core_{i}", self)
            self.schedule.add(a)
        
        for i in range(num_casual_devs):
            a = CasualContributorAgent(f"casual_{i}", self)
            self.schedule.add(a)

    def step(self):
        # External Events
        if self.random.random() < 0.02: # 2% chance of a funding event per step
            self.project.get_shocked("funding")
            self.funding_events += 1

        if self.random.random() < 0.03: # 3% chance of a competitor event
            self.project.get_shocked("competitor")
            
        self.schedule.step()
        
        # Track peak hype
        if self.project.hype > self.peak_hype:
            self.peak_hype = self.project.hype