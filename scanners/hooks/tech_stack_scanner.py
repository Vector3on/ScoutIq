# scanners/tech_stack_scanner.py
import sys
import json
import subprocess

def scan_technology_stack(domain: str):
    """
    Uses the wappalyzergo command-line tool to identify the technology
    stack of a given domain and prints the output as JSON.
    """
    if not domain:
        print(json.dumps({"error": "No domain provided"}), file=sys.stderr)
        sys.exit(1)

    target_url = f"https://{domain}"
    # This message now goes to stderr, so it doesn't interfere with the JSON output on stdout.
    print(f"[SCANNER:WAPPALYZERGO] Probing tech stack for: {target_url}", file=sys.stderr)

    try:
        # The key change is adding 'stderr=subprocess.PIPE'
        result = subprocess.run(
            ["wappalyzergo", "-t", target_url, "-j"],
            capture_output=True,
            text=True,
            check=True,
            encoding='utf-8',
            stderr=subprocess.PIPE # Capture the standard error stream
        )
        # On success, print the JSON result to standard output
        print(result.stdout)

    except FileNotFoundError:
        error_msg = {"error": "wappalyzergo command not found. Please ensure it is installed and in your PATH."}
        print(json.dumps(error_msg), file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        # If the command fails, print a structured error message to standard error
        # This includes the actual error output from wappalyzergo
        error_msg = {
            "error": "wappalyzergo failed to run.",
            "returncode": e.returncode,
            "wappalyzergo_stderr": e.stderr.strip()
        }
        print(json.dumps(error_msg), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        target_domain = sys.argv[1]
        scan_technology_stack(target_domain)
    else:
        print("Usage: python scanners/tech_stack_scanner.py <domain_to_scan>", file=sys.stderr)
        sys.exit(1)