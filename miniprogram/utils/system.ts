/**
 * 首屏渲染后再校准状态栏高度。
 * 这样页面 attached 阶段不再为了导航栏高度调用同步系统信息 API，减少启动线程阻塞。
 */
export function deferStatusBarHeightUpdate(
  owner: { setData(updates: Record<string, any>): void },
  fallbackHeight: number,
): void {
  setTimeout(() => {
    const getWindowInfo = (wx as any).getWindowInfo
    if (getWindowInfo) {
      const windowInfo = getWindowInfo()
      owner.setData({ statusBarHeight: windowInfo.statusBarHeight || fallbackHeight })
      return
    }

    wx.getSystemInfo({
      success: res => {
        owner.setData({ statusBarHeight: res.statusBarHeight || fallbackHeight })
      },
    })
  }, 0)
}

/**
 * 首屏渲染后读取微信右上角胶囊位置，并返回胶囊下方的安全起点。
 *
 * 适用场景：自定义导航栏页面的首行内容需要占满横向空间，不能只按状态栏
 * 高度留白，否则反馈、主题切换等按钮会被系统胶囊覆盖。
 */
export function deferMenuButtonSafeTopUpdate(
  owner: { setData(updates: Record<string, any>): void },
  fallbackTop: number,
  gap = 8,
): void {
  setTimeout(() => {
    try {
      const getMenuRect = (wx as any).getMenuButtonBoundingClientRect
      const rect = typeof getMenuRect === 'function' ? getMenuRect() : null
      if (rect?.bottom && rect.bottom > 0) {
        owner.setData({ headerSafeTop: Math.ceil(rect.bottom + gap) })
        return
      }
    } catch (err) {
      console.warn('[system] failed to read menu button rect', err)
    }

    owner.setData({ headerSafeTop: fallbackTop })
  }, 0)
}
