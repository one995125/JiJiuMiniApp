Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  properties: {
    visible: {
      type: Boolean,
      value: false,
    },
    darkMode: {
      type: Boolean,
      value: false,
    },
    /**
     * 当前展示的称号提醒内容。
     * 页面负责生成文案和显示时长，组件只做非阻塞视觉呈现。
     */
    notice: {
      type: Object,
      value: {
        title: '',
        badgeId: 'default',
        badgeName: '',
        icon: '奖',
        color: '#E9921B',
      },
    },
  },
})
