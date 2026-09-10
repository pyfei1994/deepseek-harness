# Agent Note: Eftik cloud BYOK and plugin directory

English | [中文](2026-09-10-eftik-byok-plugin-directory.zh.md)

Status: implemented

## Problem

The Eftik cloud gateway needs tenant-owned DeepSeek credentials without storing model keys in the Kitsume database, its separate skill and scheduled-task surfaces do not provide one product-level plugin inventory, and tenants need access to the official DSH WebUI through the public Sealos application address.

## Decision

The gateway migrates an initial `DEEPSEEK_API_KEY` into the Harness native `$DSH_HOME/.credentials.yaml` document with owner-only permissions and removes the value from the long-lived gateway process environment. Authenticated credential routes expose configuration status and a suffix but never the secret value, and replacement writes commit atomically.

`GET /plugins` reads DSH's real profile manifests. Authenticated install/remove routes delegate to `dsh plugin --profile <web|headless> add/remove`, so profile reconciliation remains owned by DSH. Product requests accept npm package specs only; git URLs and local paths are rejected because they can authorize install-time build scripts. A profile-change marker reloads the WebUI process after a successful operation.

The official WebUI continues to bind to loopback on port 3080. A separate proxy publishes the workspace's only public port, 8080, requires a workspace password whose SHA-256 digest is stored on the PVC, and rewrites the upstream authority before performing DSH's native launch-token exchange. The API gateway remains internal on port 8090 and is exposed through the reserved `/_eftik/api` prefix on the same public origin.

## Alternatives considered

**Keep the platform model key.** This keeps billing centralized but makes the platform responsible for token metering and prevents tenants from controlling their own model quota.

**Store tenant keys in the Kitsume database.** This simplifies container recreation but expands the central secret-bearing system and makes an application database leak expose every tenant key.

**Treat Skills and scheduled tasks as plugins.** This is a convenient product taxonomy but conflicts with DSH's concrete bundle/profile contract, so those features remain separate.

**Allow arbitrary git or local plugin installation.** This matches the broadest CLI capability but gives remote tenants a direct install-time build-script surface. The product UI initially limits installation to npm package names and versions.

**Bind `dsh web` directly to all interfaces.** DSH deliberately restricts non-loopback binding and validates host/origin authority. Keeping it on loopback preserves those assumptions while the password proxy defines the public security boundary.

## Consequences

Each workspace PVC owns its model credential, WebUI password digest, and DSH profile dependencies; key rotation affects subsequent Harness runs. Third-party npm plugins execute code inside the tenant workspace and are not platform endorsements. The initial key still crosses the Sealos deployment API during workspace creation, so transport security and Sealos secret handling remain part of the deployment boundary. A workspace is not ready until Sealos returns the public address for port 8080 and the API gateway responds through the reserved prefix.
