# inference/confidence_scorer.py
import networkx as nx

def has_behavioral_signals(graph: nx.Graph, start_node: str) -> bool:
    """Checks for Person->GitHub_Org or Person->Forum_Post activity."""
    for node, data in graph.nodes(data=True):
        if data.get('type') == 'Person':
            for neighbor in graph.successors(node):
                neighbor_type = graph.nodes[neighbor].get('type')
                if neighbor_type in ['GitHub_Org', 'Forum_Post']:
                    return True
    return False

def is_custom_domain(domain: str) -> bool:
    """Checks if a domain is a custom TLD vs a templated one."""
    templated_endings = ['.github.io', '.vercel.app', '.netlify.app', '.repl.co']
    if any(domain.endswith(ending) for ending in templated_endings):
        return False
    # A simple heuristic for custom domains (e.g., 'company.com')
    return domain.count('.') == 1

def calculate_heuristic_score(graph: nx.Graph) -> float:
    """Calculates a heuristic confidence score based on learned patterns in the graph."""
    score = 0.0
    base_node_score = graph.number_of_nodes() * 0.1
    base_edge_score = graph.number_of_edges() * 0.2
    score += base_node_score + base_edge_score
    print(f" [SCORER] Base score (from nodes/edges): {score:.2f}")

    # --- PATTERN MATCHING ---

    # Pattern: The Build-Out (A person is a member of a GitHub org)
    for node, data in graph.nodes(data=True):
        if data.get('type') == 'Person':
            for neighbor in graph.successors(node):
                if graph.nodes[neighbor].get('type') == 'GitHub_Org':
                    print(" [SCORER] PATTERN DETECTED: The Build-Out (Person -> GitHub Org)")
                    score += 35.0
                    break # Only score this once per person

    # Pattern: Tiered Monetization (A domain uses payment tech)
    payment_tech = {"Stripe", "Paddle", "Lemon Squeezy"}
    for node, data in graph.nodes(data=True):
        if data.get('type') == 'Domain':
            domain_has_payment = False
            for neighbor in graph.successors(node):
                if graph.nodes[neighbor].get('name') in payment_tech:
                    domain_has_payment = True
                    break
            if domain_has_payment:
                has_activity = has_behavioral_signals(graph, node)
                is_custom = is_custom_domain(node)
                if has_activity:
                    print(f" [SCORER] TIER 3 MONETIZATION: Payment tech on domain with other behavioral signals.")
                    score += 35.0
                elif is_custom:
                    print(f" [SCORER] TIER 2 MONETIZATION: Payment tech on a custom domain.")
                    score += 20.0
                else:
                    print(f" [SCORER] TIER 1 MONETIZATION: Payment tech found, but context is weak.")
                    score += 10.0

    # NEW Pattern: Stealth Mode Entry (A person's public activity drops)
    for node, data in graph.nodes(data=True):
        if data.get('type') == 'Person' and data.get('activity_drop') is True:
            print(" [SCORER] PATTERN DETECTED: Stealth Mode Entry (Significant drop in public GitHub activity)")
            score += 30.0
            
    print(f" [SCORER] Score after pattern matching: {score:.2f}")

    # Normalize score to be between 0 and 1
    normalized_score = score / (50 + score) # Simple normalization
    return round(normalized_score, 4)