#!/bin/bash
set -e

echo "🔄 Fetching upstream..."
git fetch upstream

echo "🔀 Rebasing onto upstream/main..."
git rebase upstream/main

echo "📦 Installing dependencies..."
npm install

echo "🔨 Building the project..."
npm run build

echo "🚀 Updating global installations..."
npm install -g .
npm install -g ./packages/coding-agent
npm install -g ./packages/pods

echo "✅ Update complete! Current version:"
pi --version
