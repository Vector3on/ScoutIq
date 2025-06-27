# observe/build_graph.py
#
# Part of the OBSERVE LAYER
#
# Objective:
# 1. Load raw data collected from various sources.
# 2. Construct a heterogeneous graph using networkx.
# 3. Generate vector embeddings for key nodes ('Project', 'Signal').
# 4. Save the processed graph object for downstream use.
#
# Optimization: This script can be pointed to a DuckDB database or Parquet files
# instead of CSVs for production-level performance.

import os
import networkx as nx
import polars as pl
from sentence_transformers import SentenceTransformer
import pickle

# --- Configuration ---
# In production, these would be paths to Parquet files or DuckDB connection strings
PROJECT_DATA_PATH = os.environ.get("PROJECT_DATA_PATH", "data/projects.csv")
SIGNAL_DATA_PATH = os.environ.get("SIGNAL_DATA_PATH", "data/signals.csv")
OUTPUT_GRAPH_PATH = "artifacts/hetero_graph_with_embeddings.gpickle"

# Using a standard, effective model. Can be swapped for a more specialized one.
EMBEDDING_MODEL = 'all-MiniLM-L6-v2'

def build_graph():
    """
    Constructs and enriches the heterogeneous graph.
    """
    print("--- Starting Heterogeneous Graph Construction ---")

    # 1. Load data using Polars for high performance
    print(f"Loading data from {PROJECT_DATA_PATH} and {SIGNAL_DATA_PATH}...")
    try:
        # Assuming placeholder CSVs for now
        df_projects = pl.read_csv(PROJECT_DATA_PATH)
        df_signals = pl.read_csv(SIGNAL_DATA_PATH)
    except Exception as e:
        print(f"Error loading data: {e}. Ensure mock data files exist.")
        # Create mock data if not found for demonstration
        df_projects = pl.DataFrame({
            "project_id": ["ollama/ollama", "langchain-ai/langchain"],
            "description": ["Get up and running with large language models, locally.", "Building applications with LLMs through composability"],
        })
        df_signals = pl.DataFrame({
            "signal_id": ["hn_123", "rd_456"],
            "project_id": ["ollama/ollama", "langchain-ai/langchain"],
            "source": ["Hacker News", "Reddit"],
            "content": ["Ollama is now available on Windows.", "Has anyone tried LangChain for complex agentic workflows?"]
        })
        print("Created mock data for demonstration.")


    G = nx.Graph()
    print("Graph object created.")

    # 2. Add Project nodes with attributes
    for row in df_projects.to_dicts():
        G.add_node(row['project_id'], node_type='Project', **row)

    # 3. Add Signal nodes and connect them to Projects
    for row in df_signals.to_dicts():
        signal_node_id = f"signal_{row['signal_id']}"
        G.add_node(signal_node_id, node_type='Signal', **row)
        # Add edge connecting Signal to its Project
        if G.has_node(row['project_id']):
            G.add_edge(row['project_id'], signal_node_id, relationship_type='HAS_SIGNAL')

    print(f"Graph constructed with {G.number_of_nodes()} nodes and {G.number_of_edges()} edges.")

    # 4. Generate Embeddings
    print(f"Loading embedding model: {EMBEDDING_MODEL}...")
    model = SentenceTransformer(EMBEDDING_MODEL)
    
    nodes_to_embed = [
        (node_id, data) for node_id, data in G.nodes(data=True) 
        if data.get('node_type') in ['Project', 'Signal']
    ]

    # Create text to embed for each node
    # For projects, we use the description. For signals, the content.
    texts_to_embed = [
        data.get('description', '') if data.get('node_type') == 'Project' 
        else data.get('content', '') 
        for _, data in nodes_to_embed
    ]
    
    print(f"Generating embeddings for {len(texts_to_embed)} nodes...")
    embeddings = model.encode(texts_to_embed, show_progress_bar=True)
    
    # Add embeddings back to the graph nodes
    for i, (node_id, _) in enumerate(nodes_to_embed):
        G.nodes[node_id]['embedding'] = embeddings[i]
        
    print("Embeddings added to graph nodes.")

    # 5. Save the processed graph object
    os.makedirs(os.path.dirname(OUTPUT_GRAPH_PATH), exist_ok=True)
    with open(OUTPUT_GRAPH_PATH, 'wb') as f:
        pickle.dump(G, f)
        
    print(f"Graph with embeddings saved to {OUTPUT_GRAPH_PATH}")

if __name__ == "__main__":
    build_graph()

