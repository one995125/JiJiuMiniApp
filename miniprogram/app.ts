import { ensureCloudLogin } from './services/auth'
import { finishPartyInCloud } from './services/party-cloud'
import { reportLandingEntry } from './services/growth-analytics'
import { pauseParty, resumePausedParty } from './utils/party-lifecycle'
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

/**
 * 恢复前台时结算暂停；只有累计暂停超过阈值才沿用原有结束与失败补偿链路。
 * 普通短暂停只更新本地 currentParty，不触发云端结束，也不清空当前聚会。
 */
function resumeOrAutoEndPausedParty(app: { globalData: IAppOption['globalData'] }): void {
  const party = loadParty()
  if (!party || party.endedAt || !party.pausedAt || !Array.isArray(party.players) || party.players.length === 0) {
    return
  }

  const result = resumePausedParty(party)
  if (!result.shouldAutoEnd) {
    saveParty(result.party)
    return
  }

  const endedAt = new Date().toISOString()
  const endedParty: IPartyData = {
    ...result.party,
    updatedAt: endedAt,
    endedAt,
  }
  app.globalData.partyEndingByLifecycle = true
  savePendingEndedParty(endedParty)
  saveParty(endedParty)
  finishEndedPartyInCloud(endedParty)
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
    resumeOrAutoEndPausedParty(this)
  },

  onHide() {
    const party = loadParty()
    if (!party || party.endedAt || !Array.isArray(party.players) || party.players.length === 0) {
      return
    }

    /**
     * 切后台只暂停：记录 pausedAt，不写 endedAt、不清空 currentParty、也不发起云端结束。
     * 再次回到前台时会结算真实暂停时长；只有累计暂停超过阈值才自动封存。
     */
    saveParty(pauseParty(party))
  },

  onShow(options) {
    this.globalData.partyEndingByLifecycle = false
    resumeOrAutoEndPausedParty(this)
    reportLandingEntry(options)
  },

  globalData: {},
})
