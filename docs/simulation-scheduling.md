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
- 定时触发准备模拟认知上下文。承诺提醒保留承诺与触发记录的关联。

模拟入站事件键的 schedule: 前缀保留给调度器。外部模拟事件使用该前缀时会被拒绝。

## 承诺提醒

角色的 ADMIN 可用 `GET /v1/characters/{characterId}/commitment-receipts` 查找尚未登记的已确认回执，也可按 `runId` 筛选。用 `POST /v1/characters/{characterId}/commitments` 登记时，提交 `actionId`、`title`、`task`、UTC 格式的 `dueAt`、`reason` 和 `collaborators`，并带 `Idempotency-Key`。无协作时提交空数组。协作身份须有当前角色的有效账号绑定。每张确认回执最多登记一条承诺，回执对应的负责身份、账号、会话和联系人用于唯一一条单次提醒。

通过 `GET /v1/characters/{characterId}/commitments` 查询，可按 `accountId` 或 `contactId` 过滤。响应包含承诺状态、版本和关联提醒的下次触发时间。

托管模型可为公开模拟回复提出一项计划或承诺。单次事项的截止时间须在未来七天内，每日计划采用该运行的身份时区。承诺事项须出现在回复正文中。模型以平台名提出协作需求，系统在本地选择同角色下该平台唯一可用的其他身份账号。参与者的身份、账号、任务和时间规则纳入审批摘要。确认模拟回执和登记事项在同一事务内完成，绑定变化后跳过登记。承诺保留原会话和回执。登记后的提醒沿用模拟调度和静默时间规则，真实平台的参与事项由人工跟进。

对 `/commitments/{commitmentId}` 执行 PUT 时提供 `If-Match` 和变更理由。操作为 `EDIT`、`DEFER`、`FULFILL`、`CANCEL` 或 `EXPIRE`。编辑可修改标题、事项、截止时间和协作身份。变更截止时间需要更晚的未来 `dueAt`，标记过期需已到截止时间。延期或关闭会更新提醒版本，取消旧版本尚未执行的运行。每次变更追加状态、期限、操作人和理由。

承诺提醒采用上述静默时段和补偿规则，推进到模拟上下文就绪。
