const PARTY_KEY = 'currentParty'
const SETTINGS_KEY = 'appSettings'
const PARTY_SETUP_KEY = 'partySetup'
const ONBOARDING_V1_KEY = 'onboardingV1Done'
const DARK_MODE_KEY = 'darkMode'
const PENDING_ENDED_PARTY_KEY = 'pendingEndedParty'
const LONG_SESSION_SHARE_PROMPT_KEY = 'longSessionSharePromptedParties'

export const PARTY_UNIT_OPTIONS: IPartySettings['unit'][] = ['杯', '瓶', '罐']
export const DEFAULT_PARTY_UNIT: IPartySettings['unit'] = '瓶'
export const DEFAULT_UNIT_TO_SIP = 30

type StorageKey =
  | typeof PARTY_KEY
  | typeof SETTINGS_KEY
  | typeof PARTY_SETUP_KEY
  | typeof ONBOARDING_V1_KEY
  | typeof DARK_MODE_KEY
  | typeof PENDING_ENDED_PARTY_KEY
  | typeof LONG_SESSION_SHARE_PROMPT_KEY

/**
 * 页面生命周期内的轻量 storage 快照。
 * 作用：同一轮小程序运行中，启动页/记录页反复读取相同 key 时优先命中内存，
 * 避免在首屏渲染和频繁保存期间重复调用 wx.getStorageSync / wx.getStorage。
 */
const storageCache: Partial<Record<StorageKey, unknown>> = {}
const storageCacheReady: Partial<Record<StorageKey, boolean>> = {}

export type AppSettingsData = {
  unit: string
  unitToSip: number
  players: Array<{ id: string; name: string }>
}

export type PartySetupData = {
  players: Array<{ id: string; name: string }>
  unit: string
  unitToSip: number
}

export type HomeStartupStorage = {
  darkMode: boolean
  settings: AppSettingsData | null
  party: IPartyData | null
  onboardingDone: boolean
}

export type RecordStartupStorage = {
  darkMode: boolean
  setup: PartySetupData | null
  party: IPartyData | null
}

type LongSessionSharePromptState = Record<string, number>

export function normalizePartyUnit(unit: unknown): IPartySettings['unit'] {
  return PARTY_UNIT_OPTIONS.indexOf(unit as IPartySettings['unit']) >= 0
    ? unit as IPartySettings['unit']
    : DEFAULT_PARTY_UNIT
}

export function normalizeStoredUnitToSip(value: unknown): number {
  const parsed = Math.round(Number(value || 0))
  return parsed > 0 ? parsed : DEFAULT_UNIT_TO_SIP
}

function normalizeSettings(settings: AppSettingsData | null): AppSettingsData | null {
  if (!settings) return null
  return {
    unit: normalizePartyUnit(settings.unit),
    unitToSip: normalizeStoredUnitToSip(settings.unitToSip),
    players: Array.isArray(settings.players) ? settings.players : [],
  }
}

function normalizeParty(party: IPartyData | null): IPartyData | null {
  if (!party || !Array.isArray(party.players) || party.players.length === 0) return null
  return party
}

function normalizePartySetup(setup: PartySetupData | null): PartySetupData | null {
  if (!setup || !Array.isArray(setup.players) || setup.players.length === 0) return null
  return {
    players: setup.players,
    unit: normalizePartyUnit(setup.unit),
    unitToSip: normalizeStoredUnitToSip(setup.unitToSip),
  }
}

function setStorageCache<T>(key: StorageKey, value: T | null): T | null {
  storageCache[key] = value
  storageCacheReady[key] = true
  return value
}

function getStorageCache<T>(key: StorageKey): T | null | undefined {
  if (!storageCacheReady[key]) return undefined
  return (storageCache[key] as T | null) ?? null
}

/**
 * 异步读取本地缓存：先读内存快照，未命中时再调用 wx.getStorage。
 * 注意：所有写入/删除必须走本文件的封装函数，才能保证快照和真实 storage 一致。
 */
function readStorage<T>(key: StorageKey): Promise<T | null> {
  const cached = getStorageCache<T>(key)
  if (cached !== undefined) return Promise.resolve(cached)

  return new Promise(resolve => {
    wx.getStorage({
      key,
      success: res => resolve(setStorageCache<T>(key, (res.data as T) ?? null)),
      fail: () => resolve(setStorageCache<T>(key, null)),
    })
  })
}

function writeStorageSync<T>(key: StorageKey, data: T): void {
  setStorageCache<T>(key, data)
  wx.setStorageSync(key, data)
}

/**
 * 非阻塞写入：适合首屏初始化兜底写、主题开关等不需要立即读取落盘结果的场景。
 * 调用时会先更新内存快照，再异步落盘，避免阻塞当前页面渲染线程。
 */
function writeStorage<T>(key: StorageKey, data: T): void {
  setStorageCache<T>(key, data)
  wx.setStorage({
    key,
    data,
    fail: err => {
      console.warn(`[storage] write ${key} failed`, err)
    },
  })
}

function removeStorageSync(key: StorageKey): void {
  setStorageCache(key, null)
  wx.removeStorageSync(key)
}

/** 首页启动态一次性异步读取，避免首屏渲染前多次同步 storage 阻塞主线程。 */
export function loadHomeStartupStorage(): Promise<HomeStartupStorage> {
  return Promise.all([
    readStorage<boolean>(DARK_MODE_KEY),
    readStorage<AppSettingsData>(SETTINGS_KEY),
    readStorage<IPartyData>(PARTY_KEY),
    readStorage<boolean>(ONBOARDING_V1_KEY),
  ]).then(([darkMode, settings, party, onboardingDone]) => {
    return {
      darkMode: !!darkMode,
      settings: normalizeSettings(settings),
      party: normalizeParty(party),
      onboardingDone: !!onboardingDone,
    }
  })
}

/** 记录页启动态一次性异步读取，合并 partySetup/currentParty/darkMode 三个启动依赖。 */
export function loadRecordStartupStorage(): Promise<RecordStartupStorage> {
  return Promise.all([
    readStorage<boolean>(DARK_MODE_KEY),
    readStorage<PartySetupData>(PARTY_SETUP_KEY),
    readStorage<IPartyData>(PARTY_KEY),
  ]).then(([darkMode, setup, party]) => {
    return {
      darkMode: !!darkMode,
      setup: normalizePartySetup(setup),
      party: normalizeParty(party),
    }
  })
}

export function shouldShowOnboardingFromStorage(storage: HomeStartupStorage): boolean {
  if (storage.onboardingDone) return false
  if (storage.settings && storage.settings.players && storage.settings.players.length > 0) return false
  if (storage.party && !storage.party.endedAt) return false
  return true
}

export function markOnboardingV1Seen(): void {
  writeStorageSync(ONBOARDING_V1_KEY, true)
}

export function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

export function saveParty(data: IPartyData): void {
  writeStorageSync(PARTY_KEY, data)
}

export function savePartyAsync(data: IPartyData): void {
  writeStorage(PARTY_KEY, data)
}

export function loadParty(): IPartyData | null {
  const cached = getStorageCache<IPartyData>(PARTY_KEY)
  if (cached !== undefined) return cached

  try {
    return setStorageCache<IPartyData>(PARTY_KEY, wx.getStorageSync(PARTY_KEY) || null)
  } catch (err) {
    console.warn('[storage] read currentParty failed', err)
    return setStorageCache<IPartyData>(PARTY_KEY, null)
  }
}

export function clearParty(): void {
  removeStorageSync(PARTY_KEY)
}

export function savePendingEndedParty(party: IPartyData): void {
  writeStorageSync(PENDING_ENDED_PARTY_KEY, party)
}

export function loadPendingEndedParty(): IPartyData | null {
  const cached = getStorageCache<IPartyData>(PENDING_ENDED_PARTY_KEY)
  if (cached !== undefined) return cached

  try {
    return setStorageCache<IPartyData>(
      PENDING_ENDED_PARTY_KEY,
      wx.getStorageSync(PENDING_ENDED_PARTY_KEY) || null,
    )
  } catch (err) {
    console.warn('[storage] read pendingEndedParty failed', err)
    return setStorageCache<IPartyData>(PENDING_ENDED_PARTY_KEY, null)
  }
}

function getPartySyncMarker(party: IPartyData | null): string {
  return String(party?.endedAt || party?.updatedAt || '')
}

export function clearPendingEndedParty(partyId?: string, syncMarker?: string): void {
  if (partyId) {
    const pending = loadPendingEndedParty()
    if (pending?.partyId && pending.partyId !== partyId) return
    /**
     * 同一场历史酒局可以被继续记录，partyId 会复用。
     * 清理待补传缓存时必须同时匹配结束/更新时间，避免上一轮慢请求成功后
     * 把下一轮退出刚写入的待补传快照误删。
     */
    if (syncMarker && getPartySyncMarker(pending) !== syncMarker) return
  }
  removeStorageSync(PENDING_ENDED_PARTY_KEY)
}

/**
 * 用于首页"上次聚会未结束"恢复横幅。
 * 仅在确实有玩家、且尚未结束（最少 1 人）时才视为可恢复。
 */
export function loadResumableParty(): IPartyData | null {
  const data = loadParty()
  if (!data || data.endedAt || !data.players || data.players.length === 0) return null
  return data
}

function loadLongSessionSharePromptState(): LongSessionSharePromptState {
  const cached = getStorageCache<LongSessionSharePromptState>(LONG_SESSION_SHARE_PROMPT_KEY)
  if (cached !== undefined) return cached || {}

  try {
    const raw = wx.getStorageSync(LONG_SESSION_SHARE_PROMPT_KEY)
    const state = raw && typeof raw === 'object' ? raw as LongSessionSharePromptState : {}
    return setStorageCache<LongSessionSharePromptState>(LONG_SESSION_SHARE_PROMPT_KEY, state) || {}
  } catch (err) {
    console.warn('[storage] read long session share prompt failed', err)
    return setStorageCache<LongSessionSharePromptState>(LONG_SESSION_SHARE_PROMPT_KEY, {}) || {}
  }
}

function getLongSessionSharePromptStorageKey(partyKey: string, milestone: number): string {
  return `${partyKey}:m${Math.max(Math.floor(Number(milestone) || 0), 1)}`
}

/** 判断当前酒局的指定 45 分钟档位是否已经出现过战绩提醒。只存本地轻量标记，不写云端。 */
export function hasLongSessionSharePrompted(partyKey: string, milestone = 1): boolean {
  if (!partyKey) return false
  const state = loadLongSessionSharePromptState()
  const milestoneKey = getLongSessionSharePromptStorageKey(partyKey, milestone)
  if (Number(state[milestoneKey] || 0) > 0) return true
  return milestone <= 1 && Number(state[partyKey] || 0) > 0
}

/** 记录当前酒局的指定 45 分钟档位已经出现过战绩提醒，避免恢复页面后重复打扰。 */
export function markLongSessionSharePrompted(partyKey: string, milestone = 1): void {
  if (!partyKey) return
  const state = {
    ...loadLongSessionSharePromptState(),
    [getLongSessionSharePromptStorageKey(partyKey, milestone)]: Date.now(),
  }
  const entries = Object.keys(state)
    .map(key => ({ key, time: Number(state[key] || 0) }))
    .sort((a, b) => b.time - a.time)
    .slice(0, 80)
  const nextState = entries.reduce((result: LongSessionSharePromptState, item) => {
    result[item.key] = item.time
    return result
  }, {})
  writeStorageSync(LONG_SESSION_SHARE_PROMPT_KEY, nextState)
}

export function savePartySetup(setup: PartySetupData): void {
  writeStorageSync(PARTY_SETUP_KEY, setup)
}

export function savePartySetupAsync(setup: PartySetupData): void {
  writeStorage(PARTY_SETUP_KEY, setup)
}

/**
 * 把已存在的 party 反向写回 partySetup，让 record 页 attached 里的
 * rosterMatch 一定命中，从而完整恢复（玩家、口数、设置、计时起点都不变）。
 */
export function restorePartySetupFromParty(party: IPartyData, options?: { async?: boolean }): void {
  const setup = {
    players: party.players.map(p => ({ id: p.id, name: p.name })),
    unit: party.settings.unit,
    unitToSip: party.settings.unitToSip,
  }
  if (options?.async) {
    savePartySetupAsync(setup)
    return
  }
  savePartySetup(setup)
}

/** 结束聚会回到首页：清除当前聚会存档 + 会前设置 + 首页已填人员与单位 */
export function clearPartyAndHomeSetup(): void {
  removeStorageSync(PARTY_KEY)
  removeStorageSync(PARTY_SETUP_KEY)
  removeStorageSync(SETTINGS_KEY)
}

export function createDefaultParty(players: IPlayer[], settings: IPartySettings): IPartyData {
  return {
    partyId: generateId(),
    createdAt: new Date().toISOString(),
    settings,
    players: players.map(p => ({
      ...p,
      totalSips: 0,
      consumedUnits: 0,
      records: [],
    })),
    startTime: Date.now(),
    playerAvatarPhotos: {},
  }
}

export function saveAppSettings(settings: AppSettingsData): void {
  writeStorageSync(SETTINGS_KEY, settings)
}

export function loadDarkMode(): boolean {
  const cached = getStorageCache<boolean>(DARK_MODE_KEY)
  if (cached !== undefined) return !!cached

  try {
    return !!setStorageCache<boolean>(DARK_MODE_KEY, !!wx.getStorageSync(DARK_MODE_KEY))
  } catch (err) {
    console.warn('[storage] read darkMode failed', err)
    return !!setStorageCache<boolean>(DARK_MODE_KEY, false)
  }
}

export function saveDarkMode(darkMode: boolean): void {
  writeStorage(DARK_MODE_KEY, darkMode)
}

export function formatTimeHHMM(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const hh = hours.toString().padStart(2, '0')
  const mm = minutes.toString().padStart(2, '0')
  const ss = seconds.toString().padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) {
    return `${hours}小时${minutes}分钟`
  }
  return `${minutes}分钟`
}
