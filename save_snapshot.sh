#!/bin/bash

# Stop script if any command fails
set -eo pipefail

# Do not run script twice in parallel if it takes too much time
LOCK=$(dirname $0)/data/gpu-monitor.lock
if [ -e "$LOCK" ]; then
  echo "Lock file $LOCK already present, skipping run..."
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
if test -s $JSONFILE; then
  find data -name *.csv.gz | while read f; do
    gunzip -k $f
  done
  python parse_json.py $JSONFILE
  gzip -k -S .tmpgz data/*.csv
  find data -name *.csv | while read f; do
    mv $f $f.old
  done
  find data -name *.csv.tmpgz | while read f; do
    if ! test -s $f; then
      echo "GZIPped file $f is empty, there's something wrong, stopping here..."
      exit 1
    fi
    outf=${f/\.tmpgz/.gz}
    if test -s $outf; then
      mv $outf $outf.old
    fi
    mv $f $outf
  done

  # Cleanup
  rm -f $JSONFILE
fi

rm -f $LOCK
