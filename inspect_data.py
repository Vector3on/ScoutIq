import torch

data_file = 'radt_preprocessed_data_v8.pt'
print(f"--- Inspecting data in '{data_file}' ---")

try:
    data = torch.load(data_file)
    print("Keys found in the data file:")
    print(list(data.keys()))
except FileNotFoundError:
    print(f"Error: Could not find the file '{data_file}'")
except Exception as e:
    print(f"An error occurred: {e}")