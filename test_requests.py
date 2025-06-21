import requests

try:
    print("Testing 'requests' library...")
    response = requests.get("https://www.google.com")
    print(f"SUCCESS: Connection successful. Status code: {response.status_code}")
except Exception as e:
    print(f"FAILED: Could not connect. Error: {e}")