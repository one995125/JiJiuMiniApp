# 自媒体来源归因与事件统计

## 目标

本项目使用微信小程序官方 `wx.reportAnalytics` 上报增长事件。代码只上传渠道、活动、内容编号、入口场景和操作类型，不上传参与者姓名、头像、openid 或具体惩罚数量。

事件统一由 `miniprogram/services/growth-analytics.ts` 管理。来源只在当前运行会话内保留；下一次无参数冷启动恢复为 `direct`，避免把自然回访长期误算给旧内容。页面不要自行拼装来源字段，避免同一指标出现多种口径。

## 五个事件

在小程序管理后台的「统计 / 自定义分析」中建立以下事件，并为每个事件配置公共字段：

| 事件名 | 含义 | 触发时机 | 附加字段 |
| --- | --- | --- | --- |
| `landing_view` | 一次有效入口访问 | App 冷启动，或通过新的推广入口重新进入 | `entry_path` |
| `counter_started` | 创建并开始一份聚会记录 | 首页保存人员和单位后进入记录页 | `player_count`、`action_mode` |
| `penalty_added` | 实际提交一次增加 | 单人或批量加数完成后 | `action_mode`、`affected_count` |
| `penalty_reduced` | 实际提交一次扣减 | 单人、快捷或批量减数完成后 | `action_mode`、`affected_count` |
| `share_clicked` | 用户调起好友或朋友圈分享 | 页面返回分享配置时 | `share_target`、`entry_page` |

所有事件还包含以下公共字段：

- `source`：入口来源，例如 `wxvideo`、`share`、`timeline`、`direct`。
- `campaign`：推广批次，例如 `organic_2026q4`。
- `content_id`：单条内容编号，例如 `w01_pain_01`。
- `entry_scene`：微信启动场景值；仅用于聚合排查入口差异。

## 推广入口格式

视频号作品优先使用完整页面路径：

```text
pages/index/index?source=wxvideo&campaign=organic_2026q4&contentId=w01_pain_01
```

若通过微信后台生成受 `scene` 长度限制的小程序码，使用紧凑参数：

```text
s=wxv&c=26q4&i=w01p1
```

代码会把 `s=wxv` 还原为 `source=wxvideo`。紧凑内容编号与完整编号的对应关系记录在 `docs/growth-weekly-tracker.csv`，不要在发布后复用同一个编号。

没有可挂载入口时，视频结尾固定展示“微信搜索记酒”，并使用作品专属小程序码。小程序码通过微信公众平台或开发者工具的官方入口生成，不在本地保存 AppSecret，也不把密钥写入脚本。

## 后台漏斗与周报

建立两个漏斗：

1. 获客漏斗：`landing_view → counter_started → penalty_added/penalty_reduced`。
2. 裂变漏斗：`counter_started → share_clicked`。

周报只导出以下聚合指标：

- 每条内容的播放量、完播率、入口访问数、有效使用人数。
- 每千次播放有效用户数：`有效使用人数 ÷ 播放量 × 1000`。
- 启动转化率：`counter_started 去重人数 ÷ landing_view 去重人数`。
- 分享率：`share_clicked 去重人数 ÷ counter_started 去重人数`。

不要导出或展示单个用户的参与者姓名、记录详情或好友身份。

## 验证步骤

1. 在微信开发者工具使用自定义编译条件进入：`pages/index/index?source=wxvideo&campaign=test&contentId=test_01`。
2. 添加至少一人并开始聚会，分别完成一次增加、一次扣减和一次分享。
3. 在调试器确认没有 `reportAnalytics` 异常；正式数据按微信后台统计延迟查看。
4. 在后台按 `content_id=test_01` 筛选，确认五个事件及公共字段均可识别。
5. 再用好友分享进入，确认新入口的 `source` 为 `share`，同时保留原 `campaign/content_id`。

> 静态编译只能证明调用与字段存在，不能代替微信后台事件配置、体验版数据上报和真机验收。
