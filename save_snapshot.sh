#!/bin/bash

cd $(dirname $0)

mkdir -p data/json

export PYENV_ROOT="$HOME/.pyenv"
[[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
eval "$(pyenv virtualenv-init -)"

pyenv activate gpuview

dt=$(date +%Y%m%d%H%M%S)
gpustat -a --json > data/json/${dt}.json && python parse_json.py data/json/${dt}.json

