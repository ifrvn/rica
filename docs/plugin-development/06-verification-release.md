# 6. 本地验证、发布与排障

## 从本地启动到验收

使用 [根目录启动说明](../../README.md#1-安装并启动)的 Node.js、pnpm 和开发服务。数据库和 Redis 使用独立的空开发环境，管理 API 的 Origin 配置与浏览器访问地址一致。迁移或依赖有改动时，检查对应命令和锁文件。

```powershell
pnpm install --frozen-lockfile
pnpm run db:generate
pnpm run typecheck
pnpm test
pnpm run build
```

用 `pnpm exec tsx --test <测试文件>` 先跑受影响的用例。以当前 Compose 服务启动独立 PostgreSQL 和 Redis，确认 `DATABASE_URL`、`MIGRATION_DATABASE_URL`（如配置）和 `REDIS_URL` 指向该环境，再应用迁移和运行集成测试。

```powershell
pnpm run db:migrate
pnpm run test:integration
```

| 改动 | 验收重点 | 可复用的测试 |
| --- | --- | --- |
| 运行时注册与生命周期 | 重复 ID、未知选择、缺依赖、无效配置、部分启动失败与释放 | [注册表测试](../../packages/runtime/tests/plugin-registry.test.ts) |
| 管理和部署 | 会话与 Origin、角色权限、版本冲突、字段碰撞、启停后的行为 | [管理插件测试](../../apps/api/management-plugins.test.ts)、[模型设置测试](../../plugins/hosted-models/tests/model-settings.test.ts) |
| 外部模型协议 | 发送字段最小化、超时、认证失败、无效响应以及公开和私密分流 | 用受控服务替身记录出站请求，配合[入站集成](../../scripts/inbound.integration.test.ts)验证授权 |
| 外部读取与写入 | 账号隔离、绑定变更、读写权限、游标去重、批准后发送、丢响应恢复与结案 | 用平台协议夹具验证读写，配合[管理集成](../../scripts/management.integration.test.ts)验证角色边界 |
| 控制台 | 插件启停，设置保存或核验，账号添加与绑定，审批深链接，健康状态和错误反馈 | 浏览器使用本地 API 或协议夹具，窄屏和键盘完成主要任务流 |

真实平台操作优先用隔离协议夹具覆盖。外部模型真实调用可能计费，须使用明确授权的测试环境。数据库或队列变更在专用环境验证，现有部署数据按部署流程管理。

## 发布版本与升级预览

1. 用稳定组件 ID 和固定版本描述每个交付项。针对影响既有审批或回执恢复的版本变更，验证在途请求、许可失效与人工对账。
2. 按部署目标构建同一版本的 API、Worker、命令与控制台。Rica 仓库用 `pnpm run release:pack` 生成 npm 包。第三方包应在隔离部署项目安装实际制品，验证 `./rica`、可选的 `./rica/prisma`、生成的 Client 和迁移文件。先应用迁移，再启动服务。保存私有配置和数据库，升级用例从上一版本的测试数据开始。
3. 如需在插件中心提供升级预览，用目标版本的代码生成发布清单。示例命令在 PowerShell 7 中执行，换成实际发布页的 HTTPS 地址。

   ```powershell
   pnpm exec tsx scripts/plugin-release-manifest.ts https://example.com/releases/v0.1.0 |
     Set-Content -Encoding utf8 plugin-release.json
   ```

   [清单生成器](../../scripts/plugin-release-manifest.ts)当前收集外部模型、平台读取和平台回复执行组件。新能力若要出现在预览中，核对生成器的筛选、进程目录以及部署项的 `ownsComponent`。将清单部署到受控目录，通过 `RICA_PLUGIN_RELEASE_MANIFEST` 指向本机绝对路径。
4. 在插件中心检查预览。宿主用组件种类和 ID 对照当前与目标，显示缺失组件、契约不兼容或降级。若插件提供发送状态，逐个角色处理在途和待核对记录，再由部署流程切换版本。
5. 部署完成后刷新插件并打开「核对运行版本」。目录、目标清单、实际运行报告分别展示。对已启用的组件确认报告中的版本和契约符合目标。单次命令组件可在受控环境执行一次获准操作以取得新报告。

## 从症状定位

| 症状 | 检查 |
| --- | --- |
| 内置插件没有出现在插件中心 | 核对工作区依赖、部署目录、控制台卡片和浏览器加载的构建。 |
| 清单包未装配 | 核对清单所在目录的已安装版本、`./rica` 导出、声明的能力和对应进程日志。声明了控制台贡献时，检查当前角色的插件页。 |
| 插件迁移失败或找不到业务表 | 核对 `./rica/prisma`、包内 SQL、迁移与运行连接的 schema 及授权。保留原迁移日志，修正后在隔离库重跑。 |
| 插件已启用但账号不可选 | 部署设置是否保存，角色是否有管理权限，状态及账号贡献是否在 API 和控制台正确组合。 |
| 核验成功后提交失败 | 凭证是否改动、接口端点是否变更、平台返回的身份是否一致、账号是否已登记。 |
| 保存提示版本冲突 | 刷新当前设置，确认最新版本后再提交。相同业务请求重试保留原幂等键和输入。 |
| Worker 使用本地模型或无法生成草稿 | 检查模型启用状态、已保存配置、API 和 Worker 的共享设置路径及 Worker 日志。私密模拟按权限规则选择本地模型。 |
| 组件状态未知 | 检查 Redis、服务名和当前进程。常驻进程约每 5 秒报告一次，状态 20 秒后过期。登记为单次命令的服务可以采用更长的报告保留期。见[状态装配](../../apps/plugin-observation.ts)。 |
| 已批准但发送结果未知 | 核对原提案、平台回执和账本状态。恢复时使用原提案及原幂等键，并按该平台插件的对账规则处理。 |
