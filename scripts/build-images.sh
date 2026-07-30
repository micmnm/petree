#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -f images/node.Dockerfile -t sandbox-node images
docker build -f images/dotnet.Dockerfile -t sandbox-dotnet images
