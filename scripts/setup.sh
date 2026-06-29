#!/bin/bash
set -euo pipefail

echo "=== AutoPR MVP 30-Day Setup ==="

# Copy env if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit it with your credentials"
fi

# Install dependencies
npm install

# Initialize database
node -e "import('./data/db.js').then(m => m.getDb())"

echo ""
echo "Setup complete! To start:"
echo "  npm run dev        # Start webhook server (dev mode)"
echo "  npm run worker     # Start background worker"
echo ""
echo "Or with Docker:"
echo "  node scripts/deploy.js build"
echo "  node scripts/deploy.js start"
