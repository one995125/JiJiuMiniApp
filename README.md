# 记酒小程序

记酒是一款微信原生聚会惩罚记账工具。游戏输了先增加待完成数，实际完成后再扣减，统一展示每个人“输多少、完成多少、还欠多少”。饮料、积分、零食等友好方式均可作为惩罚单位的实际替代，不鼓励劝酒或拼酒。

## 技术栈

- 微信原生小程序：WXML、TypeScript、Less、JSON。
- 渲染：Skyline。
- 组件框架：glass-easel。
- UI：TDesign MiniProgram `1.10.x`。
- 二维码：`uqrcodejs`。
- 云开发：微信云开发原生 API 与 Node.js 云函数。
- 包管理：pnpm；仓库同时保留锁文件和已构建的 `miniprogram/miniprogram_npm`。

本项目不依赖浏览器 DOM/BOM。页面、Canvas 和授权流程均使用微信小程序 API。

## 主要能力

- 首页创建参与者，选择杯/瓶/罐及每单位口数后开局。
- 记录页支持快捷加减、自定义数量、批量操作、撤销和个人明细。
- 总览展示排名、“输 / 喝 / 欠”、趣味称号、欠数最多者及全员操作记录。
- 生成 750 × 1334 战绩长图，支持保存到相册和分享给朋友。
- 切后台仅暂停；返回前台扣除暂停时间，单次暂停超过默认 8 小时才自动结束。
- 主动结束及超时结束均保留云同步失败后的 pending 补偿。
- 历史记录支持活动局恢复、已结束记录分页、删除和继续记录。
- 支持深色模式、首次引导、普通分享与增长来源事件。
- 云健康页用于检查登录、共享环境、数据库读写和云函数状态。

当前云同步按 openid/appid 隔离，属于单人跨设备恢复，不是多人同时编辑同一局。多人协作方案见 [docs/party-collaboration-design.md](docs/party-collaboration-design.md)。

## 目录结构

```text
.
├─ miniprogram/
│  ├─ app.ts / app.json / app.less
│  ├─ pages/
│  │  ├─ index/          # 首页与开局设置
│  │  ├─ record/         # 记账、总览、结束与战绩图
│  │  ├─ history/        # 活动局与历史记录
│  │  ├─ landing/        # 分享和内容来源落地
│  │  └─ cloud-health/   # 云能力自检
│  ├─ components/        # 头像、导航、首次引导、称号提示等
│  ├─ services/          # 登录、酒局云同步、增长统计
│  ├─ utils/             # 本地存储、总览、生命周期、长图绘制等
│  ├─ config/            # 云环境与产品配置
│  └─ miniprogram_npm/   # 微信开发者工具构建后的 npm 产物
├─ cloudfunctions/
│  ├─ cloudbase_auth/    # 共享云环境调用方鉴权
│  ├─ jijiuLogin/        # 记酒登录与身份初始化
│  └─ jijiuPartyRecord/  # 活动局、结束、历史、删除与自检
├─ docs/                 # 云开发、增长和多人协作设计文档
├─ typings/              # 业务全局类型与微信 API 类型引用
├─ project.config.json   # 微信开发者工具项目配置
└─ PRD-hejiujizhang.md   # 当前产品口径与验收要求
```

共享云环境中可能还存在其他项目的函数目录；本小程序运行时只通过 `miniprogram/config/cloud.ts` 配置调用 `jijiuLogin` 和 `jijiuPartyRecord`，共享环境初始化另依赖 `cloudbase_auth`。不要把其他项目的登录函数替换成本项目函数。

## 本地开发

### 1. 环境准备

- 微信开发者工具，建议使用支持 Skyline 与 Canvas 2D 的稳定版本。
- Node.js 与 pnpm。
- 有权访问目标小程序 AppID 和对应云开发环境的微信账号。

### 2. 安装依赖

```bash
pnpm install
```

若依赖已完整安装且 `miniprogram/miniprogram_npm` 已存在，可以直接导入项目。依赖发生变化后，在微信开发者工具中执行“工具 → 构建 npm”。本项目当前不需要额外第三方依赖。

### 3. 导入项目

在微信开发者工具中选择“导入项目”，目录指向仓库根目录。`project.config.json` 已声明小程序目录和云函数目录；导入后确认 AppID、基础库版本、Skyline 和 glass-easel 配置符合当前环境。

### 4. 配置云环境

云配置位于 `miniprogram/config/cloud.ts`：

- `CLOUD_RESOURCE_APPID`：共享云环境的资源方 AppID。
- `CLOUD_RESOURCE_ENV`：共享云环境 ID。
- `CLOUD_ENV_ID`：不使用共享环境时的当前小程序云环境 ID。

生产、体验和开发环境不要共用未确认的数据集合。更换配置前先核对资源方授权，不要把 SecretId、SecretKey 或其他长期密钥写入仓库。

详细集合、索引和部署顺序见 [docs/cloud-development.md](docs/cloud-development.md)。

### 5. 类型检查

Windows PowerShell 若阻止执行 `npx.ps1`，可使用：

```powershell
npx.cmd tsc --noEmit
```

其他环境可使用：

```bash
pnpm exec tsc --noEmit
```

类型检查不等同于微信开发者工具编译、云函数部署或真机验收。涉及 WXML、Skyline、Canvas、授权和分享时仍须在开发者工具与真机验证。

## 页面说明

### 首页 `pages/index/index`

- 首次使用三步引导。
- 参与者创建、删除和历史设置恢复。
- 单位选择与每单位口数设置。
- 只有“至少一名参与者且已选择单位”才能开局。
- 继续本地或云端未结束聚会。

### 记录页 `pages/record/record`

- 单人和批量加减、操作撤销、改名和排序。
- 快捷完成整单位与自定义口数。
- 总览排名、称号、英雄位和全员记录。
- 战绩长图生成、相册保存与微信分享。
- 主动结束及结束失败补偿。

### 历史页 `pages/history/history`

- 同步并展示活动局。
- 使用云函数游标分页加载已结束记录。
- 查看总览、继续记录和删除本人记录。
- 时长统计扣除暂停时间。

### 落地页 `pages/landing/landing`

- 接收普通分享与内容渠道参数。
- 记录最小化的增长归因事件。
- 引导用户进入首页或继续聚会。

### 云健康页 `pages/cloud-health/cloud-health`

- 检查云环境、登录身份、临时读写与清理。
- 仅用于诊断；静态检查成功不能替代真实云端部署和数据库证据。

## 云函数

### `cloudbase_auth`

共享环境的前置鉴权函数。使用共享环境时，需在资源方维护允许调用的小程序 AppID 白名单。

### `jijiuLogin`

获取云函数上下文中的用户身份并初始化本项目用户数据。身份以服务端上下文为准，不能信任客户端传入的 openid。

### `jijiuPartyRecord`

当前动作包括：

- `upsertActive`：保存未结束聚会。
- `getActive`：读取最近一个活动局。
- `listActive`：读取活动局列表。
- `finish`：保存已结束聚会。
- `discardActive`：丢弃本人活动局。
- `deleteRecord`：删除本人指定记录。
- `listEnded`：按稳定游标分页读取历史。
- `selfCheck`：创建、读回并清理临时测试记录。

数据集合为 `ji_jiu_parties`，必须设置为仅云函数读写，并建立文档中要求的复合索引。所有读写同时校验 `ownerOpenid + ownerAppid`，防止共享环境中的跨应用或跨用户访问。

## 核心数据口径

- `totalSips`：当前待完成口数，不是累计饮酒量。
- `consumedUnits`：已通过整单位快捷操作完成的数量。
- 输：累计记入的惩罚折合单位。
- 喝：现有 UI 对“已完成整单位数”的简称；替代玩法中表示已完成。
- 欠：当前待完成口数折合单位。
- `pausedAt`：当前后台暂停开始时间，可选。
- `pausedDurationMs`：已累计暂停毫秒数，可选。
- `endedAt`：真实结束时间；只有主动结束或超时自动结束时写入。

完整字段定义和称号口径见 [PRD-hejiujizhang.md](PRD-hejiujizhang.md)。

## 开发约定

- 优先保持现有数据协议；新增字段必须可选并兼容旧缓存、旧云数据和旧客户端。
- 页面不直接做复杂数据库写入，统一通过 `services/` 和云函数。
- 本地存储统一走 `utils/storage.ts`，避免缓存与 storage 状态分叉。
- 总览计算和称号文案统一由 `utils/party-overview.ts` 提供，不在页面或海报中复制另一套规则。
- 生命周期时长统一走 `utils/party-lifecycle.ts`，避免暂停时间被重复累计。
- Canvas 长图只使用真实聚会数据；失败必须降级，不得影响记账主流程。
- 不上传本地 `wxfile://` 头像；跨设备恢复使用文字头像。
- 不在代码、日志或文档中写入用户 openid、口令或密钥。
- 修改云函数后先更新兼容性与索引说明，再在体验环境验证；未经确认不直接部署生产。
- 用户可见文案不得鼓励强迫饮酒、拼酒或未成年人饮酒，并保留饮料/积分替代与饮酒勿驾车提示。

## 验证建议

每次涉及记账、生命周期或云同步时至少验证：

1. 新开局后加一笔、减一笔、撤销一次，总览与明细一致。
2. 切后台数分钟再返回，聚会未结束且时长扣除暂停。
3. 模拟暂停超过阈值，自动结束并在云失败时保留 pending。
4. 无网操作、本地重启、云恢复和旧数据缺少可选字段。
5. iOS 与 Android 分别生成长图，检查文字、DPR、二维码、相册授权和分享图片。

发布前还需在微信公众平台核对用户隐私保护指引中的相册保存用途，以及实际使用 API 与平台声明是否一致。

## 合规说明

本项目仅限成年人健康娱乐。饮料、积分或其他友好方式可以替代酒精；拒绝劝酒，饮酒勿驾车。不得用本项目组织灌酒、拼酒、酒量挑战或面向未成年人的饮酒活动。
