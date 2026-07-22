#!/usr/bin/env sh
set -eu

printf "Commit message [Ship latest changes]: "
IFS= read -r message
message=${message:-Ship latest changes}

printf "Deploy Firestore rules & indexes? [Y/n]: "
IFS= read -r rules
case "${rules:-y}" in
  [Nn]*) deploy_script="deploy:hosting" ;;
  *) deploy_script="deploy" ;;
esac

git add .
npm run secrets:check
git commit -m "$message"
git push
npm run "$deploy_script"
