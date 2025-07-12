# inference/causal_model.py
import dowhy
import pandas as pd
import networkx as nx

def build_causal_model(founder_archetype: str):
    """
    Builds a predefined causal graph for a specific founder archetype.
    """
    if founder_archetype == "Ex_FAANG_AI_Architect":
        # Define the plausible causal chain of events as a Directed Acyclic Graph (DAG)
        # Form C-Corp -> Register Domain -> Create GitHub Org -> Post 'Founding Engineer' Job
        causal_graph = """
        digraph {
        Form_CCorp;
        Register_Domain;
        Create_GitHub_Org;
        Post_Job;
        Form_CCorp -> Register_Domain;
        Register_Domain -> Create_GitHub_Org;
        Create_GitHub_Org -> Post_Job;
        }
        """
        # In a real scenario, we would have data to test this model.
        # For now, the graph itself is the model.
        model = dowhy.CausalModel(
            data=pd.DataFrame({'Form_CCorp': [0], 'Register_Domain': [0], 'Create_GitHub_Org': [0], 'Post_Job': [0]}),
            graph=causal_graph,
            treatment='Create_GitHub_Org',
            outcome='Post_Job'
        )
        return model
    
    # Add other archetypes here in the future
    return None

def check_causal_consistency(investigation_graph: nx.Graph, archetype_model: dowhy.CausalModel) -> bool:
    """
    Checks if the events in the investigation graph are consistent with the causal model.
    This is a simplified check for the MVP.
    """
    if not archetype_model:
        return True # If no model, assume it's consistent

    # Get the sequence of events from our investigation graph (we'd need to add timestamps)
    # For now, we'll just simulate this check.
    # A real implementation would check if a "Post_Job" node appears without a
    # preceding "Create_GitHub_Org" node connected to the same person.
    
    print("  [CAUSAL_MODEL] Checking investigation against causal path... (simulation)")
    # In a real system, this would return False if an "anti-signal" is detected.
    is_consistent = True 
    
    if is_consistent:
        print("  [CAUSAL_MODEL] Path is causally consistent.")
    else:
        print("  [CAUSAL_MODEL] WARNING: Anti-signal detected. Event sequence is not causally plausible.")
        
    return is_consistent