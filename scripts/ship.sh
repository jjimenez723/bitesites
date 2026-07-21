#!/usr/bin/env sh
set -eu

printf "Commit message [Ship latest changes]: "
IFS= read -r message
message=${message:-Ship latest changes}

git add .
npm run secrets:check
git commit -m "$message"
git push
npm run deploy:worker
