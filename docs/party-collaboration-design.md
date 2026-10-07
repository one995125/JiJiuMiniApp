# 同一局多人协作设计方案

> **版本 v2（2026-10-08）**。v1 以「多人可写（editor）」为一期目标，需要操作日志、幂等与冲突解决；v2 依据产品决策将其反转为 **一期只做只读共享（房主唯一写入）**，多人可写整体推迟到二期。v1 的核心设计保留在附录 A，作为二期基础。

## 1. 背景与目标

当前 `jijiuPartyRecord` 以 `ownerOpenid + ownerAppid` 隔离数据，一局对应一名用户保存的一份快照，只有房主能记。这带来两个问题：

1. **同桌看不见账本。** 其他人只能口头对账，而房主对自己和所有人的数有单方面写权限——数字是否可信全靠信任，这是产品当前最大的信任缺口。
2. **局内没有交接机制。** 房主中途离开、手机没电时，这局无法继续。

本方案的目标：在不破坏现有单人数据和旧客户端的前提下，让同桌扫码进入**只读面板**，实时看到全员「输 / 喝 / 欠」与逐笔加减流水；并支持身份认领与房主转让。

**一期明确的非目标**：成员不具备任何写入能力。喝酒是面对面场景，纠错、申报、催账一律通过线下沟通完成，不设成员侧操作入口。

## 2. 推荐结论

推荐「**单写者 + 只读成员**」结构：

| 事项 | 结论 |
| --- | --- |
| `ji_jiu_parties` | **结构完全不变**，房主继续整份 `upsertActive` |
| 逐笔流水 | **已存在**（`IPlayer.records`），随快照同步，无需新建集合 |
| 新增集合 | 仅 `ji_jiu_party_members`（成员与身份认领） |
| 新增动作 | `getSharedParty`（只读）、`createInvite`、`joinParty`、`leaveParty`、`listMembers`、`claimPlayer`、`updateMemberClaim`、`transferOwnership` |
| 一期不建 | `ji_jiu_party_operations`、`clientMutationId` 幂等键、`revision` 冲突解决、`CLIENT_UPGRADE_REQUIRED` 拦截 |

**为什么可以省掉 v1 的一整套复杂度：**

- 多人可写的全部成本来自「两个人可能同时改同一份数据」：需要操作日志、幂等键、`baseRevision` 冲突解决、旧客户端整份覆盖拦截。**单写者模型下这些一条都不需要。**
- 房主本地产生的 `records` 就是天然的追加型流水，已经把「谁在什么时候被加了多少」记录完整（`typings/index.d.ts` 的 `IPlayerRecord`）。
- 成员数据存放在独立集合，不随 party 快照上传 → **旧客户端整份覆盖天然安全**，不会波及成员关系。

结论：一期从「3 个新集合 + 一整套冲突语义」降到「1 个新集合 + 零冲突」。

## 3. 数据模型

### 3.1 `ji_jiu_parties`：不改结构

一期**不新增任何必填字段**。可选新增（仅用于运维统计，缺失一律按 `single` 处理）：

```ts
type SharedPartyDocument = {
  // ……现有字段全部保留，语义不变
  collaborationMode?: 'single' | 'shared'
  memberCount?: number
}
```

关键点：`party` 快照、`ownerOpenid`、`records` 全部沿用现有语义，因此现有 `upsertActive / getActive / listActive / finish / listEnded / discardActive / deleteRecord` 的行为**完全不变**。

### 3.2 `ji_jiu_party_members`：成员与身份认领

```ts
type PartyMemberDocument = {
  _id: string                  // `${partyId}_${openidHash}`
  partyId: string
  appid: string
  openid: string               // 仅云函数可读写，不下发
  memberId: string             // 对外稳定匿名标识
  role: 'owner' | 'viewer'
  /** 身份认领：本成员对应 party.players 中的哪个 playerId；未认领时缺省 */
  claimedPlayerId?: string
  displayName: string          // 局内显示名，与微信昵称解耦
  status: 'active' | 'left' | 'removed'
  joinedAt: Date
  updatedAt: Date
  lastSeenAt?: Date
}
```

建议索引：

- 唯一：`appid + partyId + openid`
- **唯一（稀疏）**：`appid + partyId + claimedPlayerId` —— 保证一个 `playerId` 只能被一人认领
- 查询我的局：`appid + openid + status + updatedAt(desc)`
- 查询一局成员：`appid + partyId + status + joinedAt(asc)`

权限原则：集合设为仅云函数可访问。云函数只返回 `memberId / displayName / role / status / claimedPlayerId`，**绝不返回他人 openid**。

### 3.3 邀请凭证

一期采用**无状态轻量方案，不建独立集合**：短码内容为 `partyId + 过期时间`，由服务端 HMAC 签名，云函数校验签名与时效即可。

- 短码有效期默认与「局未结束」绑定，局结束即失效。
- 只授予 `viewer` 角色，不存在「邀请谁当编辑」的选项。
- 支持「重新生成」以作废旧码（旧码因签名中的序列号失配而失效）。

若后续需要「显式撤销单个邀请」「限制使用次数」，再引入 `ji_jiu_party_invites` 集合（设计见附录 A.3）。

### 3.4 房主转让的数据处理

| 路径 | 做法 | 评价 |
| --- | --- | --- |
| **A. 新建局交接**（推荐） | 新房主在自己名下新建一份同结构的局（复制 `settings` 与 `players`，含 `records`），原局标记为已交接 | 数据不跨 owner 迁移、不改写历史归属，实现简单，流水完整保留 |
| B. 改写 `ownerOpenid` | 直接把主记录归属改为新房主 | 现有全部读取以 `ownerOpenid` 过滤，改写等于追溯性变更「房主的历史列表」，易出错、需双向确认与审计 |

推荐 A。理由：只增加一条新记录，完全符合现有模型。

## 4. 加入与身份认领

### 4.1 加入

- 房主在记账页生成邀请（小程序码 / 短口令），落地页调用 `joinParty`。
- 云函数以 `FROM_OPENID / OPENID` 作为真实身份，**不信任客户端传入的 openid**。
- 重复加入必须幂等：同一 openid 在同一局只有一个活跃成员记录。

### 4.2 身份认领（关键前置）

面板要显示「**我**还欠多少」，系统必须知道成员对应名单里的哪一个人。

- 加入后弹出认领列表：`party.players` 的名字（不携带任何微信资料）。
- 认领规则：先到先得；已被认领的名字标记为不可选；**唯一稀疏索引兜底**，并发认领不会写入两条。
- **房主可更正认领**（例如两人认错），在成员列表内操作。
- 认领后可自行更改，改一次即生效。
- 允许不认领：成员仍可看全员榜与流水，只是没有「我的」高亮卡片。

### 4.3 一期不做的成员操作

成员侧**零写操作**。以下均明确不做：举手 / 申报 / 纠错申请 / 催账 / 代记。理由：面对面场景下口头沟通成本更低，且任何成员侧写入都会把冲突问题重新引入。

## 5. 只读面板

### 5.1 内容

- **顶部**：局状态（进行中时长、单位换算）、「只读」标识
- **我的卡片**：认领的玩家高亮置顶，显示「输 / 喝 / 欠」
- **全员榜**：每人「输 / 喝 / 欠」+ 称号（复用 `utils/party-overview.ts`）
- **实时流水**：时间倒序展示逐笔记录（时间 + 人名 + 增减量），数据源即 `player.records`
- **页脚**：「账本由房主维护 · 更新于 X 秒前」

### 5.2 实时性

小程序没有廉价可靠的推送，方案为：

- **前台轮询 3~5 秒**；`onHide` 立即停止，`onShow` 恢复并立即拉一次。
- 界面必须显示「更新于 X 秒前」并提供下拉手动刷新，**不得让用户误以为延迟为零**。
- 无更新时数字不得跳动：先对比 `updatedAt` 或内容摘要，再决定是否 `setData`。

### 5.3 返回裁剪（性能硬约束）

轮询不能每次下发全量快照——party 最多 50 名玩家，每人最多 500 条 `records`（见云函数 `sanitizeParty`），全量会非常重。`getSharedParty` 必须裁剪：

- 返回：局状态、`settings`、每名玩家的**聚合数**（`totalSips / consumedUnits`）、以及**最近 N 条流水**（建议 30~50 条）。
- 更早的流水通过独立的 `listSharedOperations(partyId, cursor)` 分页拉取，或不提供。
- 流水必须带服务端可比较的时间戳，供客户端判断「是否有新内容」。

## 6. 房主转让

### 6.1 定位

转让解决的是**局内换手**——房主中途离开、手机没电，需要换人继续记账时的可靠性问题。它**不是**裂变机制（见 §7.3）。

### 6.2 流程

1. 房主在成员列表选择一个已加入成员，发起转让。
2. 云函数生成交接凭证，被转让人确认后执行 §3.4 路径 A（新建局交接）。
3. 交接完成后：新房主名下出现这局并可继续记账；原局邀请失效并标记为已交接；原房主降为 viewer 或退出。
4. 成员表同步更新 `role`。

### 6.3 边界

- 一局同时只能有一个 owner。
- 交接任一步失败不得造成「两边都能写」或「两边都不能写」，需事务提交并保留补偿。
- 保留一个「取消交接」窗口。

## 7. 裂变链路（产品视角）

### 7.1 链路的真实形态

```text
房主 A 开局 → 同桌 B · C · D 扫码加入（本局拉新 3 人）
   ↓ 局结束，A 把记账权交给 B（或由 B 自己开下一局）
下一局由 B 开局 → B 的同桌 E · F · G 扫码加入（再拉新 3 人）
   ↓
再下一局由 C 开局 ……
```

拉新触点从「永远只有 A 一个人分享」变成「每换一次开局人就多一个分享者」。

### 7.2 拉新的直接动机

拉新的直接动机是「**我要记账，需要同桌扫码进来**」。这个动机的前提是有人**以房主身份开局**——而现有产品任何人都能开局，不需要任何授权。

### 7.3 需要澄清的一点：「房主转让」对裂变的贡献是间接的

制约裂变的关键**不是**「缺转让功能」，而是：

- 用户没有形成「下次我来开局」的习惯；
- 分享动作本身不够顺手（缺素材）。

因此更直接的裂变手段是：

1. **结算页「换人开局」引导**（成本极低）：结算页 / 战绩长图旁加一句「下次让张三来记」，点击即把「开局人」的预期转移给另一名同桌。这一条比转让更直接、更便宜。
2. **分享素材**：战绩长图已带小程序码（第 1 批已实现），是朋友圈传播的正确载体。

转让仍有价值：新房主获得「我是主人」的身份感后，更可能自发开局与分享——但它是**可靠性功能**，不应作为裂变主力。

## 8. 向后兼容

- `ji_jiu_parties` 结构不变，**旧客户端读写共享局完全正常**（共享局对旧客户端就是一个普通单人局）。
- 成员数据在独立集合，不随 party 快照上传，**旧客户端整份覆盖不会破坏成员关系**。
- 旧客户端看不到成员与面板，仅此而已，不产生数据风险 → v1 的 `CLIENT_UPGRADE_REQUIRED` 拦截机制一期**不需要**。
- 所有新增字段可选，缺失按 `single` / 未认领处理。

## 9. 分阶段实施

### 阶段一（本批目标）：只读共享

范围：

- 邀请生成（小程序码 / 短口令）与 `joinParty`
- `ji_jiu_party_members` 成员表与 `listMembers`
- **身份认领**（认领、改认领、房主更正）
- 只读面板 `getSharedParty`（含返回裁剪）
- 前台轮询 + 更新时间提示 + 下拉刷新
- 房主转让（新建局交接路径）
- 结算页「换人开局」引导（裂变，成本极低）

不做：成员侧任何写操作、多人可写、操作日志、实时推送、跨局身份资料。

验收至少覆盖：

- 两台真机：房主记账，成员端 5 秒内看到变化
- 身份认领正确；两人不能认领同一人
- 成员端无任何可写入口（接口层亦拒绝）
- 房主用旧客户端整份覆盖后，成员关系与面板不受影响
- 转让交接后新房主可继续记账，原局不再可写

### 阶段二：多人可写（待定）

若后续确需「成员各自勾销」，再引入附录 A 的完整方案。该阶段会重新引入操作日志、幂等与冲突解决，成本显著高于阶段一。

### 阶段三（可选）

匿名现场大屏、跨设备头像云存储、多人统计报表。不应阻塞核心闭环。

## 10. `jijiuPartyRecord` 改动点清单

1. 新增只读动作 `getSharedParty`：校验调用者为该局 owner 或活跃成员；返回裁剪快照（聚合数 + 最近 N 条流水）；不返回他人 openid。
2. 新增 `createInvite`：生成带签名的短码（无状态），只授予 viewer。房主专属。
3. 新增 `joinParty`：以 `OPENID` 落库，幂等；写成员表。
4. 新增 `leaveParty`：成员自行退出；owner 不允许直接离开。
5. 新增 `listMembers`：返回 `memberId / displayName / role / status / claimedPlayerId`；房主可额外执行 `removeMember`。
6. 新增 `claimPlayer` / `updateMemberClaim`：认领或更正认领，需校验 `playerId` 未被他人认领（唯一稀疏索引兜底）。
7. 新增 `transferOwnership`：交接凭证 + 确认后执行新建局交接，事务提交。
8. 现有动作**行为不变**：`upsertActive / finish / getActive / listActive / listEnded / discardActive / deleteRecord` 不改语义。
9. `sanitizeParty` 不变；仅新增成员集合写入的字段白名单校验（禁止客户端写 `role / openid / memberId`）。
10. 统一错误码：`NOT_A_MEMBER / NO_PERMISSION / INVITE_EXPIRED / ALREADY_CLAIMED / PARTY_ENDED / PARTY_HANDED_OVER`。
11. 成员表与短码的清理策略；日志不得包含明文口令与完整 openid。

## 11. 主要风险与控制

| 风险 | 后果 | 控制措施 |
| --- | --- | --- |
| 成员越权写入 | 账本被非房主修改 | 一期成员侧无任何写接口；`getSharedParty` 只读 |
| 轮询下发全量快照 | 流量与渲染压力 | 返回裁剪（聚合数 + 最近 N 条流水） |
| 用户误以为实时 | 数字滞后引发争执 | 显示「更新于 X 秒前」+ 下拉刷新 |
| 邀请凭证泄露 | 陌生人围观局内数据 | 短码短有效期、局结束即失效、可重新生成 |
| 身份认领冲突 | 两人认领同一人，显示混乱 | 唯一稀疏索引 + 先到先得 + 房主可更正 |
| 转让过程中断 | 两边都能写或都不能写 | 事务提交 + 交接凭证 + 取消窗口 + 补偿 |
| 房主长期失联 | 无人能继续记账 | 转让即为缓解手段；后续可加超时自动交接 |
| 成员身份隐私 | 暴露 openid 或微信资料 | openid 不下发；局内显示名与微信身份解耦 |

## 12. 上线前检查

- 新集合权限设为仅云函数读写，前端直连测试应失败。
- 建立并验证成员表索引（含 `claimedPlayerId` 稀疏唯一）。
- 两个不同 openid 验证：加入、认领、改认领、退出、被移除、转让。
- 验证旧客户端整份覆盖共享局后，成员关系与面板数据不受影响。
- 弱网与飞行模式验证轮询恢复、面板不显示过期数字。
- 先在体验环境启用，不直接全量开放。

---

## 附录 A：v1 多人可写方案要点（二期待定）

仅在阶段二需要「成员各自勾销」时启用。届时需重新引入：

### A.1 `ji_jiu_party_operations` 操作日志

不可变操作记录，字段包含 `clientMutationId`（客户端 UUID，幂等键）、`actorMemberId`、`baseRevision`、`revision`（服务端分配、单局严格递增）、`type`（`penalty.add` / `penalty.reduce` / `player.*` / `settings.update` / `party.finish`）、白名单 `payload`、服务端 `createdAt`。

索引：唯一 `appid + partyId + actorOpenid + clientMutationId`（防弱网重复记账）、唯一 `appid + partyId + revision`（保证序列唯一）、增量同步 `appid + partyId + revision(asc)`。

### A.2 命令协议与冲突规则

客户端发送 `applyOperation`（含 `clientMutationId` 与 `baseRevision`）；服务端先查幂等键，再在事务内校验 revision、应用增量、写日志、递增 revision。

- 惩罚加减为有界增量，可重放；扣减不得使待完成数小于 0。
- 改名、删人、改单位属结构性冲突，revision 不一致时返回 `SYNC_CONFLICT` 与最新快照，禁止静默覆盖。
- 结束聚会为终态命令，重复请求幂等返回。
- 时间以服务端为准。

### A.3 `ji_jiu_party_invites` 邀请集合

需要「显式撤销」「限制次数」时引入：`tokenHash` / `shortCodeHash` / `roleToGrant`（`editor` | `viewer`）/ `status` / `expiresAt` / `maxUses` / `usedCount`。只保存摘要，不保存明文。

### A.4 离线队列与旧客户端拦截

本地持久化待发送队列（含稳定 `clientMutationId`，重启不得重生成），同一设备串行发送，收到 `SYNC_CONFLICT` 先拉新快照再判断是否重放。转 `shared` 后，旧客户端的 `upsertActive / finish / discardActive / deleteRecord` 必须被识别并拒绝整份覆盖，返回 `CLIENT_UPGRADE_REQUIRED`。
