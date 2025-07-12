import torch
from torch.utils.data import Dataset
import os

class RADTTrajectoryDataset(Dataset):
    """
    A PyTorch Dataset that loads a single, pre-processed data file
    containing padded trajectories.
    """
    def __init__(self, processed_file="radt_preprocessed_data.pt"):
        
        if not os.path.exists(processed_file):
            raise FileNotFoundError(f"Processed data file not found: {processed_file}. Please run preprocess_data.py first.")
            
        print("Loading pre-processed data...")
        self.data = torch.load(processed_file)
        print("Data loaded successfully.")

    def __len__(self):
        return len(self.data['states'])

    def __getitem__(self, idx):
        # Simply return the pre-processed tensors for the given index
        return {
            'states': self.data['states'][idx],
            'actions': self.data['actions'][idx],
            'returns_to_go': self.data['returns_to_go'][idx],
            'goal': self.data['goal'][idx],
            'avoid': self.data['avoid'][idx] # <-- This line was missing
        }