#!/bin/bash

# Stop script if any command fails
set -eo pipefail

# Do not run script twice in parallel if it takes too much time
LOCK=/tmp/gpu-monitor.lock
if [ -e "$LOCK" ]; then
  echo "Lock file already present, skipping run..."
  exit 1
fi
touch $LOCK

# Prepare directories
cd $(dirname $0)
mkdir -p data/json

# Enable python environment
export PYENV_ROOT="$HOME/.pyenv"
[[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
eval "$(pyenv virtualenv-init -)"
pyenv activate gpuview

# Run stats collection + parsing + csv.gz dump
JSONFILE=data/json/$(date +%Y%m%d%H%M%S).json
gpustat -a --json > $JSONFILE
if ls data | grep .csv.gz > /dev/null; then
  gunzip data/*.csv.gz
fi
python parse_json.py $JSONFILE
gzip data/*.csv

# Cleanup
rm -f $JSONFILE
rm -f $LOCK
