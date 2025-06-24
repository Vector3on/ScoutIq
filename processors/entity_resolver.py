from sentence_transformers import SentenceTransformer, util
import numpy as np
import os

# === START ===
# Placeholder: Replace this with your actual leads fetch method
leads = [...]  # Should be a list of dicts with 'title' keys

# Filter out invalid leads
leads = [lead for lead in leads if isinstance(lead, dict) and 'title' in lead]
if not leads:
    print("No valid leads found, exiting.")
    exit(1)

# Load embeddings model
model = SentenceTransformer("all-mpnet-base-v2")

# Placeholder: Replace this with actual project names fetch method
project_names = ["typst", "ai-engineering-hub", "NotepadNext", "data-engineer-handbook", "LLMs-from-scratch"]
project_embeddings = model.encode(project_names, convert_to_numpy=True)

# Encode lead titles
lead_embeddings = model.encode([lead['title'] for lead in leads], convert_to_numpy=True)

# Compare embeddings and filter by a lower threshold
THRESHOLD = 0.25
results = []
for lead, lead_embedding in zip(leads, lead_embeddings):
    cos_sim = util.cos_sim(lead_embedding, project_embeddings).flatten()
    best_match_score = cos_sim.max()
    best_match_name = project_names[cos_sim.argmax()]
    if best_match_score >= THRESHOLD:
        results.append({
            "lead_title": lead["title"],
            "matched_project": best_match_name,
            "similarity_score": float(best_match_score),
        })

# Output Results
for result in results:
    print(f"MATCHED: [{result['lead_title']}] -> [{result['matched_project']}], Score: {result['similarity_score']:.2f}")

if not results:
    print("No matches found.")
