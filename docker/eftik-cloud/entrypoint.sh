#!/bin/bash
# DSH 工作台启动脚本：root 修复 PVC 属主 → 降权到 node 跑网关
set -e

chown -R node:node /home/node/.dsh /workspace 2>/dev/null || true

# 登录页品牌资源：镜像里 /opt/gw/branding 是出厂默认；PVC 上若已有同名的用户文件则不覆盖，
# 这样运维可以直接往 PVC 丢一张 bg.png 换肤，无需重建镜像。
BRANDING_DIR=/home/node/.dsh/branding
mkdir -p "$BRANDING_DIR" 2>/dev/null || true
for f in /opt/gw/branding/*; do
  [ -e "$f" ] || continue
  name=$(basename "$f")
  if [ ! -e "$BRANDING_DIR/$name" ]; then
    cp "$f" "$BRANDING_DIR/$name" 2>/dev/null || true
  fi
done
chown -R node:node "$BRANDING_DIR" 2>/dev/null || true

(
  while true; do
    setpriv --reuid=node --regid=node --clear-groups node /opt/gw/web-ui.js
    code=$?
    echo "[web-supervisor] proxy exited $code, restarting" >&2
    sleep 2
  done
) &
exec setpriv --reuid=node --regid=node --clear-groups node /opt/gw/gateway.js
