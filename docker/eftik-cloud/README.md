# docker/eftik-cloud — 狐分身 DSH 工作台定制层

基于本仓库锁定的 release（`a66e470204 release(dsh): 0.1.2-rc.1`）分支构建生产镜像。

## 构成

| 文件 | 用途 |
|------|------|
| `Dockerfile` | 镜像定义：node:24-trixie + `@deepseek-ai/dsh@<分支对应版本>` + tini/git，无浏览器/noVNC/Web UI |
| `gateway.js` | in-pod HTTP 网关：`POST /chat` 异步任务 + `GET /task/:id` 轮询 + 进度事件采集 + `X-GW-Token` 鉴权 |
| `entrypoint.sh` | root 启动修 PVC 属主（Sealos PVC 为 root 所有）→ setpriv 降权到 node 跑网关 |

## 构建 / 推送

```bash
# 镜像命名约定：eftik-dsh-cloud:<主版本>.0-gw<网关修订>
docker build -f docker/eftik-cloud/Dockerfile \
  -t registry.cn-shanghai.aliyuncs.com/eftik-dsh-cloud:1.0.0 .

docker push registry.cn-shanghai.aliyuncs.com/eftik-dsh-cloud:1.0.0
```

> 早期探索版（基于 runzhliu 社区基座）为 `eftik/dsh-workspace:0.x` 系列，
> 正式版一律 `eftik-dsh-cloud:<x.y.z>`，基座换成本仓库源码对应版本。

## 升级 DSH 版本

1. 官方发新 release → 在本仓库从对应 release commit 拉新分支（如 `eftik-cloud-1.1.0`）
2. `Dockerfile` 中 `ARG DSH_VERSION` 改为新版本号（或改为源码构建）
3. 跑 e2e 冒烟（`test-e2e.js`）→ 推新 tag → Sealos 存量工作台滚动更新

## Sealos 部署参数（Applaunchpad POST /apps）

- `image.imageName`: `eftik-dsh-cloud:1.0.0`（`imageRegistry` 凭据必带，私有仓库）
- `launchCommand` 不需要（镜像 ENTRYPOINT 已是网关）
- `ports`: `[{number: 8090, protocol: "http", isPublic: false}]`（后端入集群后）；过渡期 `isPublic: true`
- `env`: `GW_TOKEN`（随机）、`DEEPSEEK_API_KEY`（secretKeyRef）
- `storage`: `dsh-home → /home/node/.dsh`（1Gi）、`workspace → /workspace`（2Gi）
- 首次启动若遇节点 PVC 授权瞬时报错，restart 一次即可
