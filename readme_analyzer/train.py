# readme_analyzer/train.py
import json
import pandas as pd
import torch
from pathlib import Path
from sklearn.model_selection import train_test_split
from transformers import DistilBertTokenizerFast, DistilBertForSequenceClassification, Trainer, TrainingArguments

class ReadmeDataset(torch.utils.data.Dataset):
    """Custom PyTorch Dataset for our README data."""
    def __init__(self, encodings, labels):
        self.encodings = encodings
        self.labels = labels

    def __getitem__(self, idx):
        item = {key: torch.tensor(val[idx]) for key, val in self.encodings.items()}
        item['labels'] = torch.tensor(self.labels[idx], dtype=torch.float)
        return item

    def __len__(self):
        return len(self.labels)

def load_and_prepare_data(filepath: str):
    """Loads the annotated JSON, calculates an average score, and splits the data."""
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)

    annotated_data = [d for d in data if d.get('clarity_score', 0) != 0]
    
    if not annotated_data:
        raise ValueError("No annotated data found in the dataset file. Please annotate some READMEs first.")

    df = pd.DataFrame(annotated_data)
    df['avg_score'] = df[['clarity_score', 'vision_score', 'problem_solution_fit']].mean(axis=1)

    train_texts, val_texts, train_labels, val_labels = train_test_split(
        df['readme_content'].tolist(),
        df['avg_score'].tolist(),
        test_size=0.2,
        random_state=42
    )
    return train_texts, val_texts, train_labels, val_labels

def main():
    """Main function to orchestrate the model training process."""
    
    script_dir = Path(__file__).resolve().parent
    DATASET_PATH = script_dir.parent / "readme_dataset.json"
    MODEL_OUTPUT_DIR = script_dir / "model_output"
    LOGGING_DIR = script_dir / "logs"
    
    print("--- Starting Readme-Analyzer Training ---")
    
    # 1. Load and prepare data
    train_texts, val_texts, train_labels, val_labels = load_and_prepare_data(DATASET_PATH)
    print(f"Loaded {len(train_texts)} training samples and {len(val_texts)} validation samples.")

    # 2. Tokenize the texts
    tokenizer = DistilBertTokenizerFast.from_pretrained('distilbert-base-uncased')
    train_encodings = tokenizer(train_texts, truncation=True, padding=True, max_length=512)
    val_encodings = tokenizer(val_texts, truncation=True, padding=True, max_length=512)

    train_dataset = ReadmeDataset(train_encodings, train_labels)
    val_dataset = ReadmeDataset(val_encodings, val_labels)

    # 3. Initialize the model for regression
    model = DistilBertForSequenceClassification.from_pretrained(
        'distilbert-base-uncased',
        num_labels=1 
    )

    # 4. Define Training Arguments
    # MODIFIED: Changed 'evaluation_strategy' to 'eval_strategy' to remove the warning.
    training_args = TrainingArguments(
        output_dir=str(MODEL_OUTPUT_DIR),
        num_train_epochs=3,
        per_device_train_batch_size=4,
        per_device_eval_batch_size=4,
        warmup_steps=50,
        weight_decay=0.01,
        logging_dir=str(LOGGING_DIR),
        logging_steps=10,
        eval_strategy="epoch" # This is the non-deprecated argument
    )

    # 5. Initialize and run the Trainer
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset
    )
    
    trainer.train()
    
    # 6. Save the final model and tokenizer
    model.save_pretrained(str(MODEL_OUTPUT_DIR))
    tokenizer.save_pretrained(str(MODEL_OUTPUT_DIR))

    print(f"--- Training Complete. Model saved to {MODEL_OUTPUT_DIR} ---")

if __name__ == "__main__":
    main()