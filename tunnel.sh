#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# tunnel.sh — Instant Cloudflare Tunnel for YT-DLP Web Interface
#
# Creates a free, public HTTPS URL (https://*.trycloudflare.com)
# No account or domain required.
#
# Usage:
#   bash tunnel.sh
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Styling / Colors ──────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PORT="${PORT:-8939}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${CYAN}"
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║    YT-DLP Web Interface — Cloudflare Tunnel    ║"
echo "  ║    Target Port: ${PORT}                             ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── 1. Check or Download cloudflared binary ───────────────────────────
if command -v cloudflared >/dev/null 2>&1; then
    CLOUDFLARED_BIN="cloudflared"
    echo -e "${GREEN}  ✓ Found cloudflared in PATH${NC}"
elif [ -f "${APP_DIR}/cloudflared" ]; then
    CLOUDFLARED_BIN="${APP_DIR}/cloudflared"
    echo -e "${GREEN}  ✓ Found local cloudflared binary${NC}"
else
    echo -e "${YELLOW}  cloudflared not found. Downloading portable Linux binary...${NC}"
    
    ARCH="$(uname -m)"
    case "$ARCH" in
        x86_64|amd64)
            DOWNLOAD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
            ;;
        aarch64|arm64)
            DOWNLOAD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
            ;;
        armv7l|armhf)
            DOWNLOAD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm"
            ;;
        *)
            DOWNLOAD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
            ;;
    esac

    echo -e "  Downloading from: ${DOWNLOAD_URL}"
    curl -fsSL "$DOWNLOAD_URL" -o "${APP_DIR}/cloudflared"
    chmod +x "${APP_DIR}/cloudflared"
    CLOUDFLARED_BIN="${APP_DIR}/cloudflared"
    echo -e "${GREEN}  ✓ cloudflared downloaded successfully${NC}"
fi

# ── 2. Start Cloudflare Tunnel ────────────────────────────────────────
echo ""
echo -e "${YELLOW}  Starting tunnel for http://localhost:${PORT}...${NC}"
echo -e "  Look for your public ${BOLD}https://*.trycloudflare.com${NC} link below:"
echo ""

exec "$CLOUDFLARED_BIN" tunnel --url "http://localhost:${PORT}"
