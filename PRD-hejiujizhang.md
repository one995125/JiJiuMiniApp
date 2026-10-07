# 产品需求文档 (PRD)

## 酒局记账小程序

---

## 1. 文档概述

### 1.1 文档目的
本文档定义了"酒局记账小程序"的产品需求，用于指导开发团队进行设计与开发。

### 1.2 目标读者
- 产品经理
- UI/UX设计师
- 前端开发工程师
- 后端开发工程师
- 测试工程师

### 1.3 版本历史

| 版本 | 日期 | 作者 | 变更说明 |
|------|------|------|----------|
| v1.0 | 2026-04-08 | - | 初始版本 |
| v1.1 | 2026-04-08 | - | 更新：20人上限、单位标签、保留1位小数、TDesign设计体系 |

---

## 2. 产品背景

### 2.1 问题陈述
聚会饮酒时，常需要记录每个人喝了多少酒，传统方式（纸笔或心算）容易出错且不便统计。需要一个数字化工具来：
- 快速记录多人饮酒量
- 支持灵活的酒量单位换算
- 实时查看排行榜和统计

### 2.2 目标用户
- **主要用户**：18-40岁，经常参与朋友聚会、酒局的人群
- **使用场景**：KTV、饭局、家庭聚会、户外烧烤等饮酒场合

### 2.3 价值主张
- **便捷**：微信小程序，无需下载，即用即走
- **灵活**：支持自定义人员和酒量单位
- **实时**：多人同时记账，数据同步更新
- **透明**：排行榜展示，饮酒量一目了然

---

## 3. 功能需求

### 3.1 功能列表

| 模块 | 功能 | 优先级 | 说明 |
|------|------|--------|------|
| 首页 | 参与人员编辑 | P0 | 添加、删除、修改参与人员（最多20人） |
| 首页 | 酒量单位设置 | P0 | 选择单位标签（杯/瓶/罐），设置等于几口 |
| 首页 | 开始聚会 | P0 | 进入记账页面 |
| 记账页 | 个人加减操作 | P0 | 点击人员增减酒量 |
| 记账页 | 批量操作 | P1 | 多选人员同时加减 |
| 记账页 | 排行榜 | P0 | 显示当前饮酒排名和记录（保留1位小数） |
| 记账页 | 智能排序 | P1 | 按酒量自动排序（多的在前） |
| 记账页 | 撤销操作 | P1 | 支持撤销最近一次操作 |
| 记账页 | 震动反馈 | P2 | 加减操作时震动提示 |
| 记账页 | 计时功能 | P2 | 显示聚会进行时长 |
| 记账页 | 图片导出 | P2 | 生成战绩图分享朋友圈 |
| 系统 | 本地存储 | P0 | 数据保存在本地 |
| 系统 | 夜间模式 | P2 | 暗黑主题切换 |
| 系统 | 字体大小 | P3 | 支持调节字体大小 |

### 3.2 详细功能描述

#### 3.2.1 首页 - 参与人员编辑

**功能描述**：
- 支持添加参与人员，输入姓名（支持1-6个字符）
- 支持删除已添加的人员
- 支持修改人员姓名
- 最少1人，最多支持20人

**交互规则**：
- 添加人员：点击"添加"按钮，弹出输入框，输入姓名后确认
- 删除人员：左滑人员项显示删除按钮，或长按弹出删除确认
- 修改姓名：点击人员姓名进入编辑状态
- 实时显示当前人数：参与人员 (3/20人)

**示例**：
输入：龙、聪、仁 → 显示三个人员卡片

#### 3.2.2 首页 - 酒量单位设置

**功能描述**：
- 首页设置酒量单位标签，可选：杯、瓶、罐（默认"瓶"）
- 设置选中的单位等于几口（默认6口）
- 口数范围：1-50口

**交互规则**：
- 使用标签选择器切换单位（杯/瓶/罐）
- 使用数字输入框或步进器（+/-按钮）设置口数
- 实时显示当前设置值：1[瓶] = [6] 口

**示例**：
- 选择"瓶"标签，设置1瓶 = 6口
- 选择"罐"标签，设置1罐 = 4口
- 选择"杯"标签，设置1杯 = 1口

#### 3.2.3 首页 - 开始聚会

**功能描述**：
- 点击后进入记账页面
- 校验：至少要有1名参与人员才能开始

**交互规则**：
- 按钮状态：人员数≥1时高亮可点击，否则置灰
- 点击后跳转记账页，携带人员列表和酒量设置参数

#### 3.2.4 记账页 - 个人加减操作

**功能描述**：
- 显示所有参与人员列表
- 每人显示：姓名、当前已喝口数、换算后的单位数量（如1.3罐、4.5瓶）
- 点击人员展开操作面板：+1口、-1口、+[单位]、-[单位]

**交互规则**：
- 点击人员行展开/收起操作面板
- 操作后实时更新数据
- 减操作不能低于0口
- 操作后显示toast提示（如"龙 +1口"）

**计算公式**：
```
显示数量 = 当前口数 ÷ 单位对应的口数
结果保留1位小数
```

**示例**：
- 设置：单位="瓶"，1瓶=6口
- 龙当前12口 → 显示"2.0瓶"
- 点击"+1口" → 13口 → "2.2瓶"

**示例2**：
- 设置：单位="罐"，1罐=4口
- 龙当前10口 → 显示"2.5罐"

#### 3.2.5 记账页 - 批量操作

**功能描述**：
- 支持多选人员
- 对选中人员进行统一加减操作

**交互规则**：
- 点击"多选"进入选择模式
- 人员项显示复选框
- 底部显示操作栏：全选、取消、+1口、-1口、+[单位]
- 点击"完成"退出选择模式

#### 3.2.6 记账页 - 排行榜

**功能描述**：
- 按饮酒量从高到低排序
- 显示：排名、姓名、口数、单位数量（保留1位小数）
- 显示每个人的加减记录流水（时间+操作+数值）

**交互规则**：
- 点击排行榜入口展开/收起
- 记录流水按时间倒序排列
- 支持清空单个人的记录（需确认）

**示例排行榜**（假设单位设为"瓶"，1瓶=6口）：
```
🥇 龙 - 12口 (2.0瓶)
🥈 聪 - 9口 (1.5瓶)  
🥉 仁 - 6口 (1.0瓶)
```

**示例**（假设单位设为"罐"，1罐=4口）：
```
🥇 龙 - 10口 (2.5罐)
🥈 聪 - 6口 (1.5罐)
```

#### 3.2.7 记账页 - 智能排序

**功能描述**：
- 记账页人员列表按酒量自动排序（喝得多的在前）
- 支持切换：智能排序 / 原始顺序
- 实时更新排序

**交互规则**：
- 默认开启智能排序
- 顶部显示排序切换按钮
- 排序变化时有过渡动画

**示例**：
- 龙：12口 → 排第一
- 聪：9口 → 排第二
- 仁：6口 → 排第三

#### 3.2.8 记账页 - 撤销操作

**功能描述**：
- 支持撤销最近一次加减操作
- 显示撤销按钮，有可撤销内容时高亮
- 最多保留10步操作历史

**交互规则**：
- 点击撤销按钮恢复上一步
- 撤销后显示toast提示"已撤销"
- 无操作可撤销时按钮置灰
- 支持手势：左滑撤销（可选）

**示例**：
1. 龙当前6口
2. 点击+一瓶 → 12口
3. 点击撤销 → 恢复6口
4. Toast提示"已撤销：龙 -6口"

#### 3.2.9 记账页 - 震动反馈

**功能描述**：
- 加减操作时触发手机震动
- 不同操作不同震动模式

**交互规则**：
- +操作：短震动（50ms）
- -操作：双短震动（30ms+30ms）
- 批量操作：长震动（100ms）
- 可在设置中关闭

**技术实现**：
```javascript
wx.vibrateShort({ type: 'heavy' }) // 加操作
wx.vibrateShort({ type: 'light' }) // 减操作
```

#### 3.2.10 记账页 - 计时功能

**功能描述**：
- 记录聚会进行时长
- 顶部显示计时器
- 聚会结束时显示总时长

**交互规则**：
- 进入记账页自动开始计时
- 格式：HH:MM（如 02:35）
- 点击计时器可暂停/继续
- 结束聚会时显示"本次聚会时长：2小时35分钟"

**显示位置**：
- 记账页顶部导航栏右侧
- 排行榜底部显示总时长

#### 3.2.11 记账页 - 图片导出

**功能描述**：
- 生成聚会战绩图片
- 包含排行榜、总时长、参与人员
- 支持分享到朋友圈

**交互规则**：
- 点击"分享战绩"按钮
- 生成canvas图片
- 预览后可保存或分享
- 图片尺寸：750×1334px（适配朋友圈）

**图片内容**：
```
┌─────────────────┐
│   酒局战绩      │
│   2026.04.08    │
├─────────────────┤
│  🥇 龙  2.0瓶   │
│  🥈 聪  1.5瓶   │
│  🥉 仁  1.0瓶   │
├─────────────────┤
│  时长：2小时35分 │
│  共计：3人      │
└─────────────────┘
```

#### 3.2.12 系统 - 夜间模式

**功能描述**：
- 支持暗黑主题切换
- 自动/手动切换

**交互规则**：
- 设置页开启夜间模式开关
- 可选：跟随系统 / 始终开启 / 始终关闭
- 切换时有过渡动画

**暗黑主题色值**：
| 元素 | 色值 |
|------|------|
| 背景 | `#1A1A2E` |
| 卡片 | `#252540` |
| 主文字 | `#E0E0E0` |
| 次要文字 | `#A0A0B0` |
| 主色 | `#F5A623`（保持） |

#### 3.2.13 系统 - 字体大小

**功能描述**：
- 支持调节字体大小
- 三档：小 / 中 / 大

**交互规则**：
- 设置页选择字体大小
- 实时预览效果
- 默认：中

**字号映射**：
| 层级 | 小 | 中（默认） | 大 |
|------|-----|-----------|-----|
| 标题 | 18px | 20px | 22px |
| 正文 | 14px | 16px | 18px |
| 数据 | 24px | 28px | 32px |

#### 3.2.14 系统 - 数据存储

**功能描述**：
- 数据存储在本地（微信小程序 Storage）
- 用户主动结束聚会或重新进入小程序可开始新聚会
- 数据随小程序生命周期，关闭后保留，卸载后清除

**数据结构**：
```json
{
  "partyId": "uuid",
  "createdAt": "2026-04-08T14:00:00Z",
  "settings": {
    "unit": "瓶",
    "unitToSip": 6
  },
  "players": [
    {
      "id": "p1",
      "name": "龙",
      "totalSips": 12,
      "records": [
        {"time": "14:05", "action": "+", "amount": 6, "unit": "口"},
        {"time": "14:10", "action": "+", "amount": 1, "unit": "口"}
      ]
    }
  ]
}
```

### 3.3 用户故事

**故事1：创建聚会**
> 作为聚会参与者，我想在小程序中添加参与人员，设置酒量单位，然后开始记账，以便快速开始记录。

**故事2：个人记账**
> 作为记账者，我想点击人员名字进行加减操作，以便记录每个人喝了多少酒。

**故事3：批量记账**
> 作为记账者，我想同时选择多人进行统一操作，以便在大家一起干杯时快速记录。

**故事4：查看排名**
> 作为聚会参与者，我想查看排行榜和每个人的饮酒记录，以便了解当前酒局情况。

**故事5：智能排序**
> 作为记账者，我想看到喝得最多的人排在最前面，以便快速找到需要关注的人。

**故事6：撤销操作**
> 作为记账者，我手滑点错了，想撤销刚才的操作，以免记错数据。

**故事7：震动反馈**
> 作为记账者，我希望操作时有震动反馈，以便确认操作已成功。

**故事8：计时功能**
> 作为聚会参与者，我想知道这次聚会进行了多久，以便掌握时间。

**故事9：分享战绩**
> 作为聚会参与者，我想生成战绩图发朋友圈，记录这次聚会。

**故事10：夜间模式**
> 作为用户，我在KTV等暗光环境使用，希望有夜间模式保护眼睛。

**故事11：字体调节**
> 作为视力不好的用户，我想调大字体，以便看清内容。

### 3.4 流程图

```
[启动小程序]
    ↓
[首页] ←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←
    ↓                                               ↑
[编辑人员] ←→ [设置酒量]                            │
    ↓                                               │
[点击开始聚会] ──→ [记账页面] ──→ [结束聚会返回首页] ─┘
    ↓
[选择人员操作]
    ↓
[加减酒量] ←→ [查看排行榜]
```

---

## 4. 非功能需求

### 4.1 性能要求
- 页面加载时间 < 2秒
- 操作响应时间 < 200ms
- 支持同时20人以内流畅操作

### 4.2 安全要求
- 无需用户登录，匿名使用
- 数据存储在用户本地
- 防止数据被其他用户误操作（通过聚会隔离）

### 4.3 兼容性要求
- 支持微信iOS/Android小程序
- 适配主流手机屏幕尺寸（iPhone SE ~ iPhone 15 Pro Max）

### 4.4 数据存储

**本地存储结构**：
```json
{
  "partyId": "uuid",
  "createdAt": "2026-04-08T14:00:00Z",
  "settings": {
    "unit": "瓶",
    "unitToSip": 6
  },
  "players": [
    {
      "id": "p1",
      "name": "龙",
      "totalSips": 12,
      "records": [
        {"time": "14:05", "action": "+", "amount": 6, "unit": "口"},
        {"time": "14:10", "action": "+", "amount": 1, "unit": "口"}
      ]
    }
  ]
}
```

---

## 5. 界面设计

### 5.1 设计原则

**设计体系**：**TDesign 微信小程序设计体系**

**选择理由**：
- TDesign是腾讯官方设计体系，与微信小程序生态完美契合
- 提供完整的小程序组件库，开发效率高
- 设计规范成熟，用户体验一致性好
- 支持自定义主题，可适配酒局场景

**核心特征**：
- 遵循TDesign设计规范（间距、圆角、色彩）
- 使用TDesign小程序组件库
- 保持微信原生体验，降低用户学习成本
- 适度定制主题色，契合酒局氛围

### 5.2 色彩系统（TDesign主题定制）

**TDesign基础色板**：
| 颜色 | TDesign变量 | 色值 | 用途 |
|------|-------------|------|------|
| 主色 | `--td-primary-color` | `#F5A623` | 主按钮、强调色 |
| 主色点击 | `--td-primary-color-active` | `#E09612` | 按钮按下状态 |
| 主色禁用 | `--td-primary-color-disabled` | `#F5A62380` | 按钮禁用 |
| 错误色 | `--td-error-color` | `#E34D59` | 删除、警告 |
| 成功色 | `--td-success-color` | `#00A870` | 成功提示 |

**中性色（TDesign标准）**：
| 颜色 | TDesign变量 | 色值 | 用途 |
|------|-------------|------|------|
| 文字主色 | `--td-text-color-primary` | `#000000` | 主文字 |
| 文字次要 | `--td-text-color-secondary` | `#666666` | 次要文字 |
| 文字辅助 | `--td-text-color-auxiliary` | `#999999` | 辅助文字 |
| 背景 | `--td-bg-color` | `#F5F5F5` | 页面背景 |
| 卡片背景 | `--td-bg-color-secondary` | `#FFFFFF` | 卡片背景 |
| 边框 | `--td-border-color` | `#E5E5E5` | 分割线、边框 |

**背景**：
- 主背景：`--td-bg-color` #F5F5F5（TDesign标准灰色背景）
- 卡片背景：`--td-bg-color-secondary` #FFFFFF

### 5.3 字体规范（TDesign标准）

| 层级 | TDesign变量 | 字号 | 字重 | 用途 |
|------|-------------|------|------|------|
| 大标题 | `--td-font-size-title-l` | 20px | 600 | 页面大标题 |
| 标题 | `--td-font-size-title` | 18px | 600 | 模块标题 |
| 正文 | `--td-font-size-text` | 16px | 400 | 人员姓名、按钮文字 |
| 辅助文字 | `--td-font-size-text-s` | 14px | 400 | 说明文字、时间戳 |
| 数据展示 | 28px | 700 | - | 酒量数字显示（自定义） |

**字体**：系统默认（iOS: PingFang SC, Android: Noto Sans CJK）

**行高**：TDesign标准行高 `1.5`

### 5.4 TDesign组件使用规范

#### 5.4.1 人员卡片（使用 t-cell + 自定义样式）

```
组件：t-cell（单元格）
自定义样式：
├── 背景：--td-bg-color-secondary #FFFFFF
├── 圆角：--td-radius-large 12px
├── 外边距：--td-spacer 16px
├── 内边距：--td-spacer-2 24px
├── 阴影：TDesign标准卡片阴影
├── 左侧：t-avatar（头像）40px
├── 中间：t-cell__title（姓名）16px
└── 右侧：t-cell__note（操作图标）

状态：
├── 默认：标准卡片样式
├── 选中：主色边框 --td-primary-color
└── 长按：背景色变化 --td-bg-color
```

#### 5.4.2 单位标签（使用 t-tabs 或自定义 segmented）

```
组件：t-tabs（标签页）或自定义 t-segmented
样式：
├── 容器：
│   ├── 背景：--td-bg-color #F5F5F5
│   └── 圆角：--td-radius-default 8px
├── 标签项：
│   ├── 默认：--td-text-color-secondary
│   ├── 选中：
│   │   ├── 背景：--td-bg-color-secondary #FFFFFF
│   │   ├── 文字：--td-primary-color #F5A623
│   │   └── 圆角：--td-radius-default 8px
│   └── 尺寸：等分，高度 44px（TDesign标准）
└── 切换动画：t-tabs默认滑动动画
```

#### 5.4.3 主按钮（使用 t-button）

```
组件：t-button（按钮）
属性：
├── theme="primary"
├── size="large"
├── block（块级按钮）
├── shape="round"（全圆角）

样式定制：
├── 背景：--td-primary-color #F5A623（覆盖主题色）
├── 文字：--td-text-color-anti #FFFFFF
├── 高度：56px（TDesign large标准）
├── 圆角：--td-radius-round 999px
└── 图标：t-icon（酒杯图标）

状态：
├── 默认：标准主按钮
├── hover：--td-primary-color-active #E09612
└── disabled：--td-primary-color-disabled
```

#### 5.4.4 操作按钮组（使用 t-grid + t-button）

```
组件：t-grid（宫格）+ t-button
布局：
├── t-grid
│   ├── column-num="3"（3列）
│   ├── gutter="16"（间距）
│   └── border={false}
├── t-grid-item（宫格项）
│   ├── 加操作：t-button theme="primary" size="small"
│   ├── 减操作：t-button theme="danger" size="small" variant="outline"
│   └── 尺寸：自适应宫格

容器样式：
├── 背景：--td-bg-color-secondary #FFFFFF
├── 圆角：--td-radius-large 12px
└── 阴影：TDesign标准阴影
```

#### 5.4.5 排行榜（使用 t-popup + t-cell）

```
组件：t-popup（弹出层）+ t-cell（列表）
属性：
├── t-popup
│   ├── placement="bottom"
│   ├── show-overlay={true}
│   └── close-on-overlay-click={true}

样式：
├── 容器：
│   ├── 背景：--td-bg-color-secondary #FFFFFF
│   ├── 圆角：顶部 --td-radius-large 12px
│   └── 高度：屏幕高度的60%
├── 拖动指示器：
│   ├── 使用 t-divider 或自定义
│   └── 样式：--td-border-color #E5E5E5
├── 排名项：
│   ├── 组件：t-cell
│   ├── 左侧：t-avatar（奖牌图标）
│   ├── 中间：t-cell__title + t-cell__description
│   └── 右侧：t-cell__note（换算数量，主色）
└── 动画：t-popup默认滑入动画
```

#### 5.4.6 其他TDesign组件

| 功能 | 组件 | 说明 |
|------|------|------|
| 输入框 | t-input | 添加人员姓名输入 |
| 步进器 | t-stepper | 口数设置 +/- |
| 标签 | t-tag | 人数统计标签 |
| 轻提示 | t-toast | 操作反馈提示 |
| 对话框 | t-dialog | 删除确认、结束聚会确认 |
| 空状态 | t-empty | 无人员时的空页面 |
| 加载 | t-loading | 数据加载状态 |
| 图标 | t-icon | 使用TDesign图标库 |

### 5.5 页面结构

#### 5.5.1 首页

```
页面布局：
├── 背景：--td-bg-color #F5F5F5
├── 顶部区域（padding-top: 60px）
│   ├── 标题："酒局记账"（--td-font-size-title-l, --td-text-color-primary）
│   └── 副标题："记录每一次欢聚"（--td-font-size-text-s, --td-text-color-secondary）
├── 人员编辑区（margin-top: 32px）
│   ├── 标题行：
│   │   ├── "参与人员"（--td-font-size-title, --td-text-color-primary）
│   │   └── 计数标签：t-tag "3/20"（--td-primary-color）
│   ├── 人员列表（横向滚动）
│   │   ├── 人员卡片：t-cell 自定义样式
│   │   │   ├── 头像：t-avatar 40px
│   │   │   ├── 姓名：t-cell__title
│   │   │   └── 删除按钮：t-icon delete
│   │   └── 添加按钮：
│   │       ├── 样式：虚线边框 + t-icon add
│   │       └── 尺寸：同人员卡片
│   └── 提示文字："左滑删除，点击编辑"（--td-font-size-text-s, --td-text-color-auxiliary）
├── 设置区（margin-top: 40px）
│   ├── 标题："计量单位"（--td-font-size-title）
│   ├── 单位标签组：t-tabs 或自定义 segmented
│   │   ├── [杯] [瓶] [罐]
│   │   └── 默认选中"瓶"
│   └── 口数设置：
│       ├── 标签："1瓶 = "
│       ├── 数字输入：t-stepper
│       └── 单位："口"
└── 底部区域（fixed bottom, padding: 24px）
    └── 主按钮：t-button
        ├── theme="primary"
        ├── size="large"
        ├── block
        ├── icon="wine"
        └── 文字："开始聚会"
```

#### 5.5.2 记账页

```
页面布局：
├── 背景：--td-bg-color #F5F5F5
├── 顶部导航栏（fixed top）：t-navbar
│   ├── 左侧：返回按钮 t-icon chevron-left
│   ├── 中间："酒局记账"（--td-font-size-title）
│   └── 右侧：排行榜按钮 t-icon trophy
├── 人员列表区（padding-top: 80px）
│   ├── 人员卡片：t-cell（垂直列表）
│   │   ├── 布局：flex，垂直居中
│   │   ├── 左侧：
│   │   │   ├── 排名序号：t-tag（圆形，--td-primary-color）
│   │   │   └── 头像：t-avatar 48px
│   │   ├── 中间：
│   │   │   ├── 姓名：t-cell__title（--td-font-size-title）
│   │   │   └── 口数：t-cell__description（--td-font-size-text-s）
│   │   ├── 右侧：
│   │   │   ├── 换算数量：28px, --td-primary-color, 700
│   │   │   └── 单位：--td-font-size-text-s
│   │   └── 展开指示器：t-icon chevron-down
│   └── 操作面板（展开状态）：t-grid
│       ├── 容器：t-grid 3列
│       ├── 按钮网格：
│       │   ├── t-button theme="primary" size="small" [+1口]
│       │   ├── t-button theme="primary" size="small" [+一瓶]
│       │   ├── t-button theme="danger" variant="outline" size="small" [-1口]
│       │   └── t-button theme="danger" variant="outline" size="small" [-一瓶]
│       └── 快捷操作：
│           └── t-button theme="primary" variant="light" [全部喝完]
├── 底部操作栏（fixed bottom）：t-tab-bar 或自定义
│   ├── 背景：--td-bg-color-secondary
│   ├── 左侧：多选按钮 t-icon checkbox + "多选"
│   └── 右侧：设置按钮 t-icon setting
└── 排行榜（Bottom Sheet）：t-popup
    ├── 拖动指示器：t-divider
    ├── 标题："排行榜" + t-icon close
    ├── 排名列表（按酒量降序）：t-cell-group
    │   ├── t-cell
    │   │   ├── 左侧：t-avatar（奖牌图标 🥇🥈🥉）
    │   │   ├── 中间：t-cell__title + t-cell__description
    │   │   └── 右侧：t-cell__note（换算数量，--td-primary-color）
    │   └── 记录流水：t-cell__description
    └── 底部：t-button [结束聚会]

多选模式：
├── 人员卡片显示复选框：t-checkbox（左侧）
├── 底部操作栏变化：
│   ├── 左侧：t-button [全选] [取消]
│   └── 右侧：t-button theme="primary" [批量操作]
└── 选中人员高亮显示：--td-primary-color 边框
```

### 5.6 动效规范（TDesign标准）

| 场景 | 动画 | 时长 | 说明 |
|------|------|------|------|
| 页面进入 | 淡入 | 300ms | TDesign标准页面切换 |
| 人员卡片添加 | 弹入 | 300ms | t-cell默认动画 |
| 人员卡片删除 | 滑出 | 300ms | 左滑删除动画 |
| 操作面板展开 | 高度展开 | 300ms | t-collapse默认动画 |
| 按钮按下 | 背景色变 | 100ms | t-button默认反馈 |
| 排行榜展开 | 底部滑入 | 300ms | t-popup默认动画 |
| Toast提示 | 淡入淡出 | 2000ms | t-toast默认动画 |
| 标签切换 | 滑块移动 | 300ms | t-tabs默认动画 |

### 5.7 图标系统

**使用图标库**：TDesign Icons（tdesign-icons-miniprogram）

| 图标 | TDesign名称 | 用途 | 尺寸 |
|------|-------------|------|------|
| 酒杯 | wine | 主按钮、启动图标 | 24px |
| 加号 | add | 添加人员 | 20px |
| 删除 | delete | 删除人员 | 20px |
| 返回 | chevron-left | 返回上一页 | 24px |
| 奖杯 | trophy | 排行榜 | 20px |
| 设置 | setting | 设置入口 | 20px |
| 勾选 | check | 多选选中 | 20px |
| 向下 | chevron-down | 展开指示器 | 20px |
| 向上 | chevron-up | 收起指示器 | 20px |
| 关闭 | close | 关闭弹窗 | 20px |

### 5.8 适配规范

**屏幕适配（TDesign标准）**：
| 设备 | 适配策略 |
|------|----------|
| iPhone SE | 使用TDesign响应式间距，人员卡片横向滚动 |
| iPhone 标准 | 标准布局，--td-spacer 16px |
| iPhone Pro Max | 增大间距，--td-spacer-2 24px |
| Android 全面屏 | 底部安全区适配，使用 safe-area-inset-bottom |

**TDesign间距系统**：
| 变量 | 值 | 用途 |
|------|-----|------|
| --td-spacer | 16px | 标准间距 |
| --td-spacer-1 | 8px | 小间距 |
| --td-spacer-2 | 24px | 大间距 |
| --td-spacer-3 | 32px | 超大间距 |

### 5.9 TDesign组件安装

```bash
# 通过 npm 安装
npm i tdesign-miniprogram

# 在 app.json 中引入
{
  "usingComponents": {
    "t-button": "tdesign-miniprogram/button/button",
    "t-cell": "tdesign-miniprogram/cell/cell",
    "t-input": "tdesign-miniprogram/input/input",
    "t-stepper": "tdesign-miniprogram/stepper/stepper",
    "t-tabs": "tdesign-miniprogram/tabs/tabs",
    "t-popup": "tdesign-miniprogram/popup/popup",
    "t-toast": "tdesign-miniprogram/toast/toast",
    "t-dialog": "tdesign-miniprogram/dialog/dialog",
    "t-tag": "tdesign-miniprogram/tag/tag",
    "t-avatar": "tdesign-miniprogram/avatar/avatar",
    "t-grid": "tdesign-miniprogram/grid/grid",
    "t-icon": "tdesign-miniprogram/icon/icon",
    "t-empty": "tdesign-miniprogram/empty/empty",
    "t-loading": "tdesign-miniprogram/loading/loading",
    "t-checkbox": "tdesign-miniprogram/checkbox/checkbox",
    "t-divider": "tdesign-miniprogram/divider/divider",
    "t-navbar": "tdesign-miniprogram/navbar/navbar"
  }
}
```

### 5.10 主题定制配置

```javascript
// theme.json
{
  "primary": "#F5A623",
  "primaryActive": "#E09612",
  "primaryDisabled": "#F5A62380",
  "error": "#E34D59",
  "success": "#00A870",
  "warning": "#ED7B2F",
  "background": "#F5F5F5",
  "backgroundSecondary": "#FFFFFF",
  "textPrimary": "#000000",
  "textSecondary": "#666666",
  "textAuxiliary": "#999999",
  "border": "#E5E5E5"
}
```