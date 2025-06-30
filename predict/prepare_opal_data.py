# predict/prepare_opal_data.py
import os
import pandas as pd
from neo4j import GraphDatabase
from datetime import datetime, timedelta

# --- Configuration ---
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")
OUTPUT_DATA_PATH = "artifacts/real_timeseries_data.parquet"

def create_real_timeseries_data():
    """
    Connects to Neo4j, queries real signal data, and aggregates it into a
    daily time-series format suitable for TFT model training.
    """
    if not NEO4J_PASSWORD:
        print("    - WARN: NEO4J_PASSWORD not found. Skipping data preparation.")
        return

    print("--- Preparing Real Time-Series Data for OPAL ---")
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    
    all_project_data = []

    with driver.session(database="neo4j") as session:
        # This query fetches all signals and groups them by project and day
        query = """
        MATCH (p:Project)-[:HAS_SIGNAL]->(s:Signal)
        RETURN
            p.project_id AS project_id,
            date(s.created_at) AS day,
            count(s) AS mention_count,
            sum(s.upvotes) AS daily_upvotes
        ORDER BY day
        """
        print("  - Querying Neo4j for daily signal aggregations...")
        results = session.run(query)
        
        df = pd.DataFrame([r.data() for r in results])
        if df.empty:
            print("  - ERROR: No signal data found in Neo4j. Cannot prepare data.")
            driver.close()
            return
            
        df['day'] = pd.to_datetime(df['day'].to_py_date())

    print(f"  - Processing data for {df['project_id'].nunique()} projects...")
    # Create a complete date range to fill missing days with zeros
    full_date_range = pd.date_range(start=df['day'].min(), end=df['day'].max(), freq='D')
    
    final_df = pd.DataFrame()
    for project_id in df['project_id'].unique():
        project_df = df[df['project_id'] == project_id].set_index('day')
        project_df = project_df.reindex(full_date_range, fill_value=0)
        project_df['project_id'] = project_id
        project_df = project_df.reset_index().rename(columns={'index': 'day'})
        final_df = pd.concat([final_df, project_df])

    # Add time_idx, which is required by PyTorch Forecasting
    final_df = final_df.sort_values(by=['project_id', 'day'])
    final_df['time_idx'] = final_df.groupby('project_id').cumcount()

    # Ensure correct data types
    final_df['mention_count'] = final_df['mention_count'].astype(float)
    final_df['daily_upvotes'] = final_df['daily_upvotes'].astype(float)

    os.makedirs(os.path.dirname(OUTPUT_DATA_PATH), exist_ok=True)
    final_df.to_parquet(OUTPUT_DATA_PATH)
    
    print(f"✅ Real time-series data saved to {OUTPUT_DATA_PATH} with {len(final_df)} rows.")
    driver.close()

if __name__ == "__main__":
    create_real_timeseries_data()
