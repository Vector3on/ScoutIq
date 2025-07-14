import os
import json
import argparse
import shutil

def find_anomalies(trajectory_dir: str, anomaly_dir: str):
    """
    Scans a directory of simulation trajectories for anomalous runs.

    Anomalies are defined by a set of heuristics, such as unusually fast
    growth, surviving in a near-bankrupt state, or finding exploits.
    """
    print(f"--- Starting Blacksite Anomaly Scan on '{trajectory_dir}' ---")
    if not os.path.exists(anomaly_dir):
        os.makedirs(anomaly_dir)
        print(f"Created anomaly directory: {anomaly_dir}")

    found_count = 0
    for filename in os.listdir(trajectory_dir):
        if not filename.endswith('.json'):
            continue

        filepath = os.path.join(trajectory_dir, filename)
        with open(filepath, 'r') as f:
            history = json.load(f)

        # Extract the final state from the end event
        final_state = next((item['final_state'] for item in history if item.get("name") == "simulation_end"), None)

        if not final_state:
            continue

        # --- Anomaly Heuristics ---
        is_anomaly = False
        reason = ""

        # Heuristic 1: Extreme capital efficiency (high progress with low team size)
        if final_state.get('product_progress', 0) > 80 and final_state.get('team_size', 0) <= 2:
            is_anomaly = True
            reason = "Extreme Capital Efficiency"

        # Heuristic 2: "Zombie" company (survived long with very low capital)
        # This requires checking history, a more advanced feature to add later.

        # Heuristic 3: Massive final capital reserve
        if final_state.get('capital', 0) > 500000:
            is_anomaly = True
            reason = "Massive Capital Reserve"

        if is_anomaly:
            found_count += 1
            print(f"  [ANOMALY DETECTED] File: {filename}, Reason: {reason}")
            # Copy the anomalous trajectory for later analysis
            shutil.copy(filepath, os.path.join(anomaly_dir, filename))

    print(f"\n--- Scan Complete. Found and logged {found_count} anomalies. ---")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scan simulation trajectories for anomalous behavior.")
    parser.add_argument('--trajectory_dir', type=str, required=True, help='Directory containing simulation .json files.')
    parser.add_argument('--anomaly_dir', type=str, default='simulation/blacksite/', help='Directory to store anomalous trajectories.')
    args = parser.parse_args()

    find_anomalies(args.trajectory_dir, args.anomaly_dir)