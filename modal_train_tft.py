import modal
import os
import sys
from datetime import datetime
from pathlib import Path

# ─── Modal Config ─────────────────────────────────────────────────────────────

# All secrets go under one Modal Secret group: 'bloodhound-secrets'
stub = modal.Stub(
    "bloodhound-train-tft",
    secrets=[modal.Secret.from_name("bloodhound-secrets")]
)

# Image & deps
image = (
    modal.Image.debian_slim()
    .apt_install("git")
    .pip_install(
        "pip==23.3.1",
        "GitPython==3.1.43",
        "neo4j",
        "numpy==1.24.4",
        "pandas==1.5.3",
        "praw",
        "pyarrow",
        "pytorch-forecasting==0.10.3",
        "pytorch-lightning==1.7.6",
        "requests",
        "torch==1.13.1"
    )
)

# Shared volume for persistence if needed
volume = modal.SharedVolume().persisted("bloodhound-shared-vol")

# ─── Train Function ───────────────────────────────────────────────────────────

@stub.function(
    image=image,
    shared_volumes={"/root/data": volume},
    timeout=1800,
    gpu="A10G",
)
def train_weekly_model():
    import subprocess
    import shutil

    GITHUB_TOKEN = os.environ["GITHUB_TOKEN"]
    GITHUB_REPO = os.environ["GITHUB_REPO"]
    GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "main")

    repo_url = f"https://oauth2:{GITHUB_TOKEN}@github.com/{GITHUB_REPO}.git"

    # Clone the repo
    repo_path = Path("/app/bloodhound-vc")
    if repo_path.exists():
        shutil.rmtree(repo_path)

    print("🔄 Cloning repo...")
    subprocess.run(["git", "clone", "--depth", "1", "--branch", GITHUB_BRANCH, repo_url, str(repo_path)], check=True)
    print("✅ Repo cloned successfully to", repo_path)

    # Add repo to sys.path
    sys.path.insert(0, str(repo_path))

    # Import and run training
    try:
        from predict import prepare_opal_data, train_tft_model
    except ModuleNotFoundError as e:
        print("❌ Failed to import modules:", e)
        sys.exit(1)

    print("🚀 Starting training pipeline...")
    df = prepare_opal_data.main()
    metrics = train_tft_model.main(df)

    timestamp = datetime.utcnow().isoformat()
    print(f"✅ Training completed at {timestamp} | Metrics: {metrics}")

# ─── Debug/Test Secrets Function ──────────────────────────────────────────────

@stub.function(secrets=[modal.Secret.from_name("bloodhound-secrets")])
def f():
    print("🔍 GITHUB_REPO:", os.environ["GITHUB_REPO"])

# ─── Entrypoint ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    stub.deploy("modal_train_tft")
    with stub.run():
        # You can run this for testing
        f.remote()

        # Or this for actual training
        train_weekly_model.remote()
