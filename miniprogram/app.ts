import { ensureCloudLogin } from './services/auth'
import { finishPartyInCloud } from './services/party-cloud'
import { reportLandingEntry } from './services/growth-analytics'
import {
  clearPendingEndedParty,
  loadParty,
  loadPendingEndedParty,
  saveParty,
  savePendingEndedParty,
} from './utils/storage'

function finishEndedPartyInCloud(party: IPartyData): void {
  finishPartyInCloud(party)
    .then(() => {
      clearPendingEndedParty(party.partyId, party.endedAt || party.updatedAt || '')
    })
    .catch(err => {
      console.warn('[app lifecycle finish party] pending retry', err)
    })
}

App<IAppOption>({
  onLaunch(options) {
    this.globalData.partyEndingByLifecycle = false
    reportLandingEntry(options)

    /**
     * 冷启动强制调用一次 login，避免历史缓存掩盖环境授权、集合被重建或
     * 云函数重新部署后的真实状态。页面内后续请求仍可复用本次登录结果。
     */
    ensureCloudLogin(true).catch(err => {
      console.error('[cloud login] fallback to local mode', err)
    })

    const pendingEndedParty = loadPendingEndedParty()
    if (pendingEndedParty?.partyId) {
      finishEndedPartyInCloud(pendingEndedParty)
    }
  },

  onHide() {
    const party = loadParty()
    if (!party || party.endedAt || !Array.isArray(party.players) || party.players.length === 0) {
      return
    }

    /**
     * 产品口径：用户直接退出、切后台或杀掉小程序，即视为本场聚会结束。
     * 这里先同步写入本地待上传记录并清掉当前聚会，避免下次启动继续累加时长；
     * 云函数调用若来不及完成，会在下一次 onLaunch 继续补偿。
     */
    const endedAt = new Date().toISOString()
    const endedParty: IPartyData = {
      ...party,
      updatedAt: endedAt,
      endedAt,
    }
    this.globalData.partyEndingByLifecycle = true
    savePendingEndedParty(endedParty)
    saveParty(endedParty)
    finishEndedPartyInCloud(endedParty)
  },

  onShow(options) {
    this.globalData.partyEndingByLifecycle = false
    reportLandingEntry(options)
  },

  globalData: {},
})
