# inference/graph_manager.py
import networkx as nx
from datetime import datetime

class InvestigationGraph:
    def __init__(self, investigation_id: str):
        self.id = investigation_id
        self.graph = nx.DiGraph(id=investigation_id, last_updated=datetime.utcnow().isoformat())
        print(f" [GRAPH_MANAGER] New DiGraph created for investigation: {self.id}")

    def add_node(self, node_name, node_type, **attrs):
        if not self.graph.has_node(node_name):
            self.graph.add_node(node_name, type=node_type, **attrs)
            print(f" [GRAPH_MANAGER] Added {node_type} node: {node_name}")
        else: # If node exists, update its attributes with any new data
            nx.set_node_attributes(self.graph, {node_name: attrs})
            print(f" [GRAPH_MANAGER] Updated attributes for {node_type} node: {node_name}")

    def add_edge(self, source_node, target_node, edge_type, **attrs):
        self.graph.add_edge(source_node, target_node, type=edge_type, **attrs)
        print(f" [GRAPH_MANAGER] Added '{edge_type}' edge from {source_node} to {target_node}")

    def add_tech_stack(self, domain_name: str, technologies: list):
        self.add_node(domain_name, 'Domain')
        for tech in technologies:
            tech_name = tech.get('name')
            if not tech_name: continue
            self.add_node(tech_name, 'Technology', **tech)
            self.add_edge(domain_name, tech_name, 'USES_TECH')

    def add_github_org(self, person_username: str, org_data: dict):
        org_name = org_data.get('login')
        if not org_name: return
        self.add_node(person_username, 'Person')
        self.add_node(org_name, 'GitHub_Org', **org_data)
        self.add_edge(person_username, org_name, 'IS_MEMBER_OF')

    def add_reddit_fingerprint(self, founder_data: dict):
        username = founder_data.get('username')
        if not username: return
        self.add_node(username, 'Person', account_age=founder_data.get('account_age_days'))
        for post_url in founder_data.get('urls', []):
            post_id = post_url.split('/')[-2]
            self.add_node(post_id, 'Forum_Post', url=post_url)
            self.add_edge(username, post_id, 'WROTE_POST')

    def add_activity_signal(self, username: str, activity_data: dict):
        # This method updates an existing 'Person' node with new activity attributes
        if self.graph.has_node(username):
            attrs = {
                'activity_drop': activity_data.get('activity_drop'),
                'activity_reason': activity_data.get('reason')
            }
            # The set_node_attributes call is now handled by our improved add_node
            self.add_node(username, 'Person', **attrs)
            print(f" [GRAPH_MANAGER] Added activity signal to Person node: {username}")

    def get_graph_summary(self) -> dict:
        return {
            "investigation_id": self.id,
            "nodes": self.graph.number_of_nodes(),
            "edges": self.graph.number_of_edges(),
            "last_updated": self.graph.graph.get('last_updated')
        }