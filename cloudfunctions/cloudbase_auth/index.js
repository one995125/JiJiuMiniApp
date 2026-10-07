const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

/**
 * 允许访问共享环境的消费方小程序。
 *
 * 环境共享控制台仍是第一层授权；这里再校验来源 AppID，避免该环境未来共享
 * 给其他项目后，对方意外获得本项目云函数与数据访问能力。
 */
const ALLOWED_SOURCE_APPIDS = new Set([
  'wx321ca81987b40070',
])

exports.main = async () => {
  const wxContext = cloud.getWXContext()
  const sourceAppid = wxContext.FROM_APPID || wxContext.APPID || ''

  if (!ALLOWED_SOURCE_APPIDS.has(sourceAppid)) {
    return {
      errCode: 403,
      errMsg: '当前小程序未获准访问该共享云环境',
    }
  }

  return {
    errCode: 0,
    errMsg: '',
    auth: JSON.stringify({
      project: 'ji_jiu',
      sourceAppid,
    }),
  }
}
