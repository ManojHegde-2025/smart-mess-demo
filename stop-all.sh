#!/usr/bin/env bash
# Stops the services started by start-all.sh (matched by their command lines, not by port).
for pattern in "uvicorn api.app:app" "uvicorn app.main:app" "node server.js" "next start"; do
  pgrep -f "$pattern" | xargs -r kill 2>/dev/null || true
done
pgrep -f "next-server" | xargs -r kill 2>/dev/null || true
echo "stopped"
