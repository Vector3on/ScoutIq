# Start from a standard, full-featured Python 3.10 base image provided by Microsoft
FROM mcr.microsoft.com/devcontainers/python:3.10

# Copy our requirements file into the container image to be used for installation
COPY requirements.txt /tmp/pip-tmp/

# This is the crucial step: Run pip install during the image build process.
# This ensures all libraries are installed and available before the Codespace even starts.
RUN pip install --upgrade pip && \
    pip install --no-cache-dir -r /tmp/pip-tmp/requirements.txt
