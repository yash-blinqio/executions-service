#!/bin/bash
set -e  # Exit on errors (except those we handle manually)
set -x  # Print each command before executing it (for debugging)

PROJECT_ROOT="shared/project-dir"
EXTRACT_PATH="$PROJECT_ROOT/$EXTRACT_DIR"

echo "📦 Using extract dir: $EXTRACT_DIR"
echo "🔐 Using token: $BLINQ_TOKEN"
echo "🔧 Setting up environment in $EXTRACT_PATH"

# Create base project directory if it doesn't exist
mkdir -p "$PROJECT_ROOT"

cd "$PROJECT_ROOT"

# Initialize and install cucumber-js
if [ ! -f package.json ]; then
  echo "📦 Initializing npm project in $PROJECT_ROOT"
  npm init -y
fi

npm install @dev-blinq/cucumber-js@stage

# Download and install runtime dependencies using provided token
npx cross-env NODE_ENV_BLINQ=$NODE_ENV_BLINQ node ./node_modules/@dev-blinq/cucumber-js/bin/download-install.js \
  --token "$BLINQ_TOKEN" \
  --extractDir "$EXTRACT_DIR"

cd "$EXTRACT_DIR"

# Initialize and install cucumber client
if [ ! -f package.json ]; then
  echo "📦 Initializing npm project in $EXTRACT_PATH"
  npm init -y
fi

npm install @dev-blinq/cucumber_client@stage

# Install Playwright (optional step – won't fail the script if it already exists)
npx playwright install || echo "⚠️  Playwright install failed or already complete"

echo "✅ Environment ready at $EXTRACT_PATH"
