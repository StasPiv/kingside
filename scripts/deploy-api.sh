#!/bin/bash
# Deploy only API — shortcut for deploy-aws.sh api
exec "$(dirname "${BASH_SOURCE[0]}")/deploy-aws.sh" api
