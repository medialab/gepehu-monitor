#!/bin/bash

set -eo pipefail

LOCK=/tmp/gpu-monitor.lock

if [ -e "$LOCK" ]; then
  echo "Lock file already present, skipping run..."
  exit 1
fi
touch $LOCK

cd $(dirname $0)

mkdir -p data/json

export PYENV_ROOT="$HOME/.pyenv"
[[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
eval "$(pyenv virtualenv-init -)"

pyenv activate gpuview

dt=$(date +%Y%m%d%H%M%S)
gpustat -a --json > data/json/${dt}.json && python parse_json.py data/json/${dt}.json

rm -f $LOCK
