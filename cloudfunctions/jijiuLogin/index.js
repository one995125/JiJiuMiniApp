const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

const db = cloud.database()

function ok(data) {
  return { ok: true, data }
}

function fail(code, message, debug) {
  return { ok: false, code, message, debug }
}

function getErrorDetail(err) {
  if (!err) return '未知数据库错误'
  return String(err.errMsg || err.message || err.code || err)
}

/**
 * 获取实际调用方身份。
 *
 * 环境共享调用会把消费方身份放在 FROM_* 字段；资源方自身调用时才使用
 * 常规字段。始终优先 FROM_*，避免把资源方身份误当成当前小程序用户。
 */
function getCallerIdentity() {
  const wxContext = cloud.getWXContext()
  return {
    openid: wxContext.FROM_OPENID || wxContext.OPENID || '',
    appid: wxContext.FROM_APPID || wxContext.APPID || '',
    unionid: wxContext.FROM_UNIONID || wxContext.UNIONID || '',
  }
}

exports.main = async () => {
  const identity = getCallerIdentity()
  const { openid, appid, unionid } = identity
  if (!openid) {
    return fail(
      'NO_OPENID',
      '登录失败，未获取到 openid',
      '检查 cloudbase_auth、环境共享授权和 login 云函数是否都已部署。',
    )
  }

  try {
    /**
     * 文档 ID 同时包含调用方 AppID 和 openid，保证共享环境中不同小程序的
     * 用户记录互不覆盖。使用 doc(id).set() 时不能在 data 中重复写入保留
     * 字段 _id，文档数据库会自动使用这里传入的 userDocId。
     */
    const userDocId = crypto
      .createHash('sha256')
      .update(`${appid || 'unknown-app'}:${openid}`)
      .digest('hex')
      .slice(0, 32)
    await db.collection('ji_jiu_users').doc(userDocId).set({
      data: {
        openid,
        appid,
        unionid,
        lastLoginAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    })
  } catch (err) {
    console.error('[login] upsert user failed', err)
    return fail(
      'USER_UPSERT_FAILED',
      '登录信息保存失败',
      `${getErrorDetail(err)}；请确认 ji_jiu_users 集合位于当前共享环境。`,
    )
  }

  return ok({
    openid,
    appid,
    unionid,
  })
}
