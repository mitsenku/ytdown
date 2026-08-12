#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# deploy.sh — Deploy YT-DLP Web Interface as a systemd service
#
# Port: 8939
# Automatically terminates any existing process running on port 8939.
#
# Usage:
#   sudo bash deploy.sh
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Styling / Colors ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

APP_NAME="ytdlp-web"
PORT="8939"

echo -e "${CYAN}"
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║   YT-DLP Web Interface — Systemd Deployer       ║"
echo "  ║   Target Port: ${PORT}                              ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── 1. Check Root Privileges ──────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[ERROR] Please run with sudo: sudo bash deploy.sh${NC}"
    exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${APP_DIR}/backend"
VENV_DIR="${APP_DIR}/venv"
SERVICE_USER="${SUDO_USER:-$USER}"
SERVICE_GROUP="$(id -gn "$SERVICE_USER" 2>/dev/null || echo "$SERVICE_USER")"

echo -e "  App directory : ${BOLD}${APP_DIR}${NC}"
echo -e "  Service user  : ${BOLD}${SERVICE_USER}:${SERVICE_GROUP}${NC}"
echo -e "  Service port  : ${BOLD}${PORT}${NC}"
echo ""

# ── 2. Kill Any Process Running on Port 8939 ───────────────────────────
echo -e "${YELLOW}[1/5] Checking and clearing port ${PORT}...${NC}"

kill_port() {
    local target_port="$1"
    local killed=0

    # Method A: fuser
    if command -v fuser >/dev/null 2>&1; then
        if fuser "${target_port}/tcp" >/dev/null 2>&1; then
            echo -e "  ${YELLOW}Killing process holding port ${target_port} via fuser...${NC}"
            fuser -k "${target_port}/tcp" >/dev/null 2>&1 || true
            killed=1
        fi
    fi

    # Method B: lsof
    if command -v lsof >/dev/null 2>&1; then
        local pids
        pids="$(lsof -ti:"${target_port}" 2>/dev/null || true)"
        if [ -n "$pids" ]; then
            echo -e "  ${YELLOW}Killing PID(s) using port ${target_port}: ${pids}${NC}"
            echo "$pids" | xargs -r kill -9 2>/dev/null || true
            killed=1
        fi
    fi

    # Method C: ss / netstat
    if command -v ss >/dev/null 2>&1; then
        local ss_pids
        ss_pids="$(ss -lptn "sport = :${target_port}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' || true)"
        if [ -n "$ss_pids" ]; then
            echo -e "  ${YELLOW}Killing ss PID(s) using port ${target_port}: ${ss_pids}${NC}"
            echo "$ss_pids" | xargs -r kill -9 2>/dev/null || true
            killed=1
        fi
    fi

    sleep 1
    if [ "$killed" -eq 1 ]; then
        echo -e "${GREEN}  ✓ Port ${target_port} is now free${NC}"
    else
        echo -e "${GREEN}  ✓ Port ${target_port} was already free${NC}"
    fi
}

kill_port "${PORT}"

# ── 3. Install System Packages ────────────────────────────────────────
echo -e "${YELLOW}[2/5] Installing system packages (python3, ffmpeg, nodejs, tools)...${NC}"
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv ffmpeg curl psmisc lsof nodejs > /dev/null 2>&1 || apt-get install -y -qq python3 python3-pip python3-venv ffmpeg curl psmisc lsof > /dev/null 2>&1
echo -e "${GREEN}  ✓ System packages verified & installed${NC}"

# ── 4. Setup Python Virtual Environment ───────────────────────────────
echo -e "${YELLOW}[3/5] Setting up Python virtual environment & updating yt-dlp...${NC}"
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi
"${VENV_DIR}/bin/pip" install --upgrade pip -q
"${VENV_DIR}/bin/pip" install -r "${BACKEND_DIR}/requirements.txt" -q
"${VENV_DIR}/bin/pip" install --upgrade yt-dlp -q
echo -e "${GREEN}  ✓ Python virtualenv and dependencies (yt-dlp latest) ready at ${VENV_DIR}${NC}"

# ── 5. Create Directories and Permissions ─────────────────────────────
mkdir -p "${APP_DIR}/downloads"
mkdir -p "${BACKEND_DIR}/previews"
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${APP_DIR}/downloads" "${BACKEND_DIR}/previews"

# ── 6. Create / Update Systemd Service ─────────────────────────────────
echo -e "${YELLOW}[4/5] Configuring systemd service '${APP_NAME}'...${NC}"

cat > "/etc/systemd/system/${APP_NAME}.service" <<EOF
[Unit]
Description=YT-DLP Web Interface Server (Port ${PORT})
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${BACKEND_DIR}
Environment="PATH=${VENV_DIR}/bin:/usr/local/bin:/usr/bin:/bin"
Environment="PORT=${PORT}"
Environment="HOST=0.0.0.0"
Environment="CORS_ORIGINS=*"
Environment="PYTHONUNBUFFERED=1"

# Kill anything listening on port ${PORT} before launch
ExecStartPre=/bin/sh -c 'fuser -k ${PORT}/tcp 2>/dev/null || true; (command -v lsof >/dev/null && lsof -ti:${PORT} | xargs -r kill -9 2>/dev/null) || true'

# Start the application
ExecStart=${VENV_DIR}/bin/python app.py

Restart=always
RestartSec=3

# Security hardening
NoNewPrivileges=yes
ProtectSystem=full
ReadWritePaths=${APP_DIR}/downloads ${BACKEND_DIR}/previews
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${APP_NAME}"
echo -e "${GREEN}  ✓ Systemd service installed at /etc/systemd/system/${APP_NAME}.service${NC}"

# ── 7. Start the Service ──────────────────────────────────────────────
echo -e "${YELLOW}[5/5] Starting ${APP_NAME} service...${NC}"
systemctl restart "${APP_NAME}"
sleep 2

# ── 8. Verification & Summary ─────────────────────────────────────────
if systemctl is-active --quiet "${APP_NAME}"; then
    echo -e "${GREEN}  ✓ Service is ACTIVE and running!${NC}"
else
    echo -e "${RED}  ✗ Service failed to start. Journal logs:${NC}"
    journalctl -u "${APP_NAME}" -n 20 --no-pager
    exit 1
fi

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_SERVER_IP")"

echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════════════════╗"
echo -e "  ║          🎉 Deployment Successful!              ║"
echo -e "  ╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}Access URLs:${NC}"
echo -e "    Local  : ${BOLD}http://localhost:${PORT}${NC}"
echo -e "    Network: ${BOLD}http://${SERVER_IP}:${PORT}${NC}"
echo ""
echo -e "  ${YELLOW}Systemd Management Commands:${NC}"
echo -e "    sudo systemctl status ${APP_NAME}     # View service status"
echo -e "    sudo systemctl restart ${APP_NAME}    # Restart service"
echo -e "    sudo systemctl stop ${APP_NAME}       # Stop service"
echo -e "    sudo journalctl -u ${APP_NAME} -f      # Live logs"
echo ""
