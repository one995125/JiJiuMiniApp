Component({
  properties: {
    /** 用户姓名，用于生成文字头像首字。 */
    name: {
      type: String,
      value: '',
    },
    /** 头像底色，通常由页面按人员顺序分配。 */
    color: {
      type: String,
      value: '#E9921B',
    },
    /** 本地照片路径，仅总览冠军头像会传入。 */
    photoPath: {
      type: String,
      value: '',
    },
    /** 头像外径，单位 rpx。 */
    size: {
      type: Number,
      value: 72,
    },
    /** 暗色模式开关，由页面透传，避免组件自行读取全局状态。 */
    darkMode: {
      type: Boolean,
      value: false,
    },
    /** 是否带按压反馈；真正的点击逻辑仍由父级页面控制。 */
    interactive: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    initial: '?',
    fontSize: 30,
  },

  observers: {
    'name, size': function (name: string, size: number) {
      this.syncAvatarMeta(name, size)
    },
  },

  lifetimes: {
    attached() {
      this.syncAvatarMeta(this.data.name, this.data.size)
    },
  },

  methods: {
    /**
     * 根据姓名和头像尺寸派生展示文本，避免在 WXML 中写复杂表达式。
     * 组件被复用到不同尺寸时，字体按比例变化但设置上下限，防止单字过大或过小。
     */
    syncAvatarMeta(name: string, size: number) {
      const safeName = String(name || '').trim()
      const safeSize = Number(size) || 72
      const firstChar = safeName ? safeName.slice(0, 1) : '?'
      const fontSize = Math.max(24, Math.min(58, Math.round(safeSize * 0.42)))
      this.setData({
        initial: firstChar,
        fontSize,
      })
    },

    /**
     * 照片路径失效时通知父级页面清理缓存。
     */
    onImageError() {
      this.triggerEvent('imageerror')
    },
  },
})
