# modal_train_tft.py
import modal
import os

app = modal.App("bloodhound-vc-weekly-training")

# Build the custom image with system and pip dependencies
image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git")  # 👈 CRUCIAL: Install actual git binary
    .pip_install(
        "requests",
        "praw",
        "neo4j",
        "pandas==2.2.2",
        "pyarrow",
        "torch==1.13.1",
        "pytorch-lightning==1.7.7",
        "pytorch-forecasting==0.10.3",
        "GitPython==3.1.43"
    )
)

@app.function(
    image=image,
    gpu="T4",
    secrets=[modal.Secret.from_name("bloodhound-secrets")],
    timeout=3600,
    schedule=modal.Cron("0 5 * * 0")  # Every Sunday 5:00AM UTC
)
def train_weekly_model():
    print("--> Cloning repository...")
    from git import Repo

    repo_path = "/app"
    git_url = f"https://oauth2:{os.environ['GITHUB_TOKEN']}@github.com/{os.environ['GITHUB_REPO']}.git"

    if not os.path.exists(repo_path):
        os.makedirs(repo_path)

    Repo.clone_from(git_url, repo_path)
    os.chdir(repo_path)
    print(f"✅ Repo cloned successfully into {repo_path}")

    print("\n--> Executing the training workflow...")
    from predict import prepare_opal_data, train_tft_model

    prepare_opal_data.create_real_timeseries_data()
    train_tft_model.train_model()

    model_path = "artifacts/tft_model.ckpt"
    if os.path.exists(model_path):
        print(f"✅ SUCCESS: Model file created at {model_path}")
        return f"Training complete. Model '{model_path}' was successfully generated."
    else:
        print(f"❌ FAILURE: Model file was not created.")
        return "Training script finished, but the model file was not found."
