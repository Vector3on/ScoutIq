# collectors/gemini_github_collector.py

import random
from datetime import datetime, timezone

# A hardcoded list of influential repositories to track.
PROJECT_LIST = [
    "ollama/ollama", "ggerganov/llama.cpp", "langchain-ai/langchain",
    "facebookresearch/llama", "AUTOMATIC1111/stable-diffusion-webui",
    "vllm-project/vllm", "huggingface/transformers", "huggingface/diffusers",
    "microsoft/guidance", "InternLM/InternLM", "openai/openai-python",
    "google/gemini.py", "NVIDIA/TensorRT-LLM", "triton-lang/triton",
    "liltom-eth/llama2-webui", "CorentinJ/Real-Time-Voice-Cloning",
    "lobe/lobe-chat", "dortania/OpenCore-Legacy-Patcher"
]

def get_mock_github_data(repo_full_name):
    """Mocks fetching data from GitHub API."""
    owner, name = repo_full_name.split('/')
    return {
        "full_name": repo_full_name,
        "name": name,
        "owner": owner,
        "description": f"A mock description for {name}.",
        "stargazers_count": random.randint(1000, 100000),
        "html_url": f"https://github.com/{repo_full_name}"
    }

def collect_signals():
    """
    Collects GitHub project data and transforms it into a list of standardized Signal objects.
    This function NO LONGER connects to a database.
    """
    print("  - Collecting signals from GitHub...")
    signals = []
    ingestion_time = datetime.now(timezone.utc)

    for repo_full_name in set(PROJECT_LIST):
        data = get_mock_github_data(repo_full_name)
        
        signal = {
            "signalId": f"github-{repo_full_name.replace('/', '-')}-{ingestion_time.strftime('%Y%m%d')}",
            "project_id": data['full_name'],
            "source": "GitHub",
            "signalUrl": data['html_url'],
            "title": data.get('description', 'No description available.'),
            "upvotes": data['stargazers_count'],
            "createdAt": ingestion_time.isoformat(), # This is a snapshot, so createdAt is now
            "ingestedAt": ingestion_time.isoformat()
        }
        signals.append(signal)
        
    print(f"    - GitHub: Collected {len(signals)} project signals.")
    return signals
