/**
 * 自媒体增长归因与事件上报。
 *
 * 设计边界：
 * 1. 只记录渠道、内容编号和聚合行为，不上传参与者姓名、头像或具体惩罚数量；
 * 2. 使用微信官方 wx.reportAnalytics，上报结果在小程序后台的「自定义分析」查看；
 * 3. 来源参数只保留在当前运行会话，用户本次进入后再分享给好友时仍能保留原内容编号；
 *    下一次无参数冷启动会恢复为 direct，避免长期把自然回访误算给旧内容。
 */

export type GrowthEventName =
  | 'landing_view'
  | 'counter_started'
  | 'penalty_added'
  | 'penalty_reduced'
  | 'share_clicked'

export type GrowthAttribution = {
  source: string
  campaign: string
  contentId: string
  entryScene: string
}

type AppEntryOptions = {
  path?: string
  scene?: number
  query?: Record<string, string | number | undefined>
}

const DEFAULT_ATTRIBUTION: GrowthAttribution = {
  source: 'direct',
  campaign: '',
  contentId: '',
  entryScene: '',
}

let attributionCache: GrowthAttribution | null = null
let lastLandingSignature = ''
let lastLandingAt = 0

function clean(value: unknown, maxLength = 64): string {
  return String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, maxLength)
}

function normalizeSource(value: unknown): string {
  const source = clean(value)
  if (source === 'wxv') return 'wxvideo'
  if (source === 'tl') return 'timeline'
  if (source === 'shr') return 'share'
  return source
}

function parseSceneQuery(sceneValue: unknown): Record<string, string> {
  const raw = String(sceneValue ?? '').trim()
  if (!raw) return {}

  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch (err) {
    console.warn('[growth] scene decode failed', err)
  }

  return decoded.split('&').reduce((result: Record<string, string>, pair) => {
    const separator = pair.indexOf('=')
    if (separator <= 0) return result
    const key = pair.slice(0, separator)
    const value = pair.slice(separator + 1)
    result[key] = value
    return result
  }, {})
}

function readStoredAttribution(): GrowthAttribution {
  return attributionCache || { ...DEFAULT_ATTRIBUTION }
}

function saveAttribution(value: GrowthAttribution): void {
  attributionCache = value
}

/**
 * 读取启动参数并更新当前归因。
 *
 * 支持普通入口参数：source、campaign、contentId；也支持小程序码把同一组
 * 参数编码进 scene。没有新参数时沿用本机最近一次有效归因，避免分享过程中丢失内容编号。
 */
export function captureGrowthAttribution(options: AppEntryOptions = {}): GrowthAttribution {
  const query = options.query || {}
  const sceneQuery = parseSceneQuery(query.scene)
  const merged = { ...sceneQuery, ...query }
  const previous = attributionCache || { ...DEFAULT_ATTRIBUTION }
  const hasCampaignInput = !!(
    merged.source || merged.from || merged.s ||
    merged.campaign || merged.c ||
    merged.contentId || merged.content_id || merged.i
  )

  if (!hasCampaignInput) {
    const next = {
      ...previous,
      entryScene: clean(options.scene) || previous.entryScene,
    }
    saveAttribution(next)
    return next
  }

  const next: GrowthAttribution = {
    source: normalizeSource(merged.source || merged.from || merged.s) || previous.source || 'direct',
    campaign: clean(merged.campaign || merged.c) || previous.campaign,
    contentId: clean(merged.contentId || merged.content_id || merged.i) || previous.contentId,
    entryScene: clean(options.scene) || previous.entryScene,
  }
  saveAttribution(next)
  return next
}

export function getGrowthAttribution(): GrowthAttribution {
  return { ...readStoredAttribution() }
}

/**
 * 上报一个增长事件。extra 只能放非个人化的枚举或计数，例如操作入口、批量人数；
 * 不要传入姓名、头像、备注、openid 或具体酒局明细。
 */
export function trackGrowthEvent(
  eventName: GrowthEventName,
  extra: Record<string, string | number> = {},
): void {
  const attribution = readStoredAttribution()
  const data: Record<string, string | number> = {
    source: attribution.source || 'direct',
    campaign: attribution.campaign || 'none',
    content_id: attribution.contentId || 'none',
    entry_scene: attribution.entryScene || 'unknown',
  }
  Object.keys(extra).forEach(key => {
    const value = extra[key]
    data[clean(key, 32)] = typeof value === 'number' ? value : clean(value)
  })

  try {
    wx.reportAnalytics(eventName, data)
  } catch (err) {
    // 自定义分析尚未在后台配置时不阻断核心记账流程。
    console.warn(`[growth] report ${eventName} failed`, err)
  }
}

/** App 的 onLaunch/onShow 都会触发；相同入口 30 分钟内只记一次，避免冷启动双报。 */
export function reportLandingEntry(options: AppEntryOptions = {}): void {
  const attribution = captureGrowthAttribution(options)
  const signature = [
    options.path || '',
    options.scene || '',
    attribution.source,
    attribution.campaign,
    attribution.contentId,
  ].join('|')
  const now = Date.now()
  if (signature === lastLandingSignature && now - lastLandingAt < 30 * 60 * 1000) return

  lastLandingSignature = signature
  lastLandingAt = now
  trackGrowthEvent('landing_view', {
    entry_path: clean(options.path || 'pages/index/index'),
  })
}

function encode(value: string): string {
  return encodeURIComponent(value)
}

/** 构建好友分享路径：source 改为 share，但保留最初 campaign/contentId 便于裂变归因。 */
export function buildGrowthSharePath(basePath = '/pages/index/index'): string {
  const attribution = readStoredAttribution()
  const params = [
    'source=share',
    `campaign=${encode(attribution.campaign || 'organic_share')}`,
    `contentId=${encode(attribution.contentId || 'share_card')}`,
  ]
  return `${basePath}?${params.join('&')}`
}

/** 朋友圈分享只接受 query 字符串，与好友分享使用相同归因字段。 */
export function buildGrowthTimelineQuery(): string {
  const attribution = readStoredAttribution()
  return [
    'source=timeline',
    `campaign=${encode(attribution.campaign || 'organic_share')}`,
    `contentId=${encode(attribution.contentId || 'timeline_card')}`,
  ].join('&')
}
