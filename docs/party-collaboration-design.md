# 同一局多人协作设计方案

## 1. 背景与目标

当前 `jijiuPartyRecord` 以 `ownerOpenid + ownerAppid` 隔离数据，`partyId` 对应一名用户保存的一份聚会快照。该模型适合单人记账，但无法让同桌多台设备加入同一局并安全地共同修改。

本方案的目标是：在不破坏现有单人数据和旧客户端的前提下，把协作局扩展为“以 `partyId` 为边界、成员共享、服务端校验、操作可追溯”的模型。加入者只看到自己已加入的局，所有写入都必须经过云函数鉴权。

## 2. 推荐结论

推荐采用“聚会快照 + 只追加操作日志 + 成员表”的结构：

- `ji_jiu_parties` 保留当前聚合快照，作为页面快速加载的数据源。
- `ji_jiu_party_members` 单独记录 `partyId` 与 openid 的成员关系和角色。
- `ji_jiu_party_operations` 保存不可变的加减操作，以 `clientMutationId` 幂等、以服务端 `revision` 排序。
- `ji_jiu_party_invites` 保存短期邀请凭证，只保存口令摘要，不保存明文口令。
- 客户端不直接写数据库；加入、读取、记账、结束、移除成员均通过 `jijiuPartyRecord`，由云函数使用 `OPENID/FROM_OPENID` 做权限校验并以事务提交。

这样做比“多端反复覆盖整份 party JSON”更可靠：整份覆盖在并发、弱网重试和旧快照回传时容易丢操作，而只追加操作可做幂等、审计和增量同步。

## 3. 数据模型

### 3.1 `ji_jiu_parties`：聚会主记录与聚合快照

现有字段全部保留，新字段均为可选：

```ts
type SharedPartyDocument = {
  _id: string                 // 继续等于 partyId
  partyId: string
  ownerOpenid: string         // 创建者，保留旧客户端语义
  ownerAppid: string
  status: 'active' | 'ended'
  party: IPartyData           // 当前聚合快照，兼容现有读取路径
  updatedAt: Date
  endedAt?: Date
  stats?: object

  collaborationMode?: 'single' | 'shared'
  schemaVersion?: number
  revision?: number           // 每个成功命令递增
  memberCount?: number
  lastOperationAt?: Date
  minClientSchemaVersion?: number
}
```

旧记录缺失 `collaborationMode` 时按 `single` 处理；旧客户端写入的文档继续按原有 owner 权限工作。

建议索引：

- 保留现有：`ownerAppid + ownerOpenid + status + updatedAt`。
- 保留现有历史分页：`ownerAppid + ownerOpenid + status + endedAt(desc) + partyId(desc)`。
- 新增：`ownerAppid + collaborationMode + status + updatedAt(desc)`，仅用于后台运维，客户端不得据此枚举共享局。

### 3.2 `ji_jiu_party_members`：成员与角色

```ts
type PartyMemberDocument = {
  _id: string                 // `${partyId}_${openidHash}` 或服务端生成
  partyId: string
  appid: string
  openid: string              // 仅云函数可读写，不返回给其他成员
  memberId: string            // 对外稳定匿名标识
  role: 'owner' | 'editor' | 'viewer'
  displayName: string         // 局内显示名，不等同微信昵称
  status: 'active' | 'left' | 'removed'
  joinedAt: Date
  updatedAt: Date
  lastSeenRevision?: number
}
```

建议索引：

- 唯一：`appid + partyId + openid`。
- 查询我的聚会：`appid + openid + status + updatedAt(desc)`。
- 查询一局成员：`appid + partyId + status + joinedAt(asc)`。

权限原则：数据库集合设为仅云函数可访问。云函数只向客户端返回 `memberId、displayName、role、status`，不得返回其他人的 openid。

### 3.3 `ji_jiu_party_operations`：操作日志与幂等

```ts
type PartyOperationDocument = {
  _id: string
  partyId: string
  appid: string
  operationId: string         // 服务端生成
  clientMutationId: string    // 客户端 UUID，同一成员范围内唯一
  actorMemberId: string
  actorOpenid: string         // 仅服务端使用
  baseRevision: number
  revision: number            // 服务端提交后分配，单局严格递增
  type: 'penalty.add' | 'penalty.reduce' | 'player.add' |
        'player.update' | 'player.remove' | 'settings.update' |
        'party.finish'
  payload: object             // 只允许对应 type 的白名单字段
  createdAt: Date             // 服务端时间
}
```

建议索引：

- 唯一：`appid + partyId + actorOpenid + clientMutationId`，保证弱网重试不重复记账。
- 唯一：`appid + partyId + revision`，保证单局操作序列唯一。
- 增量同步：`appid + partyId + revision(asc)`。

### 3.4 `ji_jiu_party_invites`：二维码或口令邀请

```ts
type PartyInviteDocument = {
  _id: string
  partyId: string
  appid: string
  tokenHash: string
  shortCodeHash?: string
  createdByMemberId: string
  roleToGrant: 'editor' | 'viewer'
  status: 'active' | 'revoked' | 'expired'
  expiresAt: Date
  maxUses?: number
  usedCount: number
  createdAt: Date
}
```

建议索引：

- 唯一：`appid + tokenHash`。
- 可选唯一：`appid + shortCodeHash + status`。
- 清理：`expiresAt` TTL（若当前云数据库环境支持）；否则由定时任务清理。

口令必须使用足够随机的字符并限制有效期、使用次数和失败频率。数据库只保存带服务端盐的摘要；日志中不得记录明文口令或完整邀请 token。

## 4. 加入方式与身份绑定

### 4.1 二维码

创建者调用 `createInvite`，云函数生成一次性或短期 token。小程序码携带短参数，例如 `scene=i_<opaqueToken>`，落地页调用 `joinParty`。云函数根据调用上下文取得 openid，校验 token 后写成员表。

二维码只表达邀请凭证，不直接携带 `partyId、openid` 或聚会数据。分享截图中的静态产品码与“加入某一局”的动态邀请小程序码必须分开，避免误把公开传播素材当作成员邀请。

### 4.2 六位或八位口令

同桌用户可输入短口令加入。口令不区分大小写时要排除易混淆字符；服务端按 `appid + hash(code)` 查询，限制单 openid、单 IP/设备和单口令的失败频率。连续失败需短时冷却。

### 4.3 身份绑定

- 身份以云函数获取的 openid 为准，不能信任客户端传入的 openid。
- 首次加入创建成员记录；重复加入返回已有成员，必须幂等。
- 同一 openid 在同一局只有一个活跃成员身份。
- 局内显示名由用户输入或创建者分配，不自动获取微信昵称、头像；沿用当前登录与隐私策略。
- owner 可撤销邀请、移除成员、转让 owner；最后一个 owner 不允许直接离开。

## 5. 并发写入与冲突处理

### 5.1 命令协议

客户端每次写入发送：

```json
{
  "action": "applyOperation",
  "partyId": "...",
  "clientMutationId": "device-local-uuid",
  "baseRevision": 12,
  "type": "penalty.add",
  "payload": { "playerId": "...", "amount": 1, "unit": "口" }
}
```

云函数执行顺序：

1. 用 openid 查询活跃成员，确认角色允许该操作。
2. 先按 `clientMutationId` 查询；若已处理，直接返回原结果。
3. 在数据库事务内读取 party 当前 `revision` 和状态。
4. 校验 payload、单位和目标 player；已结束的局拒绝新增记账。
5. 对可交换的加减操作按当前快照应用；对改名、删除成员、修改单位等结构性操作要求 `baseRevision === currentRevision`。
6. 写入操作日志、更新聚合快照并将 revision 加一。
7. 返回新 revision、规范化操作和必要的快照差量。

### 5.2 冲突规则

- 惩罚加减是有界增量操作，可在目标仍存在时重放；扣减不得使待完成数小于 0。
- 修改姓名、删除参与者、调整单位属于结构性冲突，revision 不一致时返回 `SYNC_CONFLICT` 和最新快照，不静默覆盖。
- 结束聚会是终态操作。服务端首次成功后，重复请求按幂等成功返回；后续普通操作返回 `PARTY_ENDED`。
- 操作时间以服务端时间为准，客户端时间只可作为 UI 辅助字段。

### 5.3 实时更新

MVP 先使用“页面显示期间每 3—5 秒增量拉取 + 用户操作后立即拉取”，减少监听复杂度。完整形态再引入数据库 watch 或云开发实时数据推送；断线重连后始终以 `revision` 增量追平，不能只依赖推送到达顺序。

## 6. 离线与弱网

- 本地保留当前快照、`lastAppliedRevision` 和待发送操作队列。
- 用户操作先以“待同步”状态乐观更新；成功后用服务端返回结果确认。
- 队列项必须持久化，包含稳定 `clientMutationId`，重启和超时重试不得重新生成 ID。
- 同一设备按创建顺序串行发送；收到 `SYNC_CONFLICT` 时先拉取新快照，再判断是否自动重放。
- 对可交换加减可自动重放；涉及玩家删除、单位变更和结束聚会时必须让用户确认。
- 超过本地队列容量、长时间离线或服务端已结束时，不丢弃未同步操作，应提示导出或查看待处理项。
- 共享局的云端结束失败也继续沿用现有 pending 补偿思路，但 pending 需保存命令 ID 和 revision，防止多端重复结束。

## 7. 向后兼容与迁移

### 7.1 旧数据

- 缺失 `collaborationMode、revision、schemaVersion` 的记录一律视为 `single`。
- 原 `ownerOpenid + ownerAppid` 查询、`upsertActive/getActive/listActive/finish/listEnded` 行为保持不变。
- 旧记录不批量重写。用户首次开启协作时，由云函数在事务内补 `collaborationMode='shared'、revision=0、schemaVersion`，并创建 owner 成员记录。
- 当前 `party` JSON 和字段语义不变，协作能力通过外围字段和新集合扩展。

### 7.2 旧客户端

- 旧客户端只能继续操作 `single` 局。
- 一旦转为 `shared`，旧版 `upsertActive/finish/discardActive/deleteRecord` 必须由云函数识别并拒绝整份覆盖，返回 `CLIENT_UPGRADE_REQUIRED`；否则旧快照可能覆盖多人操作。
- 历史列表可继续返回共享局只读快照，但旧客户端不得恢复共享局为活动局。
- 客户端升级后才能显示成员、邀请和待同步状态。

### 7.3 迁移与回滚

- 单人局升级共享是单向动作；关闭协作只撤销邀请和编辑权限，不降回可被旧客户端整份覆盖的 `single`。
- 所有新字段可选，部署云函数后先保持功能开关关闭，完成双账号真机验证再逐步开放。
- 回滚前保留快照和操作日志；即使关闭前端入口，服务端仍要能读取共享局和完成 pending 补偿。

## 8. 分阶段实施

### 阶段一：协作 MVP

范围：

- 创建/撤销邀请，二维码与短口令加入。
- owner、editor 两种角色；成员列表和移除成员。
- 加减操作通过 `applyOperation` 幂等写入。
- 服务端 revision、操作日志、聚合快照。
- 轮询增量同步和本地待发送队列。
- 旧客户端共享局写入拦截。

暂不做：owner 转让、viewer、实时 watch、跨局身份资料、复杂审计后台。

验收至少覆盖：两台真机同时加减、断网重试不重复、成员被移除后不能继续写、旧客户端不能覆盖共享局。

### 阶段二：完整形态

范围：

- viewer、owner 转让、精细权限和邀请使用次数。
- 实时推送与断线增量追平。
- 冲突可视化、待同步队列管理、操作审计与异常恢复。
- 成员在线状态、协作事件提示和历史导出。
- 邀请风控、滥用监控、限流与运维告警。

可选阶段三再考虑：匿名现场大屏、跨设备头像云存储、多人统计报表。它们不应阻塞核心协作闭环。

## 9. `jijiuPartyRecord` 改动点清单

1. 扩展身份与权限层：新增 `getMembership`、`assertPartyPermission`，所有共享局动作统一鉴权。
2. 增加 `createInvite、revokeInvite、joinParty、leaveParty、listMembers、removeMember`。
3. 增加 `applyOperation、listOperations`，实现事务、revision 和 `clientMutationId` 幂等。
4. `getActive/listActive/listEnded` 从“仅 owner”扩展为“owner 的单人局 + 成员表中的共享局”，响应中不暴露 openid。
5. `upsertActive/finish/discardActive/deleteRecord` 在共享局上按角色与 schema 处理；禁止旧客户端整份覆盖共享局。
6. `finish` 在共享局中变为幂等终态命令，并继续支持现有 pending 重试。
7. `sanitizeParty` 保留旧字段，并分别对白名单命令 payload 做严格校验，禁止客户端任意写 owner、revision 和角色。
8. 统一错误码：`NOT_A_MEMBER、NO_PERMISSION、INVITE_EXPIRED、RATE_LIMITED、SYNC_CONFLICT、PARTY_ENDED、CLIENT_UPGRADE_REQUIRED`。
9. 增加操作日志清理/归档策略、邀请过期清理和限流日志，但日志不得包含明文口令及完整个人标识。
10. `selfCheck` 增加新集合、索引、事务与成员鉴权自检；自检数据必须及时清理。

这些属于后续实现清单，本批只输出设计文档，不修改协作代码或云数据库。

## 10. 主要风险与控制

| 风险 | 后果 | 控制措施 |
| --- | --- | --- |
| 多端整份覆盖 | 丢失其他人的加减记录 | 共享局只接受命令，不接受旧客户端整份覆盖 |
| 弱网重复提交 | 数字被重复增加或扣减 | `clientMutationId` 唯一索引与幂等返回 |
| 越权加入或写入 | 聚会数据泄露、被恶意修改 | 邀请过期、口令摘要、限流、成员表鉴权、集合仅云函数访问 |
| 操作乱序 | 页面数字与记录不一致 | 服务端 revision 单调递增，客户端按 revision 应用 |
| 旧客户端兼容 | 共享快照被回写覆盖 | `CLIENT_UPGRADE_REQUIRED` 与最小 schema 门槛 |
| 大局日志增长 | 查询与存储成本上升 | 增量分页、结束后归档、保留聚合快照 |
| 成员身份隐私 | 暴露 openid 或微信资料 | openid 不下发；局内显示名与微信身份解耦 |
| owner 离开或失联 | 无人管理聚会 | MVP 禁止 owner 离开；完整形态支持转让与超时恢复流程 |

## 11. 上线前检查

- 新集合权限设为仅云函数读写，前端直连测试应失败。
- 建立并验证所有唯一/复合索引，再开放邀请入口。
- 使用两个不同 openid 做加入、并发、移除、结束和历史读取测试。
- 使用旧客户端验证单人局正常、共享局写入被明确拒绝。
- 飞行模式和弱网下验证队列不丢失、恢复后不重复。
- 对口令尝试、邀请创建和写操作做限流与异常告警。
- 先在体验环境启用功能开关，不直接在生产全量开放。
