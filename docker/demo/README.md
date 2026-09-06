# docker/demo — 狐分身 DSH 工作台演示站

一键创建 Sealos 工作台 + 全接口演示（设置/对话/流式/取消/删除），用于联调测试。

## 启动

```bash
# 需要：Node 22+，Sealos kubeconfig（查找顺序：.env 的 SEALOS_KUBECONFIG_PATH → 本目录 kubeconfig.yaml → Downloads 默认路径）
node demo-server.cjs
# 打开 http://127.0.0.1:8093
```

环境变量：`DEMO_PORT` / `SEALOS_KUBECONFIG_PATH` / `DSH_IMAGE`（默认 eftik-dsh-cloud:1.3.0）/ `DSH_CPU` / `DSH_MEM`，产品模式见下文

## 密钥配置（代码零硬编码）

DeepSeek API Key 与 ACR 用户名/密码两种方式配置，任选其一：

1. **页面配置面板（推荐）**：打开首页顶部「密钥配置」，填好后点「保存到本会话」。密钥只存
   demo 服务进程内存，**不落盘**，服务重启后需重填。
2. **`.env` 文件（可选便利）**：复制 `.env.example` 为 `.env` 填入真实值。`.env` 已被
   `.gitignore` 忽略，**绝不可提交**。

未配置密钥时点「一键创建工作台」会返回 400 提示。创建出的每个工作台容器通过环境变量注入
平台统一的 DeepSeek Key（容器内使用，不回传浏览器）。

## 产品模式（网关 v0.4 / 镜像 1.3.0）

`.env` 里开启 `GW_PRODUCT_MODE=1` 后，demo 充当平台（kitsume 后端角色）：

- 创建的工作台为 1.3.0 镜像，注入 `GW_PRODUCT_MODE` / `GW_ADMIN_TOKEN` / `GW_PRESET_*`
- demo 调用 `/settings` 时自动带 `X-GW-Admin`，因此设置面板仍可编辑人设/记忆（平台视角）
- 容器内：用户权限锁死 workspace-write、执行目录锁定 `/workspace`、预设对用户 API 不可见、
  设置文件存于 `/home/node/.dsh/`（workspace 外）

## 演示的接口映射

| 页面功能 | demo 代理 | 网关接口 | Sealos 接口 |
|----------|-----------|----------|-------------|
| 一键创建工作台 | POST /api/create | - | POST /apps |
| 状态步骤轮询 | GET /api/app/:name | - | GET /apps/{name} |
| 网关健康 | GET /api/health/:name | GET /health | - |
| 设置面板读写/重置 | GET/POST/DELETE /api/settings/:name | GET/POST/DELETE /settings | - |
| 对话（异步任务） | POST /api/chat/:name | POST /chat | - |
| SSE 实时进度 | GET /api/stream/:name/:tid | GET /task/:id/stream | - |
| 结果轮询（可选关闭 SSE） | GET /api/task/:name/:tid | GET /task/:id | - |
| 取消任务 | DELETE /api/task/:name/:tid | DELETE /task/:id | - |
| 工作区文件浏览 | GET /api/files/:name | GET /files?path= | - |
| 文件下载 | GET /api/download/:name | GET /files/download?path= | - |
| 删除工作台 | DELETE /api/app/:name | - | DELETE /apps/{name} |
| 工作台列表 | GET /api/apps | - | GET /apps |

## 文件

- `demo-server.cjs`：静态页 + Sealos/网关代理（gwToken 只在服务端注入，浏览器接触不到）
- `demo.html`：单页 UI（含密钥配置面板）
- `.env.example`：密钥/产品模式配置模板（真实 `.env` 已 gitignore）
- `kubeconfig.yaml`：Sealos 集群凭据（**含敏感凭据，已 gitignore，勿提交**）
- `workspaces.local.json`：运行时生成的工作台注册表（含 gwToken，**已 gitignore，勿提交**）
