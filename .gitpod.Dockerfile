# This Dockerfile defines the base environment for our Gitpod workspace.
FROM gitpod/workspace-full

# We will use Conda to manage our Python environment
# to ensure we get the exact Python version and libraries we need.
USER gitpod

# Install Miniconda
RUN wget https://repo.anaconda.com/miniconda/Miniconda3-py310_23.11.0-2-Linux-x86_64.sh -O ~/miniconda.sh && \
    /bin/bash ~/miniconda.sh -b -p $HOME/miniconda

# Add conda to the PATH
ENV PATH=$HOME/miniconda/bin:$PATH

# Create the stable environment with Python 3.10 and the core ML libraries
RUN conda create -n bloodhound_env python=3.10 pytorch=1.13.1 pytorch-lightning=1.7.7 pytorch-forecasting=0.10.3 -c pytorch -c conda-forge -y

# Copy the requirements file into the container
COPY --chown=gitpod:gitpod requirements.txt /tmp/requirements.txt

# Install the remaining packages using pip inside our new conda environment
RUN /bin/bash -c "source $HOME/miniconda/bin/activate bloodhound_env && pip install -r /tmp/requirements.txt"

