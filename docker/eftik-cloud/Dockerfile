# 狐分身 DSH 工作台 · 精简自研镜像（无浏览器/无 noVNC/无 Web UI 依赖）
# 直接安装官方 @deepseek-ai/dsh npm 包，不依赖 runzhliu 社区镜像。
# 面向 API/headless 场景：容器内只跑 in-pod 网关。
# 构建（context 必须是本目录，COPY 才能找到 gateway.js）：
# docker build --progress=plain --provenance=false -f docker/eftik-cloud/Dockerfile \
#   -t registry.cn-shanghai.aliyuncs.com/eftik/eftik-dsh-cloud:0.6.22 docker/eftik-cloud

FROM node:24-trixie

ARG DSH_VERSION=0.1.5-rc.2
ARG PNPM_VERSION=10.15.1

# tini：正确的信号转发与子进程回收；git：agent 常用工具链
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @deepseek-ai/dsh@${DSH_VERSION} pnpm@${PNPM_VERSION} \
    && dsh --version

COPY gateway.js web-ui.js web-auth.js login.html usage-probe.js sdk-session-resume.js entrypoint.sh /opt/gw/
COPY branding/ /opt/gw/branding/
RUN chmod 0755 /opt/gw/entrypoint.sh && chmod 0644 /opt/gw/gateway.js \
    && mkdir -p /home/node/.dsh /workspace \
    && chown -R node:node /home/node /workspace

ENV DSH_HOME=/home/node/.dsh \
    HOME=/workspace \
    NPM_CONFIG_CACHE=/home/node/.dsh/npm-cache \
    GW_PORT=8090 \
    DSH_TELEMETRY_DISABLED=1

EXPOSE 8080 8090

# root 启动 → 修 PVC 属主 → setpriv 降权到 node（沿用 v0.0.2 方案）
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/gw/entrypoint.sh"]
CMD []
