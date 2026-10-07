# TDesign 微信小程序启动脚手架

这是一个基于 [TDesign 微信小程序组件库](https://tdesign.tencent.com/miniprogram/overview) 的快速启动脚手架项目，帮助开发者快速构建美观、易用的微信小程序。

## 项目特性

- 🎨 **TDesign UI 组件库** - 集成腾讯 TDesign 设计语言的完整组件库
- 📱 **微信小程序** - 基于微信小程序原生框架开发
- 🔧 **TypeScript 支持** - 完整的 TypeScript 类型定义
- 🎯 **Less 预处理器** - 支持 Less 样式预处理
- ⚡ **开箱即用** - 预配置开发环境，快速开始项目开发
- 🏗️ **现代化构建** - 支持 npm 包管理和模块化开发

## 技术栈

- **框架**: 微信小程序原生框架
- **UI 组件库**: TDesign Miniprogram v1.10.1+
- **语言**: TypeScript
- **样式**: Less
- **包管理**: pnpm
- **渲染引擎**: Skyline 渲染引擎

## 增长运营资料

- `docs/growth-operations.md`：12 周视频号发布节奏、前 4 周成片脚本和复盘规则。
- `docs/growth-analytics.md`：视频号来源参数、五个自定义分析事件和后台漏斗配置。
- `docs/growth-weekly-tracker.csv`：前 4 周内容编号与每周数据记录底表。

## 快速开始

### 环境要求

- Node.js 14.0+
- pnpm 包管理器
- 微信开发者工具

### 安装步骤

1. **克隆项目**
   ```bash
   git clone <repository-url>
   cd minapp-tdesign-starter
   ```

2. **安装依赖**
   ```bash
   pnpm install
   ```

3. **配置 AppID**
   
   打开 `project.config.json` 文件，将 `appid` 字段修改为你的微信小程序 AppID：
   ```json
   {
     "appid": "your-miniprogram-appid"
   }
   ```

4. **构建 npm 包**
   
   在微信开发者工具中：
   - 点击菜单栏【工具】
   - 选择【构建 npm】
   - 等待构建完成

5. **启动开发**
   
   使用微信开发者工具打开项目根目录，即可开始开发。

## 项目结构

```
miniprogram/
├── app.json          # 小程序配置文件
├── app.ts            # 小程序入口文件
├── app.less          # 全局样式
├── components/       # 自定义组件
├── pages/           # 页面文件
│   ├── index/       # 首页
│   └── logs/        # 日志页
├── utils/           # 工具函数
└── miniprogram_npm/ # npm 包构建目录
    └── tdesign-miniprogram/ # TDesign 组件库
```

## 使用示例

### 基础组件使用

```xml
<!-- 在 wxml 文件中使用 TDesign 组件 -->
<t-button theme="primary">主要按钮</t-button>
<t-button theme="default">次要按钮</t-button>
<t-input placeholder="请输入内容" />
```

### 在页面中引入组件

```json
{
  "usingComponents": {
    "t-button": "tdesign-miniprogram/button/button",
    "t-input": "tdesign-miniprogram/input/input"
  }
}
```

## 可用组件

TDesign 微信小程序组件库提供了丰富的 UI 组件，包括但不限于：

- **基础组件**: Button、Icon、Image、Cell 等
- **导航组件**: Navbar、TabBar、Steps 等  
- **输入组件**: Input、Textarea、Picker、Switch 等
- **展示组件**: Avatar、Badge、Tag、Progress 等
- **反馈组件**: Dialog、Toast、Message、Loading 等
- **布局组件**: Grid、Row、Col、Divider 等

详细组件文档请参考：[TDesign 微信小程序组件库文档](https://tdesign.tencent.com/miniprogram/components/button)

## 开发配置

### TypeScript 配置

项目已预配置 TypeScript，类型定义文件位于 `typings/` 目录。

### Less 样式

支持 Less 预处理器，可以使用变量、嵌套、混合等高级特性。

### Skyline 渲染

项目启用了 Skyline 渲染引擎，提供更好的性能和用户体验。

## 构建和发布

1. **开发调试**
   在微信开发者工具中预览和调试

2. **版本发布**
   在微信开发者工具中点击【上传】按钮上传代码

3. **体验版本**
   上传后可生成体验版供测试使用

## 贡献指南

欢迎提交 Issue 和 Pull Request 来改进这个脚手架项目。

## 许可证

[MIT License](LICENSE)

## 相关链接

- [TDesign 官网](https://tdesign.tencent.com/)
- [TDesign 微信小程序组件库](https://tdesign.tencent.com/miniprogram/overview)
- [微信小程序官方文档](https://developers.weixin.qq.com/miniprogram/dev/framework/)
- [TypeScript 官网](https://www.typescriptlang.org/)
