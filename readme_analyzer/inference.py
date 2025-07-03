# readme_analyzer/inference.py
import torch
from pathlib import Path
from transformers import DistilBertTokenizerFast, DistilBertForSequenceClassification

class ReadmeScorer:
    """A class to load the trained Readme-Analyzer model and score new READMEs."""
    def __init__(self, model_path=None):
        if model_path is None:
            # Default to the path where our training script saves the model
            model_path = Path(__file__).resolve().parent / "model_output"
            
        print(f"--- Loading Readme-Analyzer model from: {model_path} ---")
        try:
            self.model = DistilBertForSequenceClassification.from_pretrained(model_path)
            self.tokenizer = DistilBertTokenizerFast.from_pretrained(model_path)
            # Set the model to evaluation mode
            self.model.eval()
            print("--- Model loaded successfully. ---")
        except OSError:
            print(f"--- ❌ ERROR: Model not found at {model_path}. Please train the model first by running train.py. ---")
            self.model = None
            self.tokenizer = None

    def score(self, text: str) -> float:
        """
        Takes a README text string and returns a quality score between 1 and 5.
        """
        if not self.model or not self.tokenizer or not text:
            return 1.0 # Return lowest score if model isn't loaded or text is empty

        inputs = self.tokenizer(
            text, 
            return_tensors="pt", 
            truncation=True, 
            padding=True, 
            max_length=512
        )

        with torch.no_grad():
            outputs = self.model(**inputs)
            score = outputs.logits.item()
        
        # Clamp the score to our expected 1-5 range
        return max(1.0, min(5.0, score))

#
# THIS IS THE CRUCIAL LINE THAT WAS LIKELY MISSING:
# It creates the 'readme_scorer' instance that the other scripts import.
#
readme_scorer = ReadmeScorer()