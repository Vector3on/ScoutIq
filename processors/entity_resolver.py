import os
import time
import json
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
from sentence_transformers import SentenceTransformer
from neo4j import GraphDatabase

# CONFIG
URI = os.environ.get("NEO4J_URI")
USERNAME = os.environ.get("NEO4J_USERNAME")
PASSWORD = os.environ.get("NEO4J_PASSWORD")
SIMILARITY_THRESHOLD = 0.75  # Adjust as needed (0–1)

# LOAD EMBEDDING MODEL ONCE
embedding_model = SentenceTransformer('all-mpnet-base-v2')

def encode(texts):
    """Encode texts to embeddings."""
    return embedding_model.encode(texts, show_progress_bar=False)

def run_resolver():
    """Main routine for matching Reddit leads to Project names."""
    if not URI:
        print("    - FATAL: Neo4j credentials not found.")
        return

    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    with driver.session() as session:
        project_results = session.run("MATCH (p:Project) RETURN p.display_name AS name")
        project_names = [record["name"] for record in project_results]

        signal_results = session.run("""
            MATCH (s:Signal:Reddit) 
            WHERE NOT (s)<-[:HAS_SIGNAL]-() 
            RETURN s.title AS title, s.url AS url
        """)
        reddit_leads = [{"title": record["title"], "url": record["url"]} for record in signal_results]

        if not reddit_leads:
            print("\n=== No Reddit leads to link. Done. ===")
            return

        print(f"\n=== TOTAL Reddit leads to link: {len(reddit_leads)} ===")

        # Get embeddings
        project_embeddings = encode(project_names)
        lead_embeddings = encode([lead["title"] for lead in reddit_leads])

        links_created = 0
        for lead, lead_emb in zip(reddit_leads, lead_embeddings):
            cos_sims = cosine_similarity([lead_emb], project_embeddings)[0]
            best_match_index = np.argmax(cos_sims)
            best_score = cos_sims[best_match_index]
            best_match_name = project_names[best_match_index]

            if best_score >= SIMILARITY_THRESHOLD:
                print(f"  - MATCH [{lead['title'][:40]}...] ==> [{best_match_name}], Score: {best_score:.2f}")
                session.run("""
                    MATCH (p:Project {display_name: $p_name}), (s:Signal {url: $url})
                    MERGE (p)-[:HAS_SIGNAL]->(s)
                """, p_name=best_match_name, url=lead["url"])
                links_created += 1
            else:
                print(f"  - NO MATCH [{lead['title'][:40]}...], Score: {best_score:.2f}")

        print(f"=== AI Resolution Complete. {links_created}/{len(reddit_leads)} links created. ===")

    driver.close()


if __name__ == '__main__':
    run_resolver()
