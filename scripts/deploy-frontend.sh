#!/bin/bash
# Deploy only frontend — shortcut for deploy-local.sh frontend
exec "$(dirname "${BASH_SOURCE[0]}")/deploy-local.sh" frontend
