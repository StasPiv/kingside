#!/bin/bash
# Deploy only API — shortcut for deploy-local.sh api
exec "$(dirname "${BASH_SOURCE[0]}")/deploy-local.sh" api
