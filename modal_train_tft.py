# modal_train_tft.py (Final-Fixed with import path patch)
import modal
import os
import subprocess
import sys

# --- Define Modal App and Image ---
app = modal.App("bloodhound-vc-weekly-training")

image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install("pip==24.0")
    .pip_install(
        "requests",
        "praw",
        "neo4j",
        "pandas==1.5.3",  # ✅ Compatible with pytorch-forecasting 0.10.3
        "pyarrow",
        "torch==1.13.1",
        "pytorch-lightning==1.7.7",
        "pytorch-forecasting==0.10.3",
        "GitPython==3.1.43",
    )
)

@app.function(
    image=image,
    gpu="T4",
    secrets=[modal.Secret.from_name("bloodhound-secrets")],
    timeout=3600,
    schedule=modal.Cron("0 5 * * 0"),  # Every Sunday at 5:00 AM UTC
)
def train_weekly_model():
    print("--> Verifying git availability...")
    try:
        subprocess.run(["git", "--version"], check=True)
    except Exception:
        print("Installing git...")
        subprocess.run(["apt", "update"], check=True)
        subprocess.run(["apt", "install", "-y", "git"], check=True)

    from git import Repo

    print("--> Cloning repository...")
    repo_path = "/app/bloodhound-vc"
    github_token = os.environ["GITHUB_TOKEN"]
    github_repo = os.environ["GITHUB_REPO"]  # e.g., ruthvik007/bloodhound-vc
    git_url = f"https://oauth2:{github_token}@github.com/{github_repo}.git"

    if not os.path.exists(repo_path):
        os.makedirs(repo_path)

    try:
        Repo.clone_from(git_url, repo_path)
        print(f"✅ Repo cloned successfully to {repo_path}")
    except Exception as e:
        print(f"❌ Git clone failed: {e}")
        sys.exit(1)

    os.chdir(repo_path)

    # ⛏️ Fix: Inject cloned repo into sys.path
    sys.path.insert(0, repo_path)

    print("--> Running training scripts...")
    try:
        from predict import prepare_opal_data, train_tft_model
        prepare_opal_data.create_real_timeseries_data()
        train_tft_model.train_model()
    except Exception as e:
        print(f"❌ Training error: {e}")
        sys.exit(1)

    model_path = "artifacts/tft_model.ckpt"
    if os.path.exists(model_path):
        print(f"✅ Model created: {model_path}")
        return f"Training complete. Model stored at {model_path}"
    else:
        print("❌ Model file not found.")
        return "Training completed, but model file missing."
