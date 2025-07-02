import os

slack_url = os.environ.get("SLACK_WEBHOOK_URL")

print("--- Checking SLACK_WEBHOOK_URL Secret ---")
if slack_url:
    print("✅ Secret FOUND.")
    # Print only a portion of the URL for security
    print(f"   Value starts with: {slack_url[:35]}...")
else:
    print("❌ Secret NOT FOUND.")
    print("   Please ensure the secret is named exactly 'SLACK_WEBHOOK_URL' in your Codespace settings.")
print("------------------------------------")