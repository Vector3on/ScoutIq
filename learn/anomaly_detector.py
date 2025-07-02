# learn/anomaly_detector.py
import pandas as pd
from sklearn.preprocessing import MinMaxScaler
from sklearn.neighbors import NearestNeighbors

def get_anomaly_scores(all_projects_data: dict, target_project_id: str):
    """
    Calculates anomaly scores for all projects based on their time series.
    This is a simplified implementation of the contrastive learning concept.
    
    Args:
        all_projects_data (dict): A dictionary where keys are project_ids and 
                                  values are their time series DataFrames.
        target_project_id (str): The specific project we want to score.

    Returns:
        The anomaly score for the target project.
    """
    print(f"\n🔬 Calculating anomaly score for {target_project_id}...")
    
    feature_vectors = {}
    for project_id, df in all_projects_data.items():
        series = df.iloc[:, -1]
        if not series.empty:
            feature_vectors[project_id] = [series.mean(), series.std(), series.max()]

    if len(feature_vectors) < 2:
        print("  - WARN: Need at least 2 projects to calculate anomaly scores.")
        return None

    features_df = pd.DataFrame.from_dict(feature_vectors, orient='index', columns=['mean', 'std', 'max']).fillna(0)
    
    scaler = MinMaxScaler()
    scaled_features = scaler.fit_transform(features_df)

    # --- THIS IS THE FIX ---
    # Set n_neighbors to a value less than the number of samples (which is 4 in our example)
    num_neighbors = min(len(features_df) - 1, 3) # Ensure n_neighbors is always valid
    nbrs = NearestNeighbors(n_neighbors=num_neighbors).fit(scaled_features)
    # --- END FIX ---

    distances, _ = nbrs.kneighbors(scaled_features)
    
    anomaly_scores = pd.Series(distances.mean(axis=1), index=features_df.index)
    
    target_score = anomaly_scores.get(target_project_id)
    
    if target_score is not None:
         print(f"  - ✅ Anomaly Score for {target_project_id}: {target_score:.4f}")
    
    return target_score

if __name__ == '__main__':
    # Example of what the input data would look like
    mock_data = {
        "project_normal_1": pd.DataFrame({'commits': [1,2,1,2,1,3,2,1]}),
        "project_normal_2": pd.DataFrame({'commits': [2,1,3,1,2,1,3,2]}),
        "project_anomaly": pd.DataFrame({'commits': [10,12,15,11,14,13,15,16]}), # High activity
        "project_normal_3": pd.DataFrame({'commits': [3,1,1,2,3,2,1,2]}),
    }
    
    get_anomaly_scores(mock_data, "project_anomaly")
    get_anomaly_scores(mock_data, "project_normal_1")