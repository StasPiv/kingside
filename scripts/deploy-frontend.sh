#!/bin/bash
# Deploy only frontend — shortcut for deploy-aws.sh frontend
exec "$(dirname "${BASH_SOURCE[0]}")/deploy-aws.sh" frontend
