#!/usr/bin/env python
# scoutiq/scanners/hooks/certspotter_trigger.py
import os
import sys
import json
import time

# This is our simple, file-based message queue for the agent.
TRIGGER_DIR = "/tmp/scoutiq_triggers"

def forward_trigger_to_agent(cert_data: dict):
    """
    Forwards the raw certificate data to the main agent for processing
    by creating a JSON file in a shared directory.
    """
    main_domain = cert_data.get('dns_names', ['unknown_domain'])[0]
    print(f"[CERTSPOTTER_HOOK] New certificate detected for: {main_domain}")
    print(f"[CERTSPOTTER_HOOK] Passing trigger to agent...")

    try:
        os.makedirs(TRIGGER_DIR, exist_ok=True)
        # Use a timestamp and PID for a unique filename
        unique_id = f"{int(time.time() * 1000)}_{os.getpid()}"
        log_file = os.path.join(TRIGGER_DIR, f"cert_{main_domain}_{unique_id}.json")
        with open(log_file, 'w') as f:
            json.dump(cert_data, f, indent=2)
        print(f"[CERTSPOTTER_HOOK] Successfully passed trigger via {log_file}")
    except Exception as e:
        print(f"[CERTSPOTTER_HOOK] ERROR: Could not write trigger file. Reason: {e}", file=sys.stderr)
        sys.exit(1)

def main():
    """
    Parses environment variables set by the certspotter daemon
    and initiates the handoff to the reasoning agent.
    """
    if 'CERTSPOTTER_DNS_NAMES' not in os.environ:
        print("[CERTSPOTTER_HOOK] This script must be run as a certspotter hook.", file=sys.stderr)
        sys.exit(1)

    cert_info = {
        "trigger_source": "certspotter",
        "hook_type": os.environ.get("CERTSPOTTER_HOOK_TYPE"),
        "dns_names": os.environ.get("CERTSPOTTER_DNS_NAMES", "").split(),
        "ca_name": os.environ.get("CERTSPOTTER_CA_NAME"),
    }
    
    forward_trigger_to_agent(cert_info)

if __name__ == "__main__":
    main()