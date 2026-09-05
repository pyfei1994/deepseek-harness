# docker/demo — 狐分身 DSH 工作台演示站

一键创建 Sealos 工作台 + 全接口演示（设置/对话/流式/取消/删除），用于联调测试。

## 启动

```bash
# 需要：Node 22+，Sealos kubeconfig（默认读 C:/Users/vante/Downloads/kubeconfig (5).yaml，可用 SEALOS_KUBECONFIG_PATH 覆盖）
node demo-server.cjs
# 打开 http://127.0.0.1:8093
```

环境变量：`DEMO_PORT` / `SEALOS_KUBECONFIG_PATH` / `DSH_IMAGE`（默认 eftik-dsh-cloud:1.2.0）/ `DEEPSEEK_API_KEY` / `ACR_USER` / `ACR_PASS` / `DSH_CPU` / `DSH_MEM`

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
| 删除工作台 | DELETE /api/app/:name | - | DELETE /apps/{name} |
| 工作台列表 | GET /api/apps | - | GET /apps |

## 文件

- `demo-server.cjs`：静态页 + Sealos/网关代理（gwToken 只在服务端注入，浏览器接触不到）
- `demo.html`：单页 UI（含密钥配置面板）
- `.env.example`：密钥配置模板（真实 `.env` 已 gitignore）
- `kubeconfig.yaml`：Sealos 集群凭据（**含敏感凭据，已 gitignore，勿提交**）
- `workspaces.local.json`：运行时生成的工作台注册表（含 gwToken，**已 gitignore，勿提交**）
