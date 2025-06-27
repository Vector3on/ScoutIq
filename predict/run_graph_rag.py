# predict/run_graph_rag.py
#
# Part of the PREDICT LAYER
#
# Objective:
# 1. Take a user query as input.
# 2. Generate an embedding for the query.
# 3. Use the pre-built FAISS index to retrieve the top-K most similar nodes.
# 4. Load the graph and fetch the full data for the retrieved nodes.
# 5. Return the enriched results.

import os
import pickle
import numpy as np
import faiss
from sentence_transformers import SentenceTransformer
import argparse
import json

# --- Configuration ---
GRAPH_PATH = "artifacts/hetero_graph_with_embeddings.gpickle"
INDEX_PATH = "artifacts/graph_faiss.index"
MAPPING_PATH = "artifacts/node_id_mapping.pkl"
EMBEDDING_MODEL = 'all-MiniLM-L6-v2'

class GraphRAG:
    def __init__(self):
        print("--- Initializing GraphRAG Engine ---")
        # Load all artifacts
        print("Loading graph, FAISS index, and node mapping...")
        try:
            with open(GRAPH_PATH, 'rb') as f:
                self.graph = pickle.load(f)
            self.index = faiss.read_index(INDEX_PATH)
            with open(MAPPING_PATH, 'rb') as f:
                self.node_id_mapping = pickle.load(f)
        except FileNotFoundError as e:
            raise RuntimeError(f"Could not load artifacts: {e}. Ensure build_graph.py and build_index.py have been run.")

        print("Loading embedding model...")
        self.model = SentenceTransformer(EMBEDDING_MODEL)
        print("GraphRAG Engine Ready.")
        
    def search(self, query_text: str, k: int = 5):
        """
        Performs a semantic search over the graph.
        
        Args:
            query_text: The natural language search query.
            k: The number of top results to return.
            
        Returns:
            A list of dictionaries, where each dictionary is a retrieved node's data.
        """
        print(f"\n--- Performing search for query: '{query_text}' ---")
        
        # 1. Generate query embedding
        query_embedding = self.model.encode([query_text]).astype('float32')
        
        # 2. Search the FAISS index
        print(f"Searching for top {k} similar nodes in FAISS index...")
        distances, indices = self.index.search(query_embedding, k)
        
        # 3. Retrieve node data from the graph using the mapping
        results = []
        retrieved_indices = indices[0]
        
        print("Retrieving node data from graph...")
        for i in retrieved_indices:
            if i != -1: # FAISS returns -1 for empty slots
                node_id = self.node_id_mapping[i]
                node_data = self.graph.nodes[node_id]
                
                # Clean up data for JSON output (remove numpy array)
                if 'embedding' in node_data:
                    del node_data['embedding']
                    
                results.append({"retrieved_node_id": node_id, **node_data})

        return results

def main():
    parser = argparse.ArgumentParser(description="GraphRAG Inference Pipeline")
    parser.add_argument("query", type=str, help="The search query.")
    parser.add_argument("--k", type=int, default=5, help="Number of results to return.")
    args = parser.parse_args()

    try:
        rag_engine = GraphRAG()
        search_results = rag_engine.search(args.query, args.k)

        print("\n--- Search Results ---")
        print(json.dumps(search_results, indent=2))

    except RuntimeError as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    # Example usage:
    # python predict/run_graph_rag.py "local large language models"
    main()
