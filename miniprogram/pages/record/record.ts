import {
  saveParty,
  savePartyAsync,
  loadParty,
  createDefaultParty,
  generateId,
  loadRecordStartupStorage,
  PartySetupData,
  savePartySetupAsync,
  saveDarkMode,
  restorePartySetupFromParty,
  normalizePartyUnit,
  normalizeStoredUnitToSip,
  hasLongSessionSharePrompted,
  markLongSessionSharePrompted,
  clearParty,
} from '../../utils/storage'
import { deferStatusBarHeightUpdate } from '../../utils/system'
import { SEO_COPY } from '../../utils/seo'
import {
  BADGE_DEFINITIONS,
  BadgeDefinition,
  BadgeId,
  buildPartyOverview,
} from '../../utils/party-overview'
import { generatePartyPoster } from '../../utils/party-poster'
import { PARTY_AUTO_END_PAUSE_THRESHOLD_MS } from '../../utils/party-lifecycle'
import {
  PartyMembersResult,
  SharedPartyMember,
  cancelOwnershipTransfer,
  createPartyInvite,
  getActivePartyFromCloud,
  initiateOwnershipTransfer,
  isPartyCloudError,
  listPartyMembers,
  removePartyMember,
  saveActivePartyToCloud,
  updateMemberClaim,
} from '../../services/party-cloud'
import {
  destroyInteractionSounds,
  playInteractionSound,
} from '../../services/interaction-sound'
import {
  buildGrowthSharePath,
  buildGrowthTimelineQuery,
  trackGrowthEvent,
} from '../../services/growth-analytics'

function rosterMatch(setupPs: Array<{ id: string }>, savedPs: IPlayer[] | undefined): boolean {
  if (!setupPs?.length || !savedPs?.length || setupPs.length !== savedPs.length) return false
  const set = new Set(setupPs.map(p => p.id))
  return savedPs.every(p => set.has(p.id))
}

type UndoListKind = 'add' | 'sub' | 'neutral'

type UndoRecordRef = {
  playerId: string
  recordId: string
  sipDelta: number
  consumedUnitsDelta: number
}

type UndoEntry = {
  snapshot: IPlayer[]
  /** 改计数前的设置快照，用于撤销时同步恢复口数换算。 */
  settingsSnapshot?: IPartySettings
  description: string
  undoListText?: string
  undoListKind?: UndoListKind
  /** 喝酒操作关联的具体记录。个人记录撤回后会同步从这里移除，避免重复撤销。 */
  recordRefs?: UndoRecordRef[]
}

type BadgeSnapshot = Record<string, BadgeId[]>

type TitleUnlockEvent = {
  playerId: string
  playerName: string
  badge: BadgeDefinition
}

type TitleUnlockNotice = {
  title: string
  badgeId: BadgeId | 'default'
  badgeName: string
  icon: string
  color: string
}

const LONG_SESSION_SHARE_PROMPT_MS = 45 * 60 * 1000

/**
 * 创建一条可精确撤回的喝酒记录。
 * consumedUnitsDelta 仅在点击“-1瓶/杯/罐”时为 1，普通加减口数均为 0。
 */
function createPlayerRecord(
  time: string,
  action: '+' | '-',
  amount: number,
  consumedUnitsDelta = 0,
): IPlayerRecord {
  return {
    id: generateId(),
    time,
    action,
    amount,
    unit: '口',
    sipDelta: action === '+' ? amount : -amount,
    consumedUnitsDelta,
  }
}

/**
 * 兼容旧酒局记录：
 * - 为缺少字段的旧记录补 ID 和口数变化；
 * - 根据玩家当前 consumedUnits，从最近的等单位减酒记录开始推断“-1单位”操作；
 * - 不重算玩家汇总值，避免迁移时改变用户现有战绩。
 */
function normalizePlayersForRecord(
  players: IPlayer[],
  unitToSip: number,
): { players: IPlayer[]; changed: boolean } {
  let changed = false
  const unitAmount = Math.max(Number(unitToSip) || 1, 1)
  const normalizedPlayers = (Array.isArray(players) ? players : []).map((player: IPlayer) => {
    const sourceRecords = Array.isArray(player.records) ? player.records : []
    const records = sourceRecords.map((source: IPlayerRecord) => {
      const raw = source as any
      const action: '+' | '-' = raw.action === '-' ? '-' : '+'
      const amount = Math.max(Number(raw.amount) || 0, 0)
      const hasSipDelta = Number.isFinite(Number(raw.sipDelta))
      const hasConsumedDelta = Number.isFinite(Number(raw.consumedUnitsDelta))
      const record: IPlayerRecord = {
        id: raw.id ? String(raw.id) : generateId(),
        time: String(raw.time || ''),
        action,
        amount,
        unit: String(raw.unit || '口'),
        sipDelta: hasSipDelta ? Number(raw.sipDelta) : (action === '+' ? amount : -amount),
        consumedUnitsDelta: hasConsumedDelta
          ? Math.max(0, Math.round(Number(raw.consumedUnitsDelta)))
          : -1,
      }
      if (
        !raw.id ||
        !hasSipDelta ||
        !hasConsumedDelta ||
        raw.action !== record.action ||
        Number(raw.amount) !== record.amount ||
        raw.unit !== record.unit
      ) {
        changed = true
      }
      return record
    })

    const knownConsumed = records.reduce(
      (sum: number, record: IPlayerRecord) =>
        sum + (record.consumedUnitsDelta >= 0 ? record.consumedUnitsDelta : 0),
      0,
    )
    let remainingConsumed = Math.max(
      Math.round(Number(player.consumedUnits) || 0) - knownConsumed,
      0,
    )

    for (let i = records.length - 1; i >= 0; i -= 1) {
      const record = records[i]
      if (record.consumedUnitsDelta >= 0) continue
      if (remainingConsumed > 0 && record.action === '-' && record.amount === unitAmount) {
        record.consumedUnitsDelta = 1
        remainingConsumed -= 1
      } else {
        record.consumedUnitsDelta = 0
      }
    }

    if (!Array.isArray(player.records)) changed = true
    return {
      ...player,
      records,
    }
  })

  return { players: normalizedPlayers, changed }
}

/** 旧撤销项无 undoListText 时，根据文案判断加 / 减 / 其它 */
function undoDescriptionKind(desc: string): UndoListKind {
  if (/^添加\s|^移除\s|^计数\s/.test(desc)) return 'neutral'
  if (/\s减\d/.test(desc) || /\s-\d/.test(desc)) return 'sub'
  if (/\s\+/.test(desc)) return 'add'
  return 'neutral'
}

/** 列表行：纯口数 ±N（如减 1 罐记为 -30） */
function sipDeltaUndoLine(label: string, delta: number): { undoListText: string; undoListKind: UndoListKind } {
  if (delta === 0) {
    return { undoListText: `${label} 0`, undoListKind: 'neutral' }
  }
  const sign = delta > 0 ? '+' : ''
  return {
    undoListText: `${label} ${sign}${delta}`,
    undoListKind: delta > 0 ? 'add' : 'sub',
  }
}

function mapStackToUndoDisplayList(stack: UndoEntry[]) {
  return stack
    .map((item: any, idx: number) => ({
      description: item.undoListText ?? item.description,
      originalIndex: idx,
      kind: (item.undoListKind as UndoListKind) ?? undoDescriptionKind(item.description),
    }))
    .reverse()
}

/** 从撤销栈中移除已在个人记录弹层撤回的记录，批量操作保留其他玩家对应部分。 */
function removeRecordFromUndoStack(
  stack: UndoEntry[],
  playerId: string,
  recordId: string,
): UndoEntry[] {
  return stack.reduce((result: UndoEntry[], entry: UndoEntry) => {
    if (!entry.recordRefs?.length) {
      result.push(entry)
      return result
    }
    const refs = entry.recordRefs.filter(
      ref => !(ref.playerId === playerId && ref.recordId === recordId),
    )
    if (refs.length === entry.recordRefs.length) {
      result.push(entry)
      return result
    }
    if (refs.length === 0) return result

    const description = entry.recordRefs.length > 1
      ? entry.description.replace(/^\d+人/, `${refs.length}人`)
      : entry.description
    const undoListText = entry.undoListText && entry.recordRefs.length > 1
      ? entry.undoListText.replace(/^\d+人/, `${refs.length}人`)
      : entry.undoListText
    result.push({
      ...entry,
      description,
      undoListText,
      recordRefs: refs,
    })
    return result
  }, [])
}

Component({
  data: {
    statusBarHeight: 20,
    players: [] as IPlayer[],
    displayPlayers: [] as any[],
    settings: { unit: '瓶', unitToSip: 30 } as IPartySettings,
    expandedId: '',
    batchMode: false,
    selectedIds: [] as string[],
    selectedCount: 0,
    undoStack: [] as UndoEntry[],
    startTime: 0,
    /** 已结算的后台暂停时长，用于总览与长时提醒扣除非活动时间。 */
    pausedDurationMs: 0,
    showRanking: false,
    /** 45 分钟战绩提醒：只做本场轻量引导，不锁定记账、不记录分享结果。 */
    longSessionShareVisible: false,
    longSessionSharePromptMilestone: 0,
    /** 总览：每人一行，按记酒折合（输）降序；右侧 shuHeLine */
    rankingTierGroups: [] as Array<{
      key: string
      drinks: number
      shuHeLine: string
      shuPart: string
      hePart: string
      qianPart: string
      players: any[]
    }>,
    /** 与总览同序：每人一行，分段 +N / -N 着色 */
    rankingRecordLines: [] as Array<{
      playerId: string
      playerName: string
      segments: Array<{ key: string; text: string; kind: 'add' | 'sub' }>
      badgeUnlucky?: boolean
      badgeSea?: boolean
      badgeDebt?: boolean
      badgeLucky?: boolean
      badgeOverspeed?: boolean
      /** 含勋章状态，避免 scroll-view list 复用导致下面列表不刷新 */
      recordLineKey?: string
    }>,
    durationText: '0分钟',
    darkMode: false,
    showPlayerDialog: false,
    newPlayerName: '',
    pendingAmount: 0,
    effectivePendingAmount: 0,
    /** 最后一次操作：先点后输以输入为准，先输后点以快捷为准 */
    lastSipSource: '' as '' | 'input' | 'buttons',
    batchPendingAmount: 0,
    batchCustomSipAmount: '',
    lastBatchSipSource: '' as '' | 'input' | 'buttons',
    effectiveBatchPendingAmount: 0,
    recordPopup: false,
    recordPopupPlayerId: '',
    recordPopupName: '',
    recordPopupList: [] as IPlayerRecord[],
    isDragging: false,
    dragIndex: -1,
    dragOverIndex: -1,
    showUnitDialog: false,
    newUnitToSip: '',
    customSipAmount: '',
    showUndoPopup: false,
    undoDisplayList: [] as Array<{ description: string; originalIndex: number; kind: UndoListKind }>,
    /** 玩家 id -> 本地保存的头像路径 */
    playerAvatarPhotos: {} as Record<string, string>,
    /** 总览顶部：养鱼达人（剩余口数最多；全场为 0 时退化为名单第一人，保证截图始终有头像 + 欠数） */
    debtChampionHero: null as null | {
      playerId: string
      name: string
      color: string
      photoPath: string
      debtUnits: string
    },
    /** 称号规则说明 popup 显隐，由总览页顶部 ❓ 按钮触发 */
    showMedalGuide: false,
    /** 最近一次生成的战绩图临时路径；记录变化后清空，避免分享旧战绩。 */
    posterTempFilePath: '',
    posterGenerating: false,
    /** 新称号轻提示：只作为记账后的非阻塞反馈，不参与记录保存。 */
    titleUnlockVisible: false,
    titleUnlockNotice: {
      title: '',
      badgeId: 'default',
      badgeName: '',
      icon: '奖',
      color: '#E9921B',
    } as TitleUnlockNotice,
    /**
     * 卡片快捷记酒的瞬时反馈。
     * 仅用于界面提示，不写入酒局记录；class 在 a/b 动画间切换，以便连续点击时重新播放。
     */
    quickFeedbackPlayerId: '',
    quickFeedbackText: '',
    quickFeedbackClass: '',
    /** 同桌共享管理仅对房主展示；成员端另走只读页。 */
    showInvitePanel: false,
    inviteCreating: false,
    inviteCode: '',
    inviteExpiresText: '',
    partyMemberRows: [] as Array<SharedPartyMember & {
      claimedName: string
      isOwner: boolean
    }>,
    membersLoading: false,
    pendingTransfer: null as PartyMembersResult['pendingTransfer'] | null,
    handoverCode: '',
    showMemberClaimPanel: false,
    correctingMemberId: '',
    correctingMemberName: '',
    memberClaimRows: [] as Array<{
      id: string
      name: string
      claimedByOther: boolean
      selected: boolean
    }>,
    memberClaimSelectedId: '',
    memberActionLoading: false,
  },

  pageLifetimes: {
    show() {
      wx.showShareMenu({
        menus: ['shareAppMessage', 'shareTimeline'],
      })
      const n = this.data.players?.length || 0
      const title = n > 0 ? `${n}人聚会进行中` : '聚会记账助手'
      wx.setNavigationBarTitle({ title })

      /** App.onShow 已完成 pausedAt 结算；页面恢复时同步累计暂停时长。 */
      const localParty = loadParty()
      const app = getApp<IAppOption>()
      if (app.globalData.partyEndingByLifecycle && localParty?.endedAt) {
        this.stopTimer()
        if ((this as any)._cloudSyncTimer) {
          clearTimeout((this as any)._cloudSyncTimer)
          ;(this as any)._cloudSyncTimer = null
        }
        const thresholdHours = PARTY_AUTO_END_PAUSE_THRESHOLD_MS / (60 * 60 * 1000)
        wx.showToast({
          title: `暂停已超过${thresholdHours}小时，本场已自动结束`,
          icon: 'none',
          duration: 2200,
        })
        wx.navigateBack({
          delta: 1,
          success: () => {
            app.globalData.partyEndingByLifecycle = false
          },
          fail: () => {
            wx.reLaunch({
              url: '/pages/index/index',
              complete: () => {
                app.globalData.partyEndingByLifecycle = false
              },
            })
          },
        })
        return
      }
      if (localParty && !localParty.endedAt && rosterMatch(this.data.players, localParty.players)) {
        this.setData({ pausedDurationMs: Math.max(Number(localParty.pausedDurationMs || 0), 0) })
        this.refreshPartyMembers({ silent: true })
      }
    },
  },

  lifetimes: {
    attached() {
      /** 状态栏高度延后校准，避免首屏渲染前调用同步系统信息 API。 */
      deferStatusBarHeightUpdate(this, 20)
      ;(this as any)._recordDetached = false
      this.initRecordState()
    },

    detached() {
      ;(this as any)._recordDetached = true
      this.stopTimer()
      if ((this as any)._cloudSyncTimer) {
        clearTimeout((this as any)._cloudSyncTimer)
        ;(this as any)._cloudSyncTimer = null
      }
      if ((this as any)._titleUnlockTimer) {
        clearTimeout((this as any)._titleUnlockTimer)
        ;(this as any)._titleUnlockTimer = null
      }
      if ((this as any)._quickFeedbackTimer) {
        clearTimeout((this as any)._quickFeedbackTimer)
        ;(this as any)._quickFeedbackTimer = null
      }
      this.stopHandoverPolling()
      ;(this as any)._titleUnlockEvents = []
      destroyInteractionSounds()
    },
  },

  methods: {
    /* ===== Display ===== */

    initRecordState() {
      loadRecordStartupStorage().then(storage => {
        if ((this as any)._recordDetached) return

        let setup: PartySetupData | null = storage.setup
        const saved = storage.party

        /**
         * 兜底：partySetup 被清掉但 currentParty 还在（例如冷启动后用户跳过首页直进）。
         * 用 saved 反向重建 setup，让用户的聚会不会因为入口路径不同而丢失。
         */
        if (!setup && saved && saved.players?.length) {
          setup = {
            players: saved.players.map((p: IPlayer) => ({ id: p.id, name: p.name })),
            unit: saved.settings.unit,
            unitToSip: saved.settings.unitToSip,
          }
          savePartySetupAsync(setup)
        }

      if (!setup) {
        this.tryLoadCloudActivePartyForRecord(storage.darkMode)
        return
      }

        if (saved && rosterMatch(setup.players, saved.players)) {
          const savedSettings = {
            unit: normalizePartyUnit(saved.settings?.unit),
            unitToSip: normalizeStoredUnitToSip(saved.settings?.unitToSip),
          }
          const normalized = normalizePlayersForRecord(saved.players, savedSettings.unitToSip)
          const normalizedParty = normalized.changed
            ? { ...saved, settings: savedSettings, players: normalized.players }
            : { ...saved, settings: savedSettings }
          this.setData({
            darkMode: storage.darkMode,
            players: normalizedParty.players,
            settings: normalizedParty.settings,
            startTime: normalizedParty.startTime || Date.now(),
            pausedDurationMs: Math.max(Number(normalizedParty.pausedDurationMs || 0), 0),
            playerAvatarPhotos: normalizedParty.playerAvatarPhotos || {},
          })
          if (normalized.changed) savePartyAsync(normalizedParty)
        } else {
          const party = createDefaultParty(
            setup.players.map((p: any) => ({
              id: p.id,
              name: p.name,
              totalSips: 0,
              consumedUnits: 0,
              records: [],
            })),
            {
              unit: normalizePartyUnit(setup.unit),
              unitToSip: normalizeStoredUnitToSip(setup.unitToSip),
            },
          )

          this.setData({
            darkMode: storage.darkMode,
            players: party.players,
            settings: party.settings,
            startTime: party.startTime || Date.now(),
            pausedDurationMs: 0,
            playerAvatarPhotos: {},
          })

          savePartyAsync(party)
        }
        this.updateDisplay()
        this.syncLongSessionSharePromptState()
        this.startTimer()
        this.maybeShowLongSessionSharePrompt()
        this.queueCloudSave(this.buildCurrentParty(), false)
      })
    },

    tryLoadCloudActivePartyForRecord(darkMode: boolean) {
      getActivePartyFromCloud()
        .then(record => {
          if ((this as any)._recordDetached) return
          const party = record?.party
          if (!party || !Array.isArray(party.players) || party.players.length === 0) {
            wx.showToast({ title: '请先设置聚会', icon: 'none' })
            setTimeout(() => wx.navigateBack(), 800)
            return
          }
          const cloudSettings = {
            unit: normalizePartyUnit(party.settings?.unit),
            unitToSip: normalizeStoredUnitToSip(party.settings?.unitToSip),
          }
          const normalized = normalizePlayersForRecord(party.players, cloudSettings.unitToSip)
          const normalizedParty = normalized.changed
            ? { ...party, settings: cloudSettings, players: normalized.players }
            : { ...party, settings: cloudSettings }
          savePartyAsync(normalizedParty)
          restorePartySetupFromParty(normalizedParty, { async: true })
          this.setData({
            darkMode,
            players: normalizedParty.players,
            settings: normalizedParty.settings,
            startTime: normalizedParty.startTime || Date.now(),
            pausedDurationMs: Math.max(Number(normalizedParty.pausedDurationMs || 0), 0),
            playerAvatarPhotos: normalizedParty.playerAvatarPhotos || {},
          })
          this.updateDisplay()
          this.syncLongSessionSharePromptState()
          this.startTimer()
          this.maybeShowLongSessionSharePrompt()
          if (normalized.changed) this.queueCloudSave(normalizedParty, false)
        })
        .catch(err => {
          console.error('[record cloud restore] failed', err)
          wx.showToast({ title: '请先设置聚会', icon: 'none' })
          setTimeout(() => wx.navigateBack(), 800)
        })
    },

    updateDisplay(options?: { includeRanking?: boolean }) {
      const { players, settings, selectedIds } = this.data
      /**
       * 首屏和日常点酒只需要刷新玩家卡片。
       * 总览数据会生成排行榜、记录分段和分享头像信息，放到打开总览时再算，减少首次渲染和高频操作的 setData 负担。
       */
      const shouldUpdateRanking = !!options?.includeRanking || this.data.showRanking
      const overview = buildPartyOverview({
        players,
        settings,
        selectedIds,
        includeRanking: shouldUpdateRanking,
        startTime: this.data.startTime,
        elapsedMs: this.getCurrentElapsedMs(),
        playerAvatarPhotos: this.data.playerAvatarPhotos || {},
      })
      if (!shouldUpdateRanking) {
        this.setData({ displayPlayers: overview.displayPlayers })
        return
      }

      this.setData({
        displayPlayers: overview.displayPlayers,
        rankingTierGroups: overview.rankingTierGroups,
        rankingRecordLines: overview.rankingRecordLines,
        durationText: overview.durationText,
        debtChampionHero: overview.debtChampionHero,
      })
    },

    /**
     * 采集当前玩家的真实称号快照。
     * 这里只读取 BADGE_DEFINITIONS 中的称号，NPC 不进入快照，避免无称号兜底态触发提醒。
     */
    captureBadgeSnapshot(players?: IPlayer[]): BadgeSnapshot {
      const overview = buildPartyOverview({
        players: players || this.data.players,
        settings: this.data.settings,
        includeRanking: false,
      })
      const snapshot: BadgeSnapshot = {}
      overview.displayPlayers.forEach((player: any) => {
        snapshot[player.id] = BADGE_DEFINITIONS
          .filter(def => !!player[def.flag])
          .map(def => def.id)
      })
      return snapshot
    },

    /**
     * 对比记账动作前后的称号差异，只返回“从无到有”的新增称号。
     * 撤回、排序、改计数等静默刷新场景不调用本方法，所以不会弹出庆祝反馈。
     */
    collectTitleUnlockEvents(before: BadgeSnapshot): TitleUnlockEvent[] {
      const overview = buildPartyOverview({
        players: this.data.players,
        settings: this.data.settings,
        includeRanking: false,
      })
      const events: TitleUnlockEvent[] = []
      overview.displayPlayers.forEach((player: any) => {
        const beforeIds = before[player.id] || []
        BADGE_DEFINITIONS.forEach(def => {
          if (player[def.flag] && beforeIds.indexOf(def.id) < 0) {
            events.push({
              playerId: player.id,
              playerName: player.name,
              badge: def,
            })
          }
        })
      })
      return events
    },

    /** 将同一时间窗内的称号变化折叠成一条轻提示，避免高频记账时连续打扰。 */
    buildTitleUnlockNotice(events: TitleUnlockEvent[]): TitleUnlockNotice {
      const sorted = events.slice().sort((a, b) => a.badge.priority - b.badge.priority)
      const first = sorted[0]
      const playerIds: string[] = []
      sorted.forEach(event => {
        if (playerIds.indexOf(event.playerId) < 0) playerIds.push(event.playerId)
      })

      if (playerIds.length > 1) {
        return {
          title: `${playerIds.length} 人获得新称号`,
          badgeId: first.badge.id,
          badgeName: sorted.length > 1 ? `${first.badge.name}等` : first.badge.name,
          icon: first.badge.icon,
          color: first.badge.color,
        }
      }

      const badges = sorted.map(event => event.badge)
      const title = badges.length === 1
        ? `${first.playerName}获得新称号`
        : `${first.playerName}获得 ${badges.length} 个新称号`
      return {
        title,
        badgeId: first.badge.id,
        badgeName: badges.length > 1 ? `${first.badge.name}等` : first.badge.name,
        icon: first.badge.icon,
        color: first.badge.color,
      }
    },

    showTitleUnlockIfNeeded(before: BadgeSnapshot): boolean {
      const events = this.collectTitleUnlockEvents(before)
      if (events.length === 0) return false

      const bucket = ((this as any)._titleUnlockEvents || []) as TitleUnlockEvent[]
      events.forEach(event => {
        const duplicated = bucket.some(
          item => item.playerId === event.playerId && item.badge.id === event.badge.id,
        )
        if (!duplicated) bucket.push(event)
      })
      ;(this as any)._titleUnlockEvents = bucket

      const notice = this.buildTitleUnlockNotice(bucket)
      if ((this as any)._titleUnlockTimer) {
        clearTimeout((this as any)._titleUnlockTimer)
        ;(this as any)._titleUnlockTimer = null
      }
      this.setData({
        titleUnlockVisible: true,
        titleUnlockNotice: notice,
      })
      playInteractionSound('success')
      ;(this as any)._titleUnlockTimer = setTimeout(() => {
        if ((this as any)._recordDetached) return
        ;(this as any)._titleUnlockEvents = []
        ;(this as any)._titleUnlockTimer = null
        this.setData({ titleUnlockVisible: false })
      }, 1600)
      return true
    },

    /* ===== Long Session Share Prompt ===== */

    /** 当前真实活动时长：总跨度扣除 App 生命周期已经结算的后台暂停时间。 */
    getCurrentElapsedMs(): number {
      const startTime = Number(this.data.startTime || 0)
      const pausedDurationMs = Math.max(Number(this.data.pausedDurationMs || 0), 0)
      return startTime ? Math.max(Date.now() - startTime - pausedDurationMs, 0) : 0
    },

    getLongSessionSharePromptKey(): string {
      const party = loadParty()
      if (party?.partyId) return `party:${party.partyId}`
      const startTime = Number(this.data.startTime || 0)
      const playerIds = (this.data.players || []).map((player: IPlayer) => player.id).join(',')
      return `local:${startTime}:${playerIds}`
    },

    syncLongSessionSharePromptState() {
      this.setData({
        longSessionSharePromptMilestone: 0,
        longSessionShareVisible: false,
      })
    },

    isLongSessionSharePromptBlocked(): boolean {
      const data = this.data
      return (
        data.batchMode ||
        data.showRanking ||
        data.showPlayerDialog ||
        data.showUnitDialog ||
        data.showUndoPopup ||
        data.recordPopup ||
        data.showMedalGuide ||
        data.isDragging
      )
    },

    maybeShowLongSessionSharePrompt(elapsed?: number) {
      const startTime = Number(this.data.startTime || 0)
      const duration = typeof elapsed === 'number' ? elapsed : this.getCurrentElapsedMs()
      const milestone = Math.floor(duration / LONG_SESSION_SHARE_PROMPT_MS)
      if (
        !startTime ||
        milestone < 1 ||
        this.data.longSessionSharePromptMilestone >= milestone ||
        this.isLongSessionSharePromptBlocked()
      ) {
        return
      }

      const partyKey = this.getLongSessionSharePromptKey()
      if (hasLongSessionSharePrompted(partyKey, milestone)) {
        this.setData({
          longSessionSharePromptMilestone: milestone,
          longSessionShareVisible: false,
        })
        return
      }

      markLongSessionSharePrompted(partyKey, milestone)
      this.setData({
        longSessionShareVisible: true,
        longSessionSharePromptMilestone: milestone,
      })
    },

    onLongSessionShareLater() {
      playInteractionSound('tap')
      this.setData({ longSessionShareVisible: false })
    },

    onLongSessionShareOverview() {
      playInteractionSound('tap')
      this.updateDisplay({ includeRanking: true })
      this.setData({
        longSessionShareVisible: false,
        showRanking: true,
      })
    },

    /* ===== Timer ===== */

    startTimer() {
      this.maybeShowLongSessionSharePrompt()
      ;(this as any)._timer = setInterval(() => {
        this.maybeShowLongSessionSharePrompt()
      }, 60 * 1000)
    },

    stopTimer() {
      if ((this as any)._timer) {
        clearInterval((this as any)._timer)
        ;(this as any)._timer = null
      }
    },

    /* ===== Navigation ===== */

    /**
     * 左上角返回：仅暂时离开，不清除记录。
     * 用户可在首页通过「上次聚会未结束」横幅一键继续。
     * 用户切后台时只暂停计时，返回后仍可继续；累计暂停超时才由 App 生命周期自动封存。
     */
    onBack() {
      playInteractionSound('tap')
      this.stopTimer()
      this.saveCurrentParty({ immediateCloud: true })
      wx.showToast({ title: '记录已保留，可在首页继续', icon: 'none', duration: 1600 })
      wx.navigateBack()
    },

    /* ===== Expand / Collapse ===== */

    onToggleExpand(e: WechatMiniprogram.TouchEvent) {
      const id = e.currentTarget.dataset.id
      playInteractionSound('tap')
      if (this.computeEffectivePending() !== 0 && this.data.expandedId && this.data.expandedId !== id) {
        this.commitPending(false)
      }
      this.setData({
        expandedId: this.data.expandedId === id ? '' : id,
        pendingAmount: 0,
        customSipAmount: '',
        effectivePendingAmount: 0,
        lastSipSource: '',
      })
    },

    onShowRecords(e: WechatMiniprogram.TouchEvent) {
      const id = e.currentTarget.dataset.id
      const player = this.data.players.find((p: IPlayer) => p.id === id)
      if (!player) return
      playInteractionSound('tap')
      this.setData({
        recordPopup: true,
        recordPopupPlayerId: player.id,
        recordPopupName: player.name,
        recordPopupList: player.records.slice().reverse(),
      })
    },

    onCloseRecordPopup() {
      playInteractionSound('tap')
      this.setData({
        recordPopup: false,
        recordPopupPlayerId: '',
        recordPopupName: '',
        recordPopupList: [],
      })
    },

    onRecordPopupChange(e: WechatMiniprogram.CustomEvent) {
      if (!e.detail.visible) {
        this.onCloseRecordPopup()
      }
    },

    /**
     * 个人记录撤回：
     * 直接删除原始记录并反向修正聚合值，不新增一条“反向记录”。
     * 同时清理关联撤销项，避免用户之后从顶部撤销入口再次反算同一条操作。
     */
    onRevertPlayerRecord(e: WechatMiniprogram.TouchEvent) {
      const playerId = this.data.recordPopupPlayerId
      const recordId = String(e.currentTarget.dataset.recordId || '')
      if (!playerId || !recordId) return
      playInteractionSound('tap')

      const playerIndex = this.data.players.findIndex((player: IPlayer) => player.id === playerId)
      if (playerIndex < 0) return
      const player = this.data.players[playerIndex]
      const recordIndex = player.records.findIndex((record: IPlayerRecord) => record.id === recordId)
      if (recordIndex < 0) {
        wx.showToast({ title: '记录已不存在', icon: 'none' })
        return
      }
      const record = player.records[recordIndex]
      const actionText = record.consumedUnitsDelta > 0
        ? `-${record.consumedUnitsDelta}${this.data.settings.unit}（${record.action}${record.amount}口）`
        : `${record.action}${record.amount}${record.unit}`

      wx.showModal({
        title: '撤回这条记录？',
        content: `确认撤回「${actionText}」吗？\n撤回后会重新计算总数、称号和排行。`,
        confirmText: '撤回',
        confirmColor: '#D94A52',
        success: result => {
          if (!result.confirm) return

          const players: IPlayer[] = JSON.parse(JSON.stringify(this.data.players))
          const currentPlayer = players[playerIndex]
          const currentRecordIndex = currentPlayer.records.findIndex(
            (item: IPlayerRecord) => item.id === recordId,
          )
          if (currentRecordIndex < 0) return
          const currentRecord = currentPlayer.records[currentRecordIndex]
          currentPlayer.totalSips -= currentRecord.sipDelta
          currentPlayer.consumedUnits = Math.max(
            0,
            (currentPlayer.consumedUnits || 0) - currentRecord.consumedUnitsDelta,
          )
          currentPlayer.records.splice(currentRecordIndex, 1)

          const undoStack = removeRecordFromUndoStack(
            this.data.undoStack,
            playerId,
            recordId,
          )
          const recordPopupList = currentPlayer.records.slice().reverse()
          this.setData({
            players,
            undoStack,
            undoDisplayList: mapStackToUndoDisplayList(undoStack),
            recordPopupList,
          })
          this.updateDisplay({ includeRanking: this.data.showRanking })
          this.saveCurrentParty()
          playInteractionSound('count')
          wx.vibrateShort({ type: 'light' })
          wx.showToast({ title: `已撤回 ${actionText}`, icon: 'none' })
        },
      })
    },

    /* ===== Drag Reorder ===== */

    onStartDrag(e: WechatMiniprogram.TouchEvent) {
      if (this.data.batchMode) return
      const id = e.currentTarget.dataset.id
      const index = this.data.players.findIndex((p: IPlayer) => p.id === id)
      if (index < 0) return

      wx.vibrateShort({ type: 'medium' })
      this.setData({
        isDragging: true,
        dragIndex: index,
        dragOverIndex: index,
        expandedId: '',
        pendingAmount: 0,
        customSipAmount: '',
        effectivePendingAmount: 0,
        lastSipSource: '',
      }, () => {
        this.createSelectorQuery()
          .selectAll('.player-card')
          .boundingClientRect()
          .exec((res: any) => {
            if (res[0]) {
              (this as any)._cardPositions = res[0].map((r: any) => ({
                top: r.top, height: r.height,
              }))
            }
          })
      })
    },

    onDragMove(e: WechatMiniprogram.TouchEvent) {
      if (!this.data.isDragging) return
      const touch = e.touches[0]
      const positions = (this as any)._cardPositions
      if (!positions || !positions.length) return

      let targetIndex = positions.length
      for (let i = 0; i < positions.length; i++) {
        const mid = positions[i].top + positions[i].height / 2
        if (touch.clientY < mid) {
          targetIndex = i
          break
        }
      }
      targetIndex = Math.max(0, Math.min(targetIndex, this.data.players.length))

      if (targetIndex !== this.data.dragOverIndex) {
        this.setData({ dragOverIndex: targetIndex })
      }
    },

    onDragEnd() {
      if (!this.data.isDragging) return

      const { dragIndex, dragOverIndex, players } = this.data
      if (dragIndex >= 0 && dragOverIndex >= 0 && dragOverIndex !== dragIndex && dragOverIndex !== dragIndex + 1) {
        const newPlayers = players.slice()
        const [moved] = newPlayers.splice(dragIndex, 1)
        const insertAt = dragOverIndex > dragIndex ? dragOverIndex - 1 : dragOverIndex
        newPlayers.splice(insertAt, 0, moved)

        this.setData({ players: newPlayers })
        this.saveCurrentParty()
        wx.vibrateShort({ type: 'light' })
      }

      this.setData({ isDragging: false, dragIndex: -1, dragOverIndex: -1 })
      this.updateDisplay()
    },

    /* ===== Core Operations ===== */

    getCurrentTime(): string {
      const d = new Date()
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
    },

    /**
     * 在对应人员卡片上短暂显示本次快捷操作。
     * @param playerId 被操作的玩家 id，用于把反馈固定在正确卡片上。
     * @param text 用户看到的单位文案，例如“+5口”“+1瓶”。
     * @param tone 加减色调；不参与任何业务数据计算。
     */
    showQuickFeedback(playerId: string, text: string, tone: 'add' | 'sub') {
      const host = this as any
      const sequence = Number(host._quickFeedbackSequence || 0) + 1
      host._quickFeedbackSequence = sequence

      if (host._quickFeedbackTimer) {
        clearTimeout(host._quickFeedbackTimer)
      }

      const animationClass = sequence % 2 === 0 ? 'quick-feedback-b' : 'quick-feedback-a'
      this.setData({
        quickFeedbackPlayerId: playerId,
        quickFeedbackText: text,
        quickFeedbackClass: `quick-feedback--${tone} ${animationClass}`,
      })

      host._quickFeedbackTimer = setTimeout(() => {
        if ((this as any)._recordDetached || host._quickFeedbackSequence !== sequence) return
        this.setData({
          quickFeedbackPlayerId: '',
          quickFeedbackText: '',
          quickFeedbackClass: '',
        })
        host._quickFeedbackTimer = null
      }, 800)
    },

    /** 卡片内 2×2 快捷按钮入口：直接携带玩家 id 记入，避免依赖展开状态。 */
    onQuickAdd(e: WechatMiniprogram.TouchEvent) {
      const playerId = String(e.currentTarget.dataset.id || '')
      const amount = Number(e.currentTarget.dataset.amount)
      if (!playerId || !Number.isFinite(amount) || amount <= 0) return
      this.addSipToPlayer(playerId, amount)
    },

    /** 拦截快捷按钮长按，避免按钮操作被父级识别为拖动排序。 */
    onQuickActionLongPress() {},

    addSipToPlayer(playerId: string, amount: number) {
      const idx = this.data.players.findIndex((p: IPlayer) => p.id === playerId)
      if (idx < 0) return
      const player = this.data.players[idx]
      const badgeSnapshot = this.captureBadgeSnapshot()

      const unitLabel = amount === this.data.settings.unitToSip
        ? `1${this.data.settings.unit}` : `${amount}口`

      const snapshot = JSON.parse(JSON.stringify(this.data.players))
      const stack = this.data.undoStack.slice()
      stack.push({
        snapshot,
        description: `${player.name} +${unitLabel}`,
        ...sipDeltaUndoLine(player.name, amount),
      })
      if (stack.length > 10) stack.shift()

      const newRecord = createPlayerRecord(this.getCurrentTime(), '+', amount)
      stack[stack.length - 1].recordRefs = [{
        playerId,
        recordId: newRecord.id,
        sipDelta: newRecord.sipDelta,
        consumedUnitsDelta: newRecord.consumedUnitsDelta,
      }]

      this.setData({
        [`players[${idx}].totalSips`]: player.totalSips + amount,
        [`players[${idx}].records`]: [...player.records, newRecord],
        undoStack: stack,
      })

      this.updateDisplay()
      this.showQuickFeedback(playerId, `+${unitLabel}`, 'add')
      const titleUnlocked = this.showTitleUnlockIfNeeded(badgeSnapshot)
      this.saveCurrentParty()
      trackGrowthEvent('penalty_added', { action_mode: 'quick_card', affected_count: 1 })
      if (!titleUnlocked) playInteractionSound('count')
      wx.vibrateShort({ type: 'heavy' })
    },

    subSipFromPlayer(playerId: string, amount: number) {
      const idx = this.data.players.findIndex((p: IPlayer) => p.id === playerId)
      if (idx < 0) return
      const player = this.data.players[idx]
      const badgeSnapshot = this.captureBadgeSnapshot()

      const unitLabel = amount === this.data.settings.unitToSip
        ? `1${this.data.settings.unit}` : `${amount}口`

      const snapshot = JSON.parse(JSON.stringify(this.data.players))
      const stack = this.data.undoStack.slice()
      stack.push({
        snapshot,
        description: `${player.name} -${unitLabel}`,
        ...sipDeltaUndoLine(player.name, -amount),
      })
      if (stack.length > 10) stack.shift()

      const newRecord = createPlayerRecord(this.getCurrentTime(), '-', amount)
      stack[stack.length - 1].recordRefs = [{
        playerId,
        recordId: newRecord.id,
        sipDelta: newRecord.sipDelta,
        consumedUnitsDelta: newRecord.consumedUnitsDelta,
      }]

      this.setData({
        [`players[${idx}].totalSips`]: player.totalSips - amount,
        [`players[${idx}].records`]: [...player.records, newRecord],
        undoStack: stack,
      })

      this.updateDisplay()
      const titleUnlocked = this.showTitleUnlockIfNeeded(badgeSnapshot)
      this.saveCurrentParty()
      trackGrowthEvent('penalty_reduced', { action_mode: 'single', affected_count: 1 })
      if (!titleUnlocked) playInteractionSound('count')
      wx.vibrateShort({ type: 'light' })
      if (!titleUnlocked && !this.data.titleUnlockVisible) {
        wx.showToast({ title: `${player.name} -${unitLabel}`, icon: 'none', duration: 1500 })
      }
    },

    onQuickSub(e: WechatMiniprogram.TouchEvent) {
      const id = e.currentTarget.dataset.id
      const { players, settings } = this.data
      const idx = players.findIndex((p: IPlayer) => p.id === id)
      if (idx < 0) return
      const player = players[idx]
      const badgeSnapshot = this.captureBadgeSnapshot()

      const snapshot = JSON.parse(JSON.stringify(players))
      const stack = this.data.undoStack.slice()
      stack.push({
        snapshot,
        description: `${player.name} 减1${settings.unit}`,
        ...sipDeltaUndoLine(player.name, -settings.unitToSip),
      })
      if (stack.length > 10) stack.shift()

      const newRecord = createPlayerRecord(
        this.getCurrentTime(),
        '-',
        settings.unitToSip,
        1,
      )
      stack[stack.length - 1].recordRefs = [{
        playerId: id,
        recordId: newRecord.id,
        sipDelta: newRecord.sipDelta,
        consumedUnitsDelta: newRecord.consumedUnitsDelta,
      }]

      this.setData({
        [`players[${idx}].consumedUnits`]: (player.consumedUnits || 0) + 1,
        [`players[${idx}].totalSips`]: player.totalSips - settings.unitToSip,
        [`players[${idx}].records`]: [...player.records, newRecord],
        undoStack: stack,
      })

      this.updateDisplay()
      this.showQuickFeedback(id, `-1${settings.unit}`, 'sub')
      const titleUnlocked = this.showTitleUnlockIfNeeded(badgeSnapshot)
      this.saveCurrentParty()
      trackGrowthEvent('penalty_reduced', { action_mode: 'quick_unit', affected_count: 1 })
      if (!titleUnlocked) playInteractionSound('count')
      wx.vibrateShort({ type: 'light' })
    },

    /**
     * 待确认口数：始终以「最后一次操作」为准。
     * - 最后点在快捷：只认本次从 0 开始累加的 pending（从输入切回快捷时会清零再累加）
     * - 最后在输入：只认输入框数字（空/非法为 0；从快捷切到输入时会清掉上次快捷累加）
     */
    computeEffectivePending(opts?: { pending?: number; custom?: string; source?: '' | 'input' | 'buttons' }) {
      const source = opts?.source ?? this.data.lastSipSource
      const pending = opts?.pending !== undefined ? opts.pending : this.data.pendingAmount
      const customStr = opts?.custom !== undefined ? opts.custom : this.data.customSipAmount

      if (source === 'input') {
        const raw = (customStr || '').trim()
        if (raw !== '') {
          const c = parseInt(raw, 10)
          if (!Number.isNaN(c)) return c
        }
        return 0
      }
      if (source === 'buttons') {
        return pending
      }
      return 0
    },

    onAddSip(e: WechatMiniprogram.TouchEvent) {
      const amount = Number(e.currentTarget.dataset.amount)
      playInteractionSound('tap')
      let pendingAmount = this.data.pendingAmount
      let customSipAmount = this.data.customSipAmount
      if (this.data.lastSipSource === 'input') {
        pendingAmount = 0
        customSipAmount = ''
      }
      pendingAmount += amount
      this.setData({
        lastSipSource: 'buttons',
        pendingAmount,
        customSipAmount,
        effectivePendingAmount: this.computeEffectivePending({
          pending: pendingAmount,
          source: 'buttons',
        }),
      })
    },

    onCustomSipInput(e: WechatMiniprogram.Input) {
      const customSipAmount = e.detail.value
      let pendingAmount = this.data.pendingAmount
      if (this.data.lastSipSource === 'buttons') {
        pendingAmount = 0
      }
      this.setData({
        lastSipSource: 'input',
        customSipAmount,
        pendingAmount,
        effectivePendingAmount: this.computeEffectivePending({
          custom: customSipAmount,
          source: 'input',
        }),
      })
    },

    commitPending(collapse = true) {
      const pendingAmount = this.computeEffectivePending()
      const { expandedId, players, settings } = this.data
      if (pendingAmount === 0 || !expandedId) return

      const idx = players.findIndex((p: IPlayer) => p.id === expandedId)
      if (idx < 0) return
      const player = players[idx]
      const badgeSnapshot = this.captureBadgeSnapshot()

      const absPending = Math.abs(pendingAmount)
      const action: '+' | '-' = pendingAmount > 0 ? '+' : '-'
      const unitLabel = absPending === settings.unitToSip
        ? `1${settings.unit}` : `${absPending}口`

      const snapshot = JSON.parse(JSON.stringify(players))
      const stack = this.data.undoStack.slice()
      stack.push({
        snapshot,
        description: `${player.name} ${action}${unitLabel}`,
        ...sipDeltaUndoLine(player.name, pendingAmount),
      })
      if (stack.length > 10) stack.shift()

      const newRecord = createPlayerRecord(this.getCurrentTime(), action, absPending)
      stack[stack.length - 1].recordRefs = [{
        playerId: expandedId,
        recordId: newRecord.id,
        sipDelta: newRecord.sipDelta,
        consumedUnitsDelta: newRecord.consumedUnitsDelta,
      }]

      const updates: Record<string, any> = {
        [`players[${idx}].totalSips`]: player.totalSips + pendingAmount,
        [`players[${idx}].records`]: [...player.records, newRecord],
        undoStack: stack,
        pendingAmount: 0,
        customSipAmount: '',
        effectivePendingAmount: 0,
        lastSipSource: '',
      }
      if (collapse) {
        updates.expandedId = ''
      }

      this.setData(updates)
      this.updateDisplay()
      const titleUnlocked = this.showTitleUnlockIfNeeded(badgeSnapshot)
      this.saveCurrentParty()
      trackGrowthEvent(action === '+' ? 'penalty_added' : 'penalty_reduced', {
        action_mode: 'custom',
        affected_count: 1,
      })
      if (!titleUnlocked) playInteractionSound('count')
      wx.vibrateShort({ type: 'heavy' })
      if (!titleUnlocked && !this.data.titleUnlockVisible) {
        wx.showToast({ title: `${player.name} ${action}${unitLabel}`, icon: 'none', duration: 1500 })
      }
    },

    onConfirmSip() {
      this.commitPending(true)
    },

    onCancelSip() {
      playInteractionSound('tap')
      this.setData({
        pendingAmount: 0,
        customSipAmount: '',
        effectivePendingAmount: 0,
        lastSipSource: '',
      })
    },

    /* ===== Undo ===== */

    onUndo() {
      playInteractionSound('tap')
      if (this.data.undoStack.length === 0) {
        wx.showToast({ title: '没有可撤销的操作', icon: 'none' })
        return
      }
      const undoDisplayList = mapStackToUndoDisplayList(this.data.undoStack)
      this.setData({ showUndoPopup: true, undoDisplayList })
    },

    onHideUndoPopup() {
      playInteractionSound('tap')
      this.setData({ showUndoPopup: false })
    },

    onUndoPopupChange(e: WechatMiniprogram.CustomEvent) {
      if (!e.detail.visible) {
        this.setData({ showUndoPopup: false })
      }
    },

    onUndoItem(e: WechatMiniprogram.TouchEvent) {
      const targetIdx = Number(e.currentTarget.dataset.index)
      const stack = this.data.undoStack.slice()
      const item = stack[targetIdx]
      if (!item) return

      const currentPlayers: IPlayer[] = JSON.parse(JSON.stringify(this.data.players))
      if (item.recordRefs?.length) {
        item.recordRefs.forEach(ref => {
          const player = currentPlayers.find((value: IPlayer) => value.id === ref.playerId)
          if (!player) return
          const recordIndex = player.records.findIndex(
            (record: IPlayerRecord) => record.id === ref.recordId,
          )
          if (recordIndex < 0) return
          const record = player.records[recordIndex]
          player.totalSips -= record.sipDelta
          player.consumedUnits = Math.max(
            0,
            (player.consumedUnits || 0) - record.consumedUnitsDelta,
          )
          player.records.splice(recordIndex, 1)
        })
      } else {
        const snapshotBefore = item.snapshot
        const snapshotAfter = targetIdx + 1 < stack.length
          ? stack[targetIdx + 1].snapshot
          : this.data.players

        snapshotBefore.forEach((before: IPlayer, i: number) => {
          const after = snapshotAfter[i]
          if (!after || !currentPlayers[i]) return
          const sipsDelta = after.totalSips - before.totalSips
          const consumedDelta = (after.consumedUnits || 0) - (before.consumedUnits || 0)
          currentPlayers[i].totalSips -= sipsDelta
          currentPlayers[i].consumedUnits = Math.max(
            0,
            (currentPlayers[i].consumedUnits || 0) - consumedDelta,
          )
        })
      }

      stack.splice(targetIdx, 1)

      const undoDisplayList = mapStackToUndoDisplayList(stack)

      this.setData({
        players: currentPlayers,
        ...(item.settingsSnapshot ? { settings: item.settingsSnapshot } : {}),
        undoStack: stack,
        undoDisplayList,
      })
      if (item.settingsSnapshot) {
        savePartySetupAsync({
          players: currentPlayers.map((p: IPlayer) => ({ id: p.id, name: p.name })),
          unit: item.settingsSnapshot.unit,
          unitToSip: item.settingsSnapshot.unitToSip,
        })
      }
      this.updateDisplay()
      this.saveCurrentParty()
      playInteractionSound('count')
      wx.vibrateShort({ type: 'light' })
      wx.showToast({ title: `已撤销「${item.description}」`, icon: 'none' })
    },

    /* ===== Batch Mode ===== */

    onEnterBatchMode() {
      playInteractionSound('tap')
      this.setData({
        batchMode: true,
        selectedIds: [],
        selectedCount: 0,
        expandedId: '',
        pendingAmount: 0,
        customSipAmount: '',
        effectivePendingAmount: 0,
        lastSipSource: '',
        batchPendingAmount: 0,
        batchCustomSipAmount: '',
        lastBatchSipSource: '',
        effectiveBatchPendingAmount: 0,
      })
      this.updateDisplay()
    },

    /** 退出多选且不应用当前加减预览 */
    onCancelBatchMode() {
      playInteractionSound('tap')
      this.setData({
        batchMode: false,
        selectedIds: [],
        selectedCount: 0,
        batchPendingAmount: 0,
        batchCustomSipAmount: '',
        lastBatchSipSource: '',
        effectiveBatchPendingAmount: 0,
      })
      this.updateDisplay()
    },

    computeEffectiveBatchPending(opts?: {
      pending?: number
      custom?: string
      source?: '' | 'input' | 'buttons'
    }) {
      const source = opts?.source ?? this.data.lastBatchSipSource
      const pending = opts?.pending !== undefined ? opts.pending : this.data.batchPendingAmount
      const customStr = opts?.custom !== undefined ? opts.custom : this.data.batchCustomSipAmount
      if (source === 'input') {
        const raw = (customStr || '').trim()
        if (raw !== '') {
          const c = parseInt(raw, 10)
          if (!Number.isNaN(c)) return c
        }
        return 0
      }
      if (source === 'buttons') {
        return pending
      }
      return 0
    },

    onExitBatchMode() {
      const pending = this.computeEffectiveBatchPending()
      const { selectedIds, players, settings } = this.data
      let batchBadgeSnapshot: BadgeSnapshot | null = null
      let batchToastTitle = ''
      if (pending !== 0 && selectedIds.length === 0) {
        wx.showToast({ title: '请先选择人员', icon: 'none' })
        return
      }
      if (pending !== 0 && selectedIds.length > 0) {
        batchBadgeSnapshot = this.captureBadgeSnapshot()
        const absPending = Math.abs(pending)
        const action: '+' | '-' = pending > 0 ? '+' : '-'
        const unitLabel = absPending === settings.unitToSip
          ? `1${settings.unit}` : `${absPending}口`
        batchToastTitle = `${selectedIds.length}人 ${action}${unitLabel}`
        const time = this.getCurrentTime()

        const snapshot = JSON.parse(JSON.stringify(players))
        const stack = this.data.undoStack.slice()
        stack.push({
          snapshot,
          description: batchToastTitle,
          ...sipDeltaUndoLine(`${selectedIds.length}人`, pending),
        })
        if (stack.length > 10) stack.shift()

        const updates: Record<string, any> = { undoStack: stack }
        const recordRefs: UndoRecordRef[] = []
        selectedIds.forEach((id: string) => {
          const idx = players.findIndex((p: IPlayer) => p.id === id)
          if (idx < 0) return
          const player = players[idx]
          const record = createPlayerRecord(time, action, absPending)
          updates[`players[${idx}].totalSips`] = player.totalSips + pending
          updates[`players[${idx}].records`] = [...player.records, record]
          recordRefs.push({
            playerId: id,
            recordId: record.id,
            sipDelta: record.sipDelta,
            consumedUnitsDelta: record.consumedUnitsDelta,
          })
        })
        stack[stack.length - 1].recordRefs = recordRefs

        this.setData(updates)
        this.saveCurrentParty()
        trackGrowthEvent(action === '+' ? 'penalty_added' : 'penalty_reduced', {
          action_mode: 'batch',
          affected_count: selectedIds.length,
        })
        wx.vibrateShort({ type: 'heavy' })
      }
      this.setData({
        batchMode: false,
        selectedIds: [],
        selectedCount: 0,
        batchPendingAmount: 0,
        batchCustomSipAmount: '',
        lastBatchSipSource: '',
        effectiveBatchPendingAmount: 0,
      })
      this.updateDisplay()
      if (batchBadgeSnapshot) {
        const titleUnlocked = this.showTitleUnlockIfNeeded(batchBadgeSnapshot)
        if (!titleUnlocked) playInteractionSound('count')
        if (!titleUnlocked && !this.data.titleUnlockVisible) {
          wx.showToast({ title: batchToastTitle, icon: 'none' })
        }
      } else {
        playInteractionSound('tap')
      }
    },

    onToggleSelect(e: WechatMiniprogram.TouchEvent) {
      playInteractionSound('tap')
      const id = e.currentTarget.dataset.id
      const ids = this.data.selectedIds.slice()
      const pos = ids.indexOf(id)
      if (pos >= 0) ids.splice(pos, 1)
      else ids.push(id)
      this.setData({ selectedIds: ids, selectedCount: ids.length })
      this.updateDisplay()
    },

    onSelectAll() {
      playInteractionSound('tap')
      const allIds = this.data.players.map((p: IPlayer) => p.id)
      const allSelected = this.data.selectedIds.length === allIds.length
      const ids = allSelected ? [] : allIds
      this.setData({ selectedIds: ids, selectedCount: ids.length })
      this.updateDisplay()
    },

    onBatchAdd(e: WechatMiniprogram.TouchEvent) {
      const amount = Number(e.currentTarget.dataset.amount)
      if (this.data.selectedIds.length === 0) {
        wx.showToast({ title: '请先选择人员', icon: 'none' })
        return
      }
      playInteractionSound('tap')
      let batchPendingAmount = this.data.batchPendingAmount
      let batchCustomSipAmount = this.data.batchCustomSipAmount
      if (this.data.lastBatchSipSource === 'input') {
        batchPendingAmount = 0
        batchCustomSipAmount = ''
      }
      batchPendingAmount += amount
      this.setData({
        lastBatchSipSource: 'buttons',
        batchPendingAmount,
        batchCustomSipAmount,
        effectiveBatchPendingAmount: this.computeEffectiveBatchPending({
          pending: batchPendingAmount,
          source: 'buttons',
        }),
      })
    },

    onBatchSub(e: WechatMiniprogram.TouchEvent) {
      const amount = Number(e.currentTarget.dataset.amount)
      if (this.data.selectedIds.length === 0) {
        wx.showToast({ title: '请先选择人员', icon: 'none' })
        return
      }
      playInteractionSound('tap')
      let batchPendingAmount = this.data.batchPendingAmount
      let batchCustomSipAmount = this.data.batchCustomSipAmount
      if (this.data.lastBatchSipSource === 'input') {
        batchPendingAmount = 0
        batchCustomSipAmount = ''
      }
      batchPendingAmount -= amount
      this.setData({
        lastBatchSipSource: 'buttons',
        batchPendingAmount,
        batchCustomSipAmount,
        effectiveBatchPendingAmount: this.computeEffectiveBatchPending({
          pending: batchPendingAmount,
          source: 'buttons',
        }),
      })
    },

    onBatchCustomSipInput(e: WechatMiniprogram.Input) {
      const batchCustomSipAmount = e.detail.value
      let batchPendingAmount = this.data.batchPendingAmount
      if (this.data.lastBatchSipSource === 'buttons') {
        batchPendingAmount = 0
      }
      this.setData({
        lastBatchSipSource: 'input',
        batchCustomSipAmount,
        batchPendingAmount,
        effectiveBatchPendingAmount: this.computeEffectiveBatchPending({
          custom: batchCustomSipAmount,
          source: 'input',
        }),
      })
    },

    /* ===== Add / Remove Player ===== */

    onShowAddPlayer() {
      if (this.data.players.length >= 20) {
        wx.showToast({ title: '最多20人', icon: 'none' })
        return
      }
      playInteractionSound('tap')
      this.setData({ showPlayerDialog: true, newPlayerName: '' })
    },

    onHideAddPlayer() {
      playInteractionSound('tap')
      this.setData({ showPlayerDialog: false, newPlayerName: '' })
    },

    onNewPlayerInput(e: WechatMiniprogram.Input) {
      this.setData({ newPlayerName: e.detail.value })
    },

    onConfirmAddPlayer() {
      const name = this.data.newPlayerName.trim()
      if (!name) {
        wx.showToast({ title: '请输入姓名', icon: 'none' })
        return
      }
      if (name.length > 6) {
        wx.showToast({ title: '姓名最多6个字', icon: 'none' })
        return
      }
      if (this.data.players.length >= 20) {
        wx.showToast({ title: '最多20人', icon: 'none' })
        return
      }

      const snapshot = JSON.parse(JSON.stringify(this.data.players))
      const stack = this.data.undoStack.slice()
      stack.push({
        snapshot,
        description: `添加 ${name}`,
        undoListText: `添加 ${name}`,
        undoListKind: 'neutral',
      })
      if (stack.length > 10) stack.shift()

      const newPlayer: IPlayer = {
        id: generateId(),
        name,
        totalSips: 0,
        consumedUnits: 0,
        records: [],
      }
      const players = [...this.data.players, newPlayer]

      this.setData({
        players,
        undoStack: stack,
        showPlayerDialog: false,
        newPlayerName: '',
      })

      this.updateDisplay()
      this.saveCurrentParty()
      playInteractionSound('tap')
      wx.showToast({ title: `已添加「${name}」`, icon: 'success' })
    },

    onRemovePlayer(e: WechatMiniprogram.TouchEvent) {
      const id = e.currentTarget.dataset.id
      const player = this.data.players.find((p: IPlayer) => p.id === id)
      if (!player) return
      playInteractionSound('tap')

      if (this.data.players.length <= 1) {
        wx.showToast({ title: '至少保留1人', icon: 'none' })
        return
      }

      wx.showModal({
        title: '移除玩家',
        content: `确定移除「${player.name}」吗？\n该玩家的饮酒记录将被清除`,
        confirmColor: '#E34D59',
        success: (res) => {
          if (res.confirm) {
            const snapshot = JSON.parse(JSON.stringify(this.data.players))
            const stack = this.data.undoStack.slice()
            stack.push({
              snapshot,
              description: `移除 ${player.name}`,
              undoListText: `移除 ${player.name}`,
              undoListKind: 'neutral',
            })
            if (stack.length > 10) stack.shift()

            const players = this.data.players.filter((p: IPlayer) => p.id !== id)
            this.setData({
              players,
              undoStack: stack,
              expandedId: '',
              pendingAmount: 0,
              customSipAmount: '',
              effectivePendingAmount: 0,
              lastSipSource: '',
            })

            this.updateDisplay()
            this.saveCurrentParty()
            playInteractionSound('tap')
            wx.showToast({ title: `已移除「${player.name}」`, icon: 'success' })
          }
        },
      })
    },

    onPlayerDialogNoop() {},

    /* ===== Change Count ===== */

    onShowChangeUnit() {
      playInteractionSound('tap')
      this.setData({
        showUnitDialog: true,
        newUnitToSip: String(this.data.settings.unitToSip),
      })
    },

    onHideChangeUnit() {
      playInteractionSound('tap')
      this.setData({
        showUnitDialog: false,
        newUnitToSip: '',
      })
    },

    onNewUnitInput(e: WechatMiniprogram.Input) {
      this.setData({ newUnitToSip: e.detail.value })
    },

    onConfirmChangeUnit() {
      const val = parseInt(this.data.newUnitToSip, 10)
      if (!val || val <= 0) {
        wx.showToast({ title: '请输入有效数字', icon: 'none' })
        return
      }

      const { players, settings } = this.data
      const oldUnitToSip = settings.unitToSip
      if (val === oldUnitToSip) {
        this.setData({ showUnitDialog: false, newUnitToSip: '' })
        return
      }

      const snapshot = JSON.parse(JSON.stringify(players))
      const settingsSnapshot = { ...settings }
      const stack = this.data.undoStack.slice()
      stack.push({
        snapshot,
        settingsSnapshot,
        description: `计数 ${oldUnitToSip}→${val}口/${settings.unit}`,
        undoListText: `计数 ${oldUnitToSip}→${val}`,
        undoListKind: 'neutral',
      })
      if (stack.length > 10) stack.shift()

      const updates: Record<string, any> = {
        'settings.unitToSip': val,
        undoStack: stack,
        showUnitDialog: false,
        newUnitToSip: '',
      }

      players.forEach((p: IPlayer, idx: number) => {
        const targetTotalSips = Math.round((p.totalSips / oldUnitToSip) * val)
        const records = p.records.map((record: IPlayerRecord) => {
          const sipDelta = Math.round((record.sipDelta / oldUnitToSip) * val)
          return {
            ...record,
            action: (sipDelta === 0 ? record.action : (sipDelta > 0 ? '+' : '-')) as '+' | '-',
            amount: Math.abs(sipDelta),
            sipDelta,
          }
        })

        /**
         * 分条四舍五入可能与汇总四舍五入差 1-2 口，把差额并入最后一条记录，
         * 保证后续逐条撤回时，所有记录变化量之和始终等于当前总口数。
         */
        if (records.length > 0) {
          const recordsTotal = records.reduce(
            (sum: number, record: IPlayerRecord) => sum + record.sipDelta,
            0,
          )
          const delta = targetTotalSips - recordsTotal
          if (delta !== 0) {
            const lastIndex = records.length - 1
            const last = records[lastIndex]
            const sipDelta = last.sipDelta + delta
            records[lastIndex] = {
              ...last,
              action: (sipDelta === 0 ? last.action : (sipDelta > 0 ? '+' : '-')) as '+' | '-',
              amount: Math.abs(sipDelta),
              sipDelta,
            }
          }
        }

        updates[`players[${idx}].totalSips`] = targetTotalSips
        updates[`players[${idx}].records`] = records
      })

      this.setData(updates)
      savePartySetupAsync({
        players: players.map((p: IPlayer) => ({ id: p.id, name: p.name })),
        unit: settings.unit,
        unitToSip: val,
      })
      this.updateDisplay()
      this.saveCurrentParty()
      playInteractionSound('tap')
      wx.showToast({ title: `已改为${val}口/${settings.unit}`, icon: 'success' })
    },

    /* ===== Theme ===== */

    onToggleDarkMode() {
      playInteractionSound('tap')
      const nextDarkMode = !this.data.darkMode
      this.setData({ darkMode: nextDarkMode })
      saveDarkMode(nextDarkMode)
      wx.showToast({
        title: nextDarkMode ? '已切换夜间模式' : '已切换日间模式',
        icon: 'none',
      })
    },

    /* ===== Ranking ===== */

    onShowRanking() {
      playInteractionSound('tap')
      this.updateDisplay({ includeRanking: true })
      this.setData({
        showRanking: true,
        longSessionShareVisible: false,
      })
    },

    onHideRanking() {
      playInteractionSound('tap')
      this.setData({ showRanking: false })
    },

    onRankingChange(e: WechatMiniprogram.CustomEvent) {
      if (!e.detail.visible) {
        this.setData({ showRanking: false })
      }
    },

    onShowMedalGuide() {
      playInteractionSound('tap')
      this.setData({ showMedalGuide: true })
    },

    onHideMedalGuide() {
      playInteractionSound('tap')
      this.setData({ showMedalGuide: false })
    },

    /** 获取 type="2d" 的 Canvas 节点。画布位于总览弹层内，必须在弹层已渲染后调用。 */
    getPartyPosterCanvas(): Promise<WechatMiniprogram.Canvas> {
      return new Promise((resolve, reject) => {
        this.createSelectorQuery()
          .select('#partyPosterCanvas')
          .fields({ node: true, size: true })
          .exec(result => {
            const canvas = result && result[0] && result[0].node as WechatMiniprogram.Canvas
            if (canvas) {
              resolve(canvas)
              return
            }
            reject(new Error('CANVAS_NODE_UNAVAILABLE'))
          })
      })
    },

    /**
     * 从当前真实酒局数据生成 750×1334 战绩长图。
     * 失败只给提示并恢复按钮，不影响总览、记账或原有分享链路。
     */
    onGeneratePartyPoster() {
      if (this.data.posterGenerating) return
      const party = this.buildCurrentParty()
      const overview = buildPartyOverview({
        players: party.players,
        settings: party.settings,
        includeRanking: true,
        startTime: party.startTime,
        elapsedMs: this.getCurrentElapsedMs(),
        playerAvatarPhotos: party.playerAvatarPhotos || {},
      })
      this.setData({ posterGenerating: true })
      wx.showLoading({ title: '正在生成', mask: true })

      // 新版基础库优先使用 getWindowInfo；旧版类型包或低版本基础库回退到
      // getSystemInfoSync，仅用于取得 DPR，不读取或持久化其他设备信息。
      const wxRuntime = wx as any
      const dpr = typeof wxRuntime.getWindowInfo === 'function'
        ? wxRuntime.getWindowInfo().pixelRatio
        : wx.getSystemInfoSync().pixelRatio

      this.getPartyPosterCanvas()
        .then(canvas => generatePartyPoster({
          canvas,
          scope: this,
          dpr,
          party,
          overview,
          miniProgramCodePath: '/images/miniprogram-qrcode.png',
        }))
        .then(tempFilePath => {
          this.setData({
            posterTempFilePath: tempFilePath,
            posterGenerating: false,
          })
          wx.hideLoading()
          wx.showToast({ title: '战绩图已生成', icon: 'success' })
        })
        .catch(err => {
          console.error('[party poster] generate failed', err)
          this.setData({ posterGenerating: false })
          wx.hideLoading()
          wx.showToast({ title: '战绩图生成失败，请稍后重试', icon: 'none' })
        })
    },

    savePosterFileToAlbum(filePath: string) {
      wx.saveImageToPhotosAlbum({
        filePath,
        success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
        fail: err => {
          console.warn('[party poster] save album failed', err)
          wx.showToast({ title: '保存失败，请稍后重试', icon: 'none' })
        },
      })
    },

    /** 相册权限被拒后提供明确且可点击的设置入口。 */
    showAlbumSettingGuide() {
      wx.showModal({
        title: '需要相册权限',
        content: '请在设置中允许“保存到相册”，然后重新点击保存。',
        confirmText: '去设置',
        cancelText: '暂不',
        success: result => {
          if (!result.confirm) return
          wx.openSetting({
            success: setting => {
              if (setting.authSetting['scope.writePhotosAlbum'] && this.data.posterTempFilePath) {
                this.savePosterFileToAlbum(this.data.posterTempFilePath)
              }
            },
          })
        },
      })
    },

    /** 保存前先检查相册权限；首次请求 authorize，明确拒绝时引导打开设置。 */
    onSavePartyPoster() {
      const filePath = this.data.posterTempFilePath
      if (!filePath) {
        wx.showToast({ title: '请先生成战绩图', icon: 'none' })
        return
      }
      wx.getSetting({
        success: setting => {
          const authorized = setting.authSetting['scope.writePhotosAlbum']
          if (authorized === true) {
            this.savePosterFileToAlbum(filePath)
            return
          }
          if (authorized === false) {
            this.showAlbumSettingGuide()
            return
          }
          wx.authorize({
            scope: 'scope.writePhotosAlbum',
            success: () => this.savePosterFileToAlbum(filePath),
            fail: () => this.showAlbumSettingGuide(),
          })
        },
        fail: () => wx.showToast({ title: '无法读取相册权限，请稍后重试', icon: 'none' }),
      })
    },

    /* ===== 同桌只读共享（房主管理） ===== */

    getCurrentPartyId(): string {
      return String(loadParty()?.partyId || '')
    },

    onShowInvitePanel() {
      const partyId = this.getCurrentPartyId()
      if (!partyId) {
        wx.showToast({ title: '请先开始聚会', icon: 'none' })
        return
      }
      playInteractionSound('tap')
      this.setData({ showInvitePanel: true })
      this.refreshPartyMembers({ silent: false })
    },

    onInvitePanelChange(event: WechatMiniprogram.CustomEvent) {
      if (!event.detail.visible) this.setData({ showInvitePanel: false })
    },

    onHideInvitePanel() {
      this.setData({ showInvitePanel: false })
    },

    buildPartyMemberRows(members: SharedPartyMember[]) {
      const players = this.data.players as IPlayer[]
      return members.map(member => ({
        ...member,
        claimedName: member.claimedPlayerId
          ? (players.find(player => player.id === member.claimedPlayerId)?.name || '名单已变更')
          : (member.role === 'owner'
            ? '房主'
            : `${member.displayName || '同桌成员'} · 未认领`),
        isOwner: member.role === 'owner',
      }))
    },

    refreshPartyMembers(options: { silent?: boolean } = {}) {
      const partyId = this.getCurrentPartyId()
      if (!partyId || this.data.membersLoading) return Promise.resolve()
      if (!options.silent) this.setData({ membersLoading: true })
      return listPartyMembers(partyId)
        .then(result => {
          const updates: Record<string, any> = {
            partyMemberRows: this.buildPartyMemberRows(result.members),
            pendingTransfer: result.pendingTransfer || null,
          }
          updates.handoverCode = result.handoverCode || ''
          if (!options.silent) updates.membersLoading = false
          this.setData(updates)
          if (result.pendingTransfer) this.startHandoverPolling()
          else this.stopHandoverPolling()
        })
        .catch(error => {
          if (!options.silent) this.setData({ membersLoading: false })
          if (isPartyCloudError(error, 'PARTY_HANDED_OVER')) {
            this.handlePartyHandedOver(String(error.data?.newPartyId || ''))
            return
          }
          if (!options.silent) {
            wx.showToast({ title: String(error?.message || '成员列表加载失败'), icon: 'none' })
          }
        })
    },

    onCreatePartyInvite() {
      const partyId = this.getCurrentPartyId()
      if (!partyId || this.data.inviteCreating) return
      this.setData({ inviteCreating: true })
      createPartyInvite(partyId)
        .then(result => {
          this.setData({
            inviteCreating: false,
            inviteCode: result.inviteCode,
            inviteExpiresText: result.expiresAt
              ? new Date(result.expiresAt).toLocaleString()
              : '',
          })
          return this.refreshPartyMembers({ silent: true })
        })
        .catch(error => {
          this.setData({ inviteCreating: false })
          wx.showToast({ title: String(error?.message || '邀请生成失败'), icon: 'none' })
        })
    },

    onCopyInviteCode() {
      if (!this.data.inviteCode) return
      wx.setClipboardData({
        data: this.data.inviteCode,
        success: () => wx.showToast({ title: '邀请口令已复制', icon: 'success' }),
      })
    },

    onOpenMemberClaim(event: WechatMiniprogram.TouchEvent) {
      const memberId = String(event.currentTarget.dataset.memberId || '')
      const member = this.data.partyMemberRows.find(item => item.memberId === memberId)
      if (!member) return
      const claimedByOther = new Set(
        this.data.partyMemberRows
          .filter(item => item.memberId !== memberId && item.claimedPlayerId)
          .map(item => item.claimedPlayerId as string),
      )
      const selected = member.claimedPlayerId || ''
      this.setData({
        showMemberClaimPanel: true,
        correctingMemberId: memberId,
        correctingMemberName: member.claimedName,
        memberClaimSelectedId: selected,
        memberClaimRows: this.data.players.map((player: IPlayer) => ({
          id: player.id,
          name: player.name,
          claimedByOther: claimedByOther.has(player.id),
          selected: player.id === selected,
        })),
      })
    },

    onSelectMemberClaim(event: WechatMiniprogram.TouchEvent) {
      const playerId = String(event.currentTarget.dataset.id || '')
      const target = this.data.memberClaimRows.find(item => item.id === playerId)
      if (!target || target.claimedByOther || this.data.memberActionLoading) return
      this.setData({
        memberClaimSelectedId: playerId,
        memberClaimRows: this.data.memberClaimRows.map(item => ({
          ...item,
          selected: item.id === playerId,
        })),
      })
    },

    onMemberClaimPanelChange(event: WechatMiniprogram.CustomEvent) {
      if (!event.detail.visible) this.onHideMemberClaim()
    },

    onHideMemberClaim() {
      if (!this.data.memberActionLoading) this.setData({ showMemberClaimPanel: false })
    },

    onSaveMemberClaim() {
      this.saveMemberClaim(this.data.memberClaimSelectedId)
    },

    onClearMemberClaim() {
      this.saveMemberClaim('')
    },

    saveMemberClaim(playerId: string) {
      const partyId = this.getCurrentPartyId()
      const memberId = this.data.correctingMemberId
      if (!partyId || !memberId || this.data.memberActionLoading) return
      this.setData({ memberActionLoading: true })
      updateMemberClaim(partyId, memberId, playerId)
        .then(() => {
          this.setData({ showMemberClaimPanel: false, memberActionLoading: false })
          wx.showToast({ title: playerId ? '认领已更新' : '已取消认领', icon: 'success' })
          return this.refreshPartyMembers({ silent: true })
        })
        .catch(error => {
          this.setData({ memberActionLoading: false })
          wx.showToast({ title: String(error?.message || '更新失败'), icon: 'none' })
          this.refreshPartyMembers({ silent: true })
        })
    },

    onRemoveSharedMember(event: WechatMiniprogram.TouchEvent) {
      const memberId = String(event.currentTarget.dataset.memberId || '')
      const member = this.data.partyMemberRows.find(item => item.memberId === memberId)
      if (!member || member.isOwner) return
      wx.showModal({
        title: '移出同桌账本？',
        content: `移出后，该成员将不能继续查看本场账本。`,
        confirmText: '移出',
        confirmColor: '#D94A52',
        success: result => {
          if (!result.confirm) return
          removePartyMember(this.getCurrentPartyId(), memberId)
            .then(() => {
              wx.showToast({ title: '已移出', icon: 'success' })
              this.refreshPartyMembers({ silent: true })
            })
            .catch(error => wx.showToast({ title: String(error?.message || '移出失败'), icon: 'none' }))
        },
      })
    },

    onInitiateTransfer(event: WechatMiniprogram.TouchEvent) {
      const memberId = String(event.currentTarget.dataset.memberId || '')
      const member = this.data.partyMemberRows.find(item => item.memberId === memberId)
      if (!member || member.isOwner || this.data.pendingTransfer) return
      wx.showModal({
        title: '转让记账权？',
        content: `将记账权交给“${member.claimedName}”。对方确认后会新建酒局接管，原局立即停止写入。`,
        confirmText: '发起转让',
        confirmColor: '#E9921B',
        success: result => {
          if (!result.confirm) return
          wx.showLoading({ title: '正在发起', mask: true })
          initiateOwnershipTransfer(this.getCurrentPartyId(), memberId)
            .then(transfer => {
              wx.hideLoading()
              this.setData({
                pendingTransfer: transfer.pendingTransfer,
                handoverCode: transfer.handoverCode,
              })
              this.startHandoverPolling()
              wx.showToast({ title: '请发送确认卡片', icon: 'none' })
            })
            .catch(error => {
              wx.hideLoading()
              wx.showToast({ title: String(error?.message || '发起失败'), icon: 'none' })
            })
        },
      })
    },

    onCancelTransfer() {
      const pending = this.data.pendingTransfer
      if (!pending) return
      cancelOwnershipTransfer(this.getCurrentPartyId(), pending.transferId)
        .then(() => {
          this.setData({ pendingTransfer: null, handoverCode: '' })
          this.stopHandoverPolling()
          wx.showToast({ title: '已取消交接', icon: 'success' })
        })
        .catch(error => wx.showToast({ title: String(error?.message || '取消失败'), icon: 'none' }))
    },

    startHandoverPolling() {
      this.stopHandoverPolling()
      if (!this.data.pendingTransfer) return
      ;(this as any)._handoverPollTimer = setInterval(() => {
        this.refreshPartyMembers({ silent: true })
      }, 4000)
    },

    stopHandoverPolling() {
      if ((this as any)._handoverPollTimer) clearInterval((this as any)._handoverPollTimer)
      ;(this as any)._handoverPollTimer = null
    },

    handlePartyHandedOver(newPartyId: string) {
      if ((this as any)._handoverHandled) return
      ;(this as any)._handoverHandled = true
      this.stopHandoverPolling()
      this.stopTimer()
      if ((this as any)._cloudSyncTimer) clearTimeout((this as any)._cloudSyncTimer)
      ;(this as any)._cloudSyncTimer = null
      clearParty()
      wx.showModal({
        title: '记账权已交接',
        content: '对方已确认接管。你现在只能查看同桌账本，原局不会再接受写入。',
        showCancel: false,
        confirmText: '查看账本',
        success: () => {
          const query = newPartyId ? `?partyId=${encodeURIComponent(newPartyId)}` : ''
          wx.redirectTo({ url: `/pages/party-view/party-view${query}` })
        },
      })
    },

    /* ===== Storage ===== */

    buildCurrentParty(): IPartyData {
      const prev = loadParty()
      const { players, settings, startTime, pausedDurationMs, playerAvatarPhotos } = this.data
      const updatedAt = new Date().toISOString()
      return {
        partyId: prev?.partyId || generateId(),
        createdAt: prev?.createdAt || new Date().toISOString(),
        /**
         * 本地更新时间用于云函数拒绝旧快照覆盖新快照。
         * 用户从历史记录继续同一局时 partyId 会复用，只靠 partyId 无法区分 4:15 与 5:15 两次退出。
         */
        updatedAt,
        settings,
        players,
        startTime,
        pausedDurationMs: Math.max(Number(pausedDurationMs || prev?.pausedDurationMs || 0), 0),
        playerAvatarPhotos: playerAvatarPhotos || prev?.playerAvatarPhotos || {},
      }
    },

    saveCurrentParty(options?: { immediateCloud?: boolean }) {
      const party = this.buildCurrentParty()
      saveParty(party)
      if (this.data.posterTempFilePath) this.setData({ posterTempFilePath: '' })
      this.queueCloudSave(party, !!options?.immediateCloud)
    },

    queueCloudSave(party: IPartyData, immediate: boolean) {
      ;(this as any)._lastCloudParty = party
      if ((this as any)._cloudSyncTimer) {
        clearTimeout((this as any)._cloudSyncTimer)
        ;(this as any)._cloudSyncTimer = null
      }
      if (immediate) {
        this.flushCloudSave(party)
        return
      }
      ;(this as any)._cloudSyncTimer = setTimeout(() => {
        ;(this as any)._cloudSyncTimer = null
        this.flushCloudSave()
      }, 800)
    },

    flushCloudSave(party?: IPartyData) {
      const target = party || (this as any)._lastCloudParty
      if (!target) return
      const app = getApp<IAppOption>()
      const currentParty = loadParty()
      if (
        app.globalData.partyEndingByLifecycle ||
        !currentParty ||
        currentParty.partyId !== target.partyId ||
        !!currentParty.endedAt
      ) {
        return
      }
      saveActivePartyToCloud(target)
        .catch(err => {
          if (isPartyCloudError(err, 'PARTY_HANDED_OVER')) {
            this.handlePartyHandedOver(String(err.data?.newPartyId || ''))
            return
          }
          console.error('[record cloud save] local only', err)
        })
    },

    onDebtChampionPickPhoto() {
      const hero = this.data.debtChampionHero
      if (!hero) return
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        success: res => {
          const temp = res.tempFiles[0]?.tempFilePath
          if (!temp) return
          wx.getFileSystemManager().saveFile({
            tempFilePath: temp,
            success: r => {
              const photos = { ...(this.data.playerAvatarPhotos || {}) }
              photos[hero.playerId] = r.savedFilePath
              this.setData({
                playerAvatarPhotos: photos,
                debtChampionHero: { ...hero, photoPath: r.savedFilePath },
              })
              this.saveCurrentParty()
              wx.showToast({ title: '已更新头像', icon: 'success' })
            },
            fail: () => wx.showToast({ title: '保存失败', icon: 'none' }),
          })
        },
      })
    },

    onDebtChampionPhotoError() {
      const hero = this.data.debtChampionHero
      if (!hero?.playerId) return
      const photos = { ...(this.data.playerAvatarPhotos || {}) }
      delete photos[hero.playerId]
      this.setData({
        playerAvatarPhotos: photos,
        debtChampionHero: { ...hero, photoPath: '' },
      })
      this.saveCurrentParty()
    },

    onShareAppMessage(event?: any) {
      const shareType = String((event as any)?.target?.dataset?.shareType || '')
      if (shareType === 'party-invite' && this.data.inviteCode) {
        return {
          title: '同桌账本已建好，点这里只读查看',
          path: `/pages/party-view/party-view?invite=${encodeURIComponent(this.data.inviteCode)}`,
          imageUrl: SEO_COPY.shareImage,
        }
      }
      if (shareType === 'party-handover' && this.data.handoverCode) {
        return {
          title: '房主邀请你接管这场聚会的记账',
          path: `/pages/party-view/party-view?handover=${encodeURIComponent(this.data.handoverCode)}`,
          imageUrl: SEO_COPY.shareImage,
        }
      }
      const n = this.data.players?.length || 0
      const posterTempFilePath = this.data.posterTempFilePath
      trackGrowthEvent('share_clicked', { share_target: 'friend', entry_page: 'record' })
      return {
        title: posterTempFilePath && n > 0
          ? `${n}人聚会战绩｜谁输多少一眼看清`
          : (n > 0 ? SEO_COPY.activePartyShareTitle(n) : SEO_COPY.shareTitle),
        path: buildGrowthSharePath('/pages/index/index'),
        imageUrl: posterTempFilePath || SEO_COPY.shareImage,
      }
    },

    /** 右上角「分享到朋友圈」 */
    onShareTimeline() {
      const n = this.data.players?.length || 0
      trackGrowthEvent('share_clicked', { share_target: 'timeline', entry_page: 'record' })
      return {
        title: n > 0 ? SEO_COPY.activePartyShareTitle(n) : SEO_COPY.timelineTitle,
        query: n > 0 ? `n=${n}&${buildGrowthTimelineQuery()}` : buildGrowthTimelineQuery(),
        imageUrl: SEO_COPY.shareImage,
      }
    },
  },
})
