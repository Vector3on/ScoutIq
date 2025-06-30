import modal
import os
import sys
from datetime import datetime

# ─── Modal Setup ──────────────────────────────────────────────────────────────

# Using modal.App, which is the recommended new pattern.
# The app is named "bloodhound-train-tft", which will be used for deployment.
app = modal.App("bloodhound-train-tft")

# The image definition remains the same. It installs dependencies.
# Version pins for ML libraries are removed to let pip resolve compatible versions.
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

# ─── Modal Function ───────────────────────────────────────────────────────────

@app.function(
    image=image,
    shared_volumes={"/root/data": volume},
    timeout=1800,
    gpu="A10G",
    # All secrets are now loaded from a single group called "bloodhound-secrets".
    # Make sure this secret group exists in your Modal account and contains
    # both GITHUB_TOKEN and GITHUB_REPO.
    secrets=[modal.Secret.from_name("bloodhound-secrets")]
)
def train_weekly_model():
    import subprocess
    import shutil
    from pathlib import Path

    # The function now reads the secrets directly from the environment,
    # which are populated by the `secrets` argument in the decorator.
    GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
    GITHUB_REPO = os.environ.get("GITHUB_REPO")

    if not GITHUB_TOKEN or not GITHUB_REPO:
        print("❌ Missing GITHUB_TOKEN or GITHUB_REPO in environment.")
        print("Ensure they are set in the 'bloodhound-secrets' secret group in Modal.")
        sys.exit(1)

    repo_url = f"https://oauth2:{GITHUB_TOKEN}@github.com/{GITHUB_REPO}.git"
    GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "main")

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

# This block is mainly for local testing and deployment.
# Your GitHub Action `modal deploy modal_train_tft.py` will deploy the `app` object.
if __name__ == "__main__":
    app.deploy()
