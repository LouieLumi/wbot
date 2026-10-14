#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export OLLAMA_HOST=127.0.0.1:11435
export OLLAMA_MODELS="$PWD/.runtime/ollama-models"
export OLLAMA_NO_CLOUD=1
export OLLAMA_CONTEXT_LENGTH=4096
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_MAX_LOADED_MODELS=1
exec /usr/local/bin/ollama serve
