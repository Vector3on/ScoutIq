import gradio as gr
import subprocess
import os
import threading
from kaggle_secrets import UserSecretsClient

# This function will run your entire weekly pipeline
def run_weekly_training():
    log_output = ""
    
    # --- Set Environment Variables for the subprocess ---
    # This is crucial for the script to access your secrets
    env = os.environ.copy()
    try:
        user_secrets = UserSecretsClient()
        env['NEO4J_URI'] = user_secrets.get_secret("NEO4J_URI")
        env['NEO4J_USERNAME'] = user_secrets.get_secret("NEO4J_USERNAME")
        env['NEO4J_PASSWORD'] = user_secrets.get_secret("NEO4J_PASSWORD")
        env['GITHUB_TOKEN'] = user_secrets.get_secret("GITHUB_TOKEN")
        env['GITHUB_REPO'] = user_secrets.get_secret("GITHUB_REPO")
    except Exception as e:
        yield f"ERROR: Could not fetch secrets from Hugging Face. Please ensure they are set.\n{e}"
        return

    # Command to run the weekly training script
    command = ["python", "weekly_training_run.py"]
    
    log_output += f"🚀 Starting weekly training run with command: {' '.join(command)}\n"
    log_output += "------------------------------------------------------------\n"
    yield log_output

    # Run the command as a subprocess and stream the output
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        bufsize=1,
        universal_newlines=True,
    )

    for line in process.stdout:
        log_output += line
        yield log_output
    
    process.wait()
    
    log_output += "\n------------------------------------------------------------\n"
    
    # --- Verify the result ---
    MODEL_PATH = "artifacts/tft_model.ckpt"
    if os.path.exists(MODEL_PATH):
        log_output += f"✅ SUCCESS: Model file found at {MODEL_PATH}.\n"
        # Here you would add the 'gh artifact upload' logic if needed
    else:
        log_output += f"❌ FAILURE: Model file {MODEL_PATH} was not found after training.\n"
        
    log_output += "🎉 Weekly training process complete."
    yield log_output


# --- Build the Gradio Interface ---
with gr.Blocks() as demo:
    gr.Markdown("# 🩸 Bloodhound VC - Weekly OPAL Training")
    gr.Markdown("Click the button below to start the weekly heavy-lifting job. This will prepare the data and train the Temporal Fusion Transformer model. Logs will appear below in real-time.")
    
    start_button = gr.Button("Run Weekly Training", variant="primary")
    log_textbox = gr.Textbox(label="Live Logs", lines=30, interactive=False)
    
    start_button.click(
        fn=run_weekly_training,
        inputs=[],
        outputs=[log_textbox]
    )

demo.launch()
