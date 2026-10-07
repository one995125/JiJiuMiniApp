# 云开发接入说明

## 当前共享环境

本项目不需要新建云环境，当前配置使用另一个小程序共享的云开发资源：

- 当前小程序 AppID：`wx321ca81987b40070`
- 资源方 AppID：`wx754380008b8e5ace`
- 共享环境 ID：`cloud1-d4gfatip0edd01506`

前端通过 `wx.cloud.Cloud` 创建共享环境实例，登录和酒局记录云函数均通过该实例调用。资源方需要在云环境共享设置中持续授权当前小程序 AppID。

## 集合

需要在共享云环境中创建两个集合：

- `ji_jiu_users`：静默登录用户记录，文档 `_id` 为 `appid + openid` 生成的固定 32 位哈希。
- `ji_jiu_parties`：酒局记录，文档 `_id` 为 `partyId`。

建议权限：前端不可直接读写，所有操作通过云函数完成。云函数会使用 `openid` 做数据隔离。

`ji_jiu_parties` 建议创建两个复合索引：

- `ownerOpenid` 升序、`ownerAppid` 升序、`status` 升序、`updatedAt` 降序。
- `ownerOpenid` 升序、`ownerAppid` 升序、`status` 升序、`endedAt` 降序、`partyId` 降序。

历史酒局接口已经使用云函数游标分页：前端首次传空 `cursor`，云函数返回 `nextCursor` 和 `hasMore`，继续加载时把 `nextCursor` 原样传回。单页最多读取 50 条，历史页默认每页 10 条；不要在小程序端用递增 `limit` 重复拉取全部历史。

如果云开发控制台里已经存在旧的 `endedAt` 索引但缺少 `partyId`，需要新增或重建为上面的完整索引。`partyId` 用于同一毫秒结束的酒局做稳定排序，避免分页时重复或漏读。

## 云函数

需要上传并部署：

- `cloudfunctions/cloudbase_auth`
- `cloudfunctions/jijiuLogin`
- `cloudfunctions/jijiuPartyRecord`

`cloudbase_auth` 是共享环境初始化的前置鉴权函数，当前仅允许调用方 AppID `wx321ca81987b40070`。如果以后还要把同一环境共享给其他小程序，需要同步维护该函数的白名单。

`jijiuPartyRecord` 支持：

- `upsertActive`：保存当前未结束酒局。
- `getActive`：读取当前用户最近一条未结束酒局。
- `finish`：保存并标记为已结束。
- `discardActive`：丢弃当前未结束酒局。
- `deleteRecord`：按 `partyId` 删除当前用户自己的云端酒局记录，历史页长按删除使用。
- `listEnded`：分页读取历史已结束酒局，入参 `limit`、`cursor`，返回 `records`、`nextCursor`、`hasMore`。

## 环境 ID

共享环境配置位于：

```ts
// miniprogram/config/cloud.ts
export const CLOUD_RESOURCE_APPID = 'wx754380008b8e5ace'
export const CLOUD_RESOURCE_ENV = 'cloud1-d4gfatip0edd01506'
```

只有未来改为当前小程序自有云环境时，才需要清空以上两项并填写 `CLOUD_ENV_ID`。

## 部署步骤

1. 在微信开发者工具的云开发控制台选择 `cloud1-d4gfatip0edd01506`。
2. 确认共享设置已授权使用方 AppID `wx321ca81987b40070`。
3. 先右键 `cloudfunctions/cloudbase_auth`，选择“上传并部署：云端安装依赖”。
4. 右键 `cloudfunctions/jijiuLogin`，选择“上传并部署：云端安装依赖”。
5. 右键 `cloudfunctions/jijiuPartyRecord`，选择“上传并部署：云端安装依赖”。
6. 创建 `ji_jiu_users` 和 `ji_jiu_parties` 集合，并设置为仅云函数可读写。
7. 为 `ji_jiu_parties` 创建或更新复合索引：活跃酒局索引为 `ownerOpenid ASC + ownerAppid ASC + status ASC + updatedAt DESC`，已结束酒局分页索引为 `ownerOpenid ASC + ownerAppid ASC + status ASC + endedAt DESC + partyId DESC`。
8. 重新编译小程序，检查控制台没有“环境未授权”“云函数不存在”或“数据库索引缺失”错误。

本次历史分页依赖新版 `jijiuPartyRecord` 云函数返回 `nextCursor`。上线时需要先部署云函数和索引，再发布小程序端代码；否则旧云函数不会识别游标字段，历史页只能读取第一页。

共享环境内已有的 `sixiangLogin` 属于其他项目，不能替代本项目的 `jijiuLogin` 云函数。旧的 `login/partyRecord` 不再被本项目调用，确认新函数运行正常后可以删除。

## 隐私与数据

当前只保存调用方 `openid/appid`、酒局人员昵称、计数记录和聚会统计，不读取微信头像昵称。共享环境下云函数优先读取 `FROM_OPENID/FROM_APPID`，并以两者共同隔离酒局数据。总览中用户上传的本地头像路径不会上传云端，跨设备恢复时会回退为文字头像。

上线前应在小程序隐私保护指引中如实声明酒局昵称和记录的收集用途、保存范围与删除方式，不得把 `openid` 暴露给其他用户或写入前端日志。

## 官方参考

- [微信云开发环境共享使用指南](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/resource-sharing/guidance.html)
- [CloudBase 小程序跨环境访问示例](https://docs.cloudbase.net/run/develop/access/mini)
