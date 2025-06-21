import os

# Get the directory where this script is located
# This makes it robust, no matter where you run it from.
project_root = os.path.dirname(os.path.abspath(__file__))

print("="*50)
print(f"VERIFYING FILE STRUCTURE FOR: {project_root}")
print("="*50)

# Walk through the directory tree
for root, dirs, files in os.walk(project_root):
    # Don't show the contents of the .git folder, it's irrelevant noise
    if '.git' in dirs:
        dirs.remove('.git')
        
    level = root.replace(project_root, '').count(os.sep)
    indent = ' ' * 4 * (level)
    print(f'{indent}{os.path.basename(root)}/')
    sub_indent = ' ' * 4 * (level + 1)
    for f in files:
        print(f'{sub_indent}{f}')

print("="*50)
print("VERIFICATION COMPLETE.")