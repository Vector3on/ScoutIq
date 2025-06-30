import modal
import os
import sys
from datetime import datetime

# ─── Modal Setup ──────────────────────────────────────────────────────────────

# Configure GitHub clone from private repo using env vars
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "your-username/bloodhound-vc")  # Change as needed
GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "main")

if not GITHUB_TOKEN or not GITHUB_REPO:
    print("❌ Missing GITHUB_TOKEN or GITHUB_REPO in environment.")
    sys.exit(1)

repo_url = f"https://oauth2:{GITHUB_TOKEN}@github.com/{GITHUB_REPO}.git"

# Modal image setup
# The version pins for pandas, numpy, and torch-related libraries have been removed
# to allow pip to resolve a set of compatible versions, fixing the error.
image = (
    modal.Image.debian_slim()
    .apt_install("git")
    .pip_install(
        "GitPython",
        "neo4j",
        "pandas",
        "praw",
        "pyarrow",
        "pytorch-forecasting",
        "pytorch-lightning",
        "requests",
        "torch"
    )
)

# Modal volume (for checkpoints or persistent cache if needed)
volume = modal.SharedVolume().persisted("bloodhound-shared-vol")

# ✅ ADD THIS — Stub with secrets
stub = modal.Stub(
    "bloodhound-train-tft",
    secrets=[
        modal.Secret.from_name("GITHUB_TOKEN"),
        modal.Secret.from_name("GITHUB_REPO")
    ]
)

# ─── Modal Function ───────────────────────────────────────────────────────────

@stub.function(
    image=image,
    shared_volumes={"/root/data": volume},
    timeout=1800,
    gpu="A10G",
)
def train_weekly_model():
    import subprocess
    import shutil
    from pathlib import Path

    # Clone the repo
    repo_path = Path("/app/bloodhound-vc")
    if repo_path.exists():
        shutil.rmtree(repo_path)

    print("🔄 Cloning repo...")
    subprocess.run(["git", "clone", "--depth", "1", "--branch", GITHUB_BRANCH, repo_url, str(repo_path)], check=True)
    print("✅ Repo cloned successfully to", repo_path)

    # Add repo to sys.path so it can import predict/
    sys.path.insert(0, str(repo_path))

    # Import training functions
    try:
        from predict import prepare_opal_data, train_tft_model
    except (ModuleNotFoundError, ImportError) as e:
        print(f"❌ Failed to import modules: {e}")
        # An additional check to see what's in the directory can be helpful for debugging
        print("Listing contents of /app/bloodhound-vc:")
        os.system(f"ls -lR {repo_path}")
        sys.exit(1)


    # Call training pipeline
    print("🚀 Starting training pipeline...")
    df = prepare_opal_data.main()
    metrics = train_tft_model.main(df)

    # Save or log training output
    timestamp = datetime.utcnow().isoformat()
    print(f"✅ Training completed at {timestamp} | Metrics: {metrics}")

# ─── Entry ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    stub.deploy("modal_train_tft")
    # The following lines are for running locally; Modal deploy handles the execution in the cloud.
    # with stub.run():
    #     train_weekly_model.remote()
