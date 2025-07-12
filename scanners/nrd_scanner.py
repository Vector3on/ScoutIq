# scanners/nrd_scanner.py
import os
import json
import requests
from pathlib import Path

# The authenticated headers for the GitHub API
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
HEADERS = {'Authorization': f'token {GITHUB_TOKEN}'} if GITHUB_TOKEN else {}

NRD_API_BASE_URL = "https://api.github.com/repos/xRuffKez/NRD/contents/"
TRIGGER_DIR = "/tmp/scoutiq_triggers"
KEYWORDS = ["ai", "labs", "protocol", "agent", "foundation", "vllm", "mlx"]

def get_all_domain_files(url: str, headers: dict) -> list:
    """
    Recursively fetches all items from the NRD repository that end in .txt.
    """
    print(f"[NRD_SCANNER] Fetching contents from: {url}")
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    contents = response.json()
    
    text_files = []
    for item in contents:
        if not isinstance(item, dict):
            continue
        if item.get('type') == 'file' and item.get('name', '').endswith('.txt'):
            text_files.append(item)
        elif item.get('type') == 'dir':
            text_files.extend(get_all_domain_files(item.get('url'), headers))
            
    return text_files

def find_interesting_domains():
    """
    Fetches NRD lists via authenticated GitHub API calls, filters for keywords,
    and creates trigger files for the main agent.
    """
    if not GITHUB_TOKEN:
        print("[NRD_SCANNER] ERROR: GITHUB_TOKEN is not set. Cannot make authenticated API calls.")
        return

    print("[NRD_SCANNER] Starting authenticated API scan for newly registered domains...")
    
    try:
        domain_files = get_all_domain_files(NRD_API_BASE_URL, HEADERS)
        if not domain_files:
            print("[NRD_SCANNER] Could not find any .txt domain lists in the repository.")
            return
            
        found_domains = set()
        print(f"[NRD_SCANNER] Found {len(domain_files)} domain lists. Fetching and filtering...")
        
        for item in domain_files:
            download_url = item.get('download_url')
            if not download_url: continue
            
            # --- THIS IS THE FIX ---
            # Using the correct, all-caps 'HEADERS' variable
            file_content_response = requests.get(download_url, headers=HEADERS)
            if file_content_response.status_code != 200: continue
            
            for line in file_content_response.text.splitlines():
                if any(keyword in line for keyword in KEYWORDS):
                    found_domains.add(line.strip())

        if not found_domains:
            print("[NRD_SCANNER] No new domains found matching keywords.")
            return

        print(f"[NRD_SCANNER] Found {len(found_domains)} interesting domains. Creating triggers...")
        for domain in found_domains:
            trigger_data = {
                "trigger_source": "certspotter",
                "dns_names": [domain],
                "ca_name": "Newly Registered Domain"
            }
            trigger_filepath = os.path.join(TRIGGER_DIR, f"nrd_{domain}.json")
            with open(trigger_filepath, 'w') as f:
                json.dump(trigger_data, f)
        
        print(f"[NRD_SCANNER] {len(found_domains)} triggers created in {TRIGGER_DIR}")

    except requests.exceptions.RequestException as e:
        print(f"[NRD_SCANNER] ERROR: Failed to fetch data from GitHub API. {e}")
    except Exception as e:
        print(f"[NRD_SCANNER] ERROR: An unexpected error occurred. {e}")

if __name__ == "__main__":
    find_interesting_domains()