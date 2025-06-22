name: Bloodhound Logic Autopsy

on:
  workflow_dispatch:

jobs:
  run-autopsy:
    runs-on: ubuntu-latest
    
    steps:
    - name: Check out repository code
      uses: actions/checkout@v4

    - name: Set up Python 3.11
      uses: actions/setup-python@v5
      with:
        python-version: '3.11'

    - name: Install dependencies
      run: |
        python -m pip install --upgrade pip
        pip install -r requirements.txt

    - name: Run Data Collectors
      env:
        NEO4J_URI: ${{ secrets.NEO4J_URI }}
        NEO4J_USERNAME: ${{ secrets.NEO4J_USERNAME }}
        NEO4J_PASSWORD: ${{ secrets.NEO4J_PASSWORD }}
        REDDIT_CLIENT_ID: ${{ secrets.REDDIT_CLIENT_ID }}
        REDDIT_CLIENT_SECRET: ${{ secrets.REDDIT_CLIENT_SECRET }}
      run: |
        python collectors/github_scraper.py
        python collectors/reddit_scraper.py

    - name: Run Logic Autopsy
      env:
        NEO4J_URI: ${{ secrets.NEO4J_URI }}
        NEO4J_USERNAME: ${{ secrets.NEO4J_USERNAME }}
        NEO4J_PASSWORD: ${{ secrets.NEO4J_PASSWORD }}
      run: python run_autopsy.py
