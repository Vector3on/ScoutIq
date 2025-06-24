import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
from sentence_transformers import SentenceTransformer

# Threshold adjusted to be more forgiving
THRESHOLD = 0.25

# Dummy placeholders for actual data loading:
# Replace these with your actual database fetch methods.
leads = [...]            # List of dicts: [{'title': 'string'}, ...]
project_names = [...]    # List of project names

# Load embeddings model
model = SentenceTransformer("all-mpnet-base-v2")

# Compute embeddings
lead_embeddings = model.encode([lead['title'] for lead in leads], convert_to_numpy=True)
project_embeddings = model.encode(project_names, convert_to_numpy=True)

# Perform match
matches = []
for i, lead in enumerate(leads):
    lead_emb = lead_embeddings[i].reshape(1, -1)
    scores = cosine_similarity(lead_emb, project_embeddings).flatten()
    best_match_index = np.argmax(scores)
    best_score = scores[best_match_index]
    best_project = project_names[best_match_index]
    
    if best_score >= THRESHOLD:
        matches.append((lead['title'], best_project, best_score))
        print(f"MATCHED [{lead['title']}] -> [{best_project}], Score: {best_score:.2f}")
    else:
        print(f"NO MATCH [{lead['title']}], Score: {best_score:.2f}")

# Output results or save as needed
print("Summary of Matches:")
for match in matches:
    print(f"Lead: {match[0]}, Project: {match[1]}, Score: {match[2]:.2f}")
