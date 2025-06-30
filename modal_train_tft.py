# modal_train_tft.py
import modal
import os

# --- Environment Definition ---
# This section defines the perfect, isolated environment for our training job.
# It specifies the exact, stable library versions we need, solving all dependency conflicts.
stub = modal.Stub("bloodhound-vc-weekly-training")

image = modal.Image.debian_slim(python_version="3.10").pip_install(
    "requests",
    "praw",
    "neo4j",
    "pandas==2.2.2",
    "pyarrow",
    "torch==1.13.1",
    "pytorch-lightning==1.7.7",
    "pytorch-forecasting==0.10.3",
    "GitPython==3.1.43",  # For cloning the repo inside the container
)

# --- The Training Function ---
# This function runs in the cloud, inside the environment we just defined.
# We request a T4 GPU and pass our secrets to it.
@stub.function(
    image=image,
    gpu="T4",  # Request a GPU for faster training
    secrets=[
        modal.Secret.from_name("bloodhound-secrets")
    ],
    timeout=3600,  # Set a 1-hour timeout for the job
    schedule=modal.Cron("0 5 * * 0") # Schedule to run every Sunday at 5:00 AM UTC
)
def train_weekly_model():
    # --- Part 1: Clone the Project Repo ---
    # The container is empty, so we first clone our application code into it.
    print("--> Cloning repository...")
    from git import Repo
    
    repo_path = "/app"
    # We use the GITHUB_TOKEN from the secrets to clone the private repo.
    git_url = f"https://oauth2:{os.environ['GITHUB_TOKEN']}@github.com/{os.environ['GITHUB_REPO']}.git"
    
    if not os.path.exists(repo_path):
        os.makedirs(repo_path)
    
    Repo.clone_from(git_url, repo_path)
    os.chdir(repo_path)
    print(f"✅ Repo cloned successfully into {repo_path}")

    # --- Part 2: Execute the Training Scripts ---
    # Now that we have our code, we can import and run the training logic.
    print("\n--> Executing the training workflow...")
    from predict import prepare_opal_data, train_tft_model

    # The scripts will automatically use the secrets (like NEO4J_URI)
    # because they are loaded as environment variables.
    prepare_opal_data.create_real_timeseries_data()
    train_tft_model.train_model()
    
    # --- Part 3: Verify and Return Result ---
    model_path = "artifacts/tft_model.ckpt"
    if os.path.exists(model_path):
        print(f"✅ SUCCESS: Model file created at {model_path}")
        # In a production scenario, you would upload this model to a storage bucket.
        return f"Training complete. Model '{model_path}' was successfully generated."
    else:
        print(f"❌ FAILURE: Model file was not created.")
        return "Training script finished, but the model file was not found."

