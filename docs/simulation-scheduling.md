# 模拟计划与补偿

启动认知 Worker 后，它会从 PostgreSQL 扫描到期的模拟计划。计划推进、触发记录、运行、审计与 `RunQueued.v1` 出箱事件在同一事务提交。BullMQ 消费沿用已有流程。

## 创建和更新

角色的 ADMIN 可调用 `GET /v1/characters/{characterId}/schedules` 查询计划，或向同一路径提交 POST 创建计划。POST 带 `Idempotency-Key`。请求包含 `scheduleKey`、`accountId`、`conversationId`、`zone`、`enabled` 和 `rule`。私聊还须提供已绑定的 `contactId`。

- 每日活动使用 `{"kind":"DAILY","localTime":"09:30"}`，按计划的 IANA 时区解释。
- 单次提醒使用 `{"kind":"REMINDER","dueAt":"2026-11-10T01:30:00.000Z"}`，按指定的 UTC 时刻触发。

对 `/schedules/{scheduleId}` 执行 PUT 时发送 `If-Match`，例如 `"1"`，并提交新的 `zone`、`enabled` 和 `rule`。账号和会话固定。更新计划会取消旧版本中尚未执行的运行。一次计划的同一计划时刻只产生一条触发记录。

## 调度边界

- 夏令时跳过不存在的本地时刻，重复时刻采用较早的 UTC 瞬间。
- 停机恢复时，每日计划只补最近一个合规时刻，补偿窗口为两小时。角色当地时间 22:00 至次日 08:00 跳过每日活动。
- 单次提醒在静默时段延期到下一次 08:00，保留原计划时刻。账号暂停期间保留待处理计划，恢复后重新计算。
- 定时触发仅准备模拟认知上下文。当前没有承诺对象生命周期，也不会凭计划制造入站正文或自动生成外发回复。

模拟入站事件键的 schedule: 前缀保留给调度器。外部模拟事件使用该前缀时会被拒绝。
