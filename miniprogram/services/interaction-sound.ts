type InteractionSoundType = 'tap' | 'count' | 'success'

const SOUND_CONFIG: Record<InteractionSoundType, {
  src: string
  volume: number
  minInterval: number
}> = {
  tap: {
    src: '/assets/audio/tap.wav',
    volume: 0.22,
    minInterval: 90,
  },
  count: {
    src: '/assets/audio/count.wav',
    volume: 0.24,
    minInterval: 120,
  },
  success: {
    src: '/assets/audio/success.wav',
    volume: 0.28,
    minInterval: 260,
  },
}

const contexts: Partial<Record<InteractionSoundType, WechatMiniprogram.InnerAudioContext>> = {}
const disabledTypes: Partial<Record<InteractionSoundType, boolean>> = {}
const lastPlayAt: Partial<Record<InteractionSoundType, number>> = {}

function getSoundContext(type: InteractionSoundType): WechatMiniprogram.InnerAudioContext | null {
  if (disabledTypes[type]) return null
  const cached = contexts[type]
  if (cached) return cached
  if (typeof wx.createInnerAudioContext !== 'function') return null

  const config = SOUND_CONFIG[type]
  const audio = wx.createInnerAudioContext()
  audio.src = config.src
  audio.volume = config.volume
  audio.obeyMuteSwitch = true
  audio.onError(err => {
    disabledTypes[type] = true
    console.warn('[interaction-sound] disabled', type, err)
  })
  contexts[type] = audio
  return audio
}

/**
 * 播放轻量交互音。
 * 注意：仅用于明确按钮反馈；输入框输入、后台保存、页面恢复等非按钮场景不调用，避免干扰用户。
 */
export function playInteractionSound(type: InteractionSoundType = 'tap'): void {
  const config = SOUND_CONFIG[type]
  const now = Date.now()
  if (now - (lastPlayAt[type] || 0) < config.minInterval) return

  const audio = getSoundContext(type)
  if (!audio) return

  lastPlayAt[type] = now
  try {
    /**
     * 不在播放前调用 stop/pause。
     * 微信开发者工具底层用浏览器 audio 模拟 InnerAudioContext，短时间内
     * stop() 后立刻 play() 会触发 “play request was interrupted by pause()”。
     * 交互音只做轻反馈：上一段还在播时跳过本次；已结束或暂停时再从头播放。
     */
    if (!audio.paused) return
    if (audio.currentTime > 0) audio.seek(0)
    audio.play()
  } catch (err) {
    disabledTypes[type] = true
    console.warn('[interaction-sound] play failed', type, err)
  }
}

/** 页面卸载时释放音频上下文，避免调试期间重复进入页面造成资源堆积。 */
export function destroyInteractionSounds(): void {
  ;(Object.keys(contexts) as InteractionSoundType[]).forEach(type => {
    const audio = contexts[type]
    if (!audio) return
    audio.destroy()
    delete contexts[type]
  })
}
