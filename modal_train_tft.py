# modal_train_tft.py
import modal
import os

# --- Environment Definition ---
# Isolated environment with compatible package versions
app = modal.App("bloodhound-vc-weekly-training")

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git")  # ✅ Required for GitPython to work
    .pip_install("pip==24.0")  # ✅ Avoids lightning metadata issue with pip 24+
    .pip_install(
        "requests",
        "praw",
        "neo4j",
        "pandas==1.5.3",                  # ✅ Compatible with pytorch-forecasting 0.10.3
        "pyarrow",
        "torch==1.13.1",
        "pytorch-lightning==1.7.7",       # ✅ Stable lightning
        "pytorch-forecasting==0.10.3",    # ✅ Requires pandas <2.0
        "GitPython==3.1.43"
    )
)

# --- The Training Function ---
@app.function(
    image=image,
    gpu="T4",  # GPU training
    secrets=[modal.Secret.from_name("bloodhound-secrets")],
    timeout=3600,
    schedule=modal.Cron("0 5 * * 0")  # Every Sunday at 5:00 AM UTC
)
def train_weekly_model():
    # --- Part 1: Clone the Repo ---
    print("--> Cloning repository...")
    from git import Repo

    repo_path = "/app"
    git_url = f"https://oauth2:{os.environ['GITHUB_TOKEN']}@github.com/{os.environ['GITHUB_REPO']}.git"

    if not os.path.exists(repo_path):
        os.makedirs(repo_path)

    Repo.clone_from(git_url, repo_path)
    os.chdir(repo_path)
    print(f"✅ Repo cloned successfully into {repo_path}")

    # --- Part 2: Run Training ---
    print("\n--> Executing the training workflow...")
    from predict import prepare_opal_data, train_tft_model

    prepare_opal_data.create_real_timeseries_data()
    train_tft_model.train_model()

    # --- Part 3: Confirm Output ---
    model_path = "artifacts/tft_model.ckpt"
    if os.path.exists(model_path):
        print(f"✅ SUCCESS: Model file created at {model_path}")
        return f"Training complete. Model '{model_path}' was successfully generated."
    else:
        print("❌ FAILURE: Model file was not created.")
        return "Training script finished, but the model file was not found."
