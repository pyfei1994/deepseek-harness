#!/bin/bash
# DSH 工作台启动脚本：root 修复 PVC 属主 → 降权到 node 跑网关
set -e

chown -R node:node /home/node/.dsh /workspace 2>/dev/null || true

exec setpriv --reuid=node --regid=node --clear-groups node /opt/gw/gateway.js
