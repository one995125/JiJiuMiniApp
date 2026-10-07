/**
 * 酒局暂停与计时纯函数。
 *
 * 这些函数不直接读写 storage，也不调用云函数，便于在 App 生命周期、历史页、
 * 总览和云端统计之间复用同一套时间口径。新增字段均为可选，旧酒局按 0 暂停处理。
 */

/** 累计暂停达到 8 小时后自动结束，集中定义便于后续按产品反馈调整。 */
export const PARTY_AUTO_END_PAUSE_THRESHOLD_MS = 8 * 60 * 60 * 1000

function toTimestamp(value: unknown): number {
  if (!value) return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizePausedDuration(value: unknown): number {
  const duration = Number(value || 0)
  return Number.isFinite(duration) ? Math.max(duration, 0) : 0
}

/** 切后台时只记录暂停起点；重复触发 onHide 不会重置已存在的暂停。 */
export function pauseParty(party: IPartyData, now = Date.now()): IPartyData {
  if (party.pausedAt) return party
  const pausedAt = new Date(now).toISOString()
  return {
    ...party,
    pausedAt,
    updatedAt: pausedAt,
  }
}

export type ResumePausedPartyResult = {
  party: IPartyData
  resumedPauseMs: number
  shouldAutoEnd: boolean
}

/**
 * 回到前台时结算本次暂停：清除 pausedAt，并把本次暂停累加到 pausedDurationMs。
 * shouldAutoEnd 只依据真实累计暂停时长判断，不会把前台活动时长计入阈值。
 */
export function resumePausedParty(
  party: IPartyData,
  now = Date.now(),
  thresholdMs = PARTY_AUTO_END_PAUSE_THRESHOLD_MS,
): ResumePausedPartyResult {
  const pausedAtMs = toTimestamp(party.pausedAt)
  if (!pausedAtMs) {
    return {
      party,
      resumedPauseMs: 0,
      shouldAutoEnd: false,
    }
  }

  const resumedPauseMs = Math.max(now - pausedAtMs, 0)
  const pausedDurationMs = normalizePausedDuration(party.pausedDurationMs) + resumedPauseMs
  const resumedAt = new Date(now).toISOString()
  const resumedParty: IPartyData = {
    ...party,
    pausedDurationMs,
    updatedAt: resumedAt,
  }
  delete resumedParty.pausedAt

  return {
    party: resumedParty,
    resumedPauseMs,
    shouldAutoEnd: pausedDurationMs > thresholdMs,
  }
}

/**
 * 计算真实活动时长：总跨度减去已结算暂停，以及仍处于暂停态时的当前暂停片段。
 * referenceTime 可传结束时间，确保历史记录、实时总览和云端统计得到相同结果。
 */
export function getPartyElapsedMs(party: Pick<IPartyData,
  'startTime' | 'createdAt' | 'pausedAt' | 'pausedDurationMs'
>, referenceTime = Date.now()): number {
  const startTime = Number(party.startTime || toTimestamp(party.createdAt) || 0)
  if (!startTime) return 0

  let pausedDurationMs = normalizePausedDuration(party.pausedDurationMs)
  const pausedAtMs = toTimestamp(party.pausedAt)
  if (pausedAtMs) {
    pausedDurationMs += Math.max(referenceTime - pausedAtMs, 0)
  }
  return Math.max(referenceTime - startTime - pausedDurationMs, 0)
}
