# predict/build_index.py
#
# Part of the PREDICT LAYER
#
# Objective:
# 1. Load the graph object with pre-computed embeddings.
# 2. Extract all node embeddings into a single matrix.
# 3. Build a FAISS index for efficient similarity search.
# 4. Save the FAISS index and the corresponding node ID mapping.

import os
import pickle
import numpy as np
import faiss

# --- Configuration ---
INPUT_GRAPH_PATH = "artifacts/hetero_graph_with_embeddings.gpickle"
OUTPUT_INDEX_PATH = "artifacts/graph_faiss.index"
OUTPUT_MAPPING_PATH = "artifacts/node_id_mapping.pkl"

def build_faiss_index():
    """
    Builds and saves a FAISS index from graph node embeddings.
    """
    print("--- Starting FAISS Index Construction ---")

    # 1. Load the graph
    print(f"Loading graph from {INPUT_GRAPH_PATH}...")
    try:
        with open(INPUT_GRAPH_PATH, 'rb') as f:
            G = pickle.load(f)
    except FileNotFoundError:
        print(f"Error: Graph file not found at {INPUT_GRAPH_PATH}. Please run observe/build_graph.py first.")
        return

    # 2. Extract embeddings and corresponding node IDs
    node_ids = []
    embeddings = []
    for node_id, data in G.nodes(data=True):
        if 'embedding' in data:
            node_ids.append(node_id)
            embeddings.append(data['embedding'])
            
    if not embeddings:
        print("No embeddings found in graph. Aborting index build.")
        return

    print(f"Extracted {len(embeddings)} embeddings from graph nodes.")
    
    # Convert to a NumPy matrix
    embedding_matrix = np.array(embeddings).astype('float32')
    d = embedding_matrix.shape[1]  # Dimensionality of the embeddings

    # 3. Build the FAISS index
    # Using IndexFlatL2, a basic but effective index for dense vectors.
    # L2 distance is equivalent to ranking by cosine similarity on normalized vectors.
    print(f"Building FAISS index with dimension {d}...")
    index = faiss.IndexFlatL2(d)
    index.add(embedding_matrix)
    
    print(f"FAISS index built. Total entries: {index.ntotal}")

    # 4. Save the index and the node ID mapping
    os.makedirs(os.path.dirname(OUTPUT_INDEX_PATH), exist_ok=True)
    faiss.write_index(index, OUTPUT_INDEX_PATH)
    print(f"FAISS index saved to {OUTPUT_INDEX_PATH}")
    
    with open(OUTPUT_MAPPING_PATH, 'wb') as f:
        pickle.dump(node_ids, f)
    print(f"Node ID mapping saved to {OUTPUT_MAPPING_PATH}")

if __name__ == "__main__":
    build_faiss_index()

