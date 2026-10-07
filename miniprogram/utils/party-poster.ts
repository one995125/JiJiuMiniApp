import {
  BADGE_DEFINITIONS,
  PartyOverviewData,
  PartyOverviewRankGroup,
} from './party-overview'

const POSTER_WIDTH = 750
const POSTER_HEIGHT = 1334
const BRAND_ORANGE = '#E9921B'
const BRAND_ORANGE_LIGHT = '#FFF3DD'
const INK = '#20242E'
const MUTED = '#747781'
const RED = '#D94A52'
const GREEN = '#12A876'

type PosterCanvas = WechatMiniprogram.Canvas
type PosterContext = any

export type PartyPosterOptions = {
  canvas: PosterCanvas
  scope: WechatMiniprogram.Component.TrivialInstance
  dpr: number
  party: IPartyData
  overview: PartyOverviewData
  /** 已确认的小程序码资源；加载失败会降级为保留位，不阻断整张图导出。 */
  miniProgramCodePath?: string
}

type PosterRankRow = {
  rank: number
  name: string
  color: string
  badges: string
  shu: string
  he: string
  qian: string
}

function roundedRect(
  ctx: PosterContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function fillRoundedRect(
  ctx: PosterContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: string,
): void {
  ctx.fillStyle = color
  roundedRect(ctx, x, y, width, height, radius)
  ctx.fill()
}

function setFont(ctx: PosterContext, size: number, weight = 400): void {
  ctx.font = `${weight} ${size}px sans-serif`
  ctx.textBaseline = 'middle'
}

function fitText(ctx: PosterContext, value: string, maxWidth: number): string {
  if (ctx.measureText(value).width <= maxWidth) return value
  let output = value
  while (output.length > 1 && ctx.measureText(`${output}…`).width > maxWidth) {
    output = output.slice(0, -1)
  }
  return `${output}…`
}

function formatPartyDate(party: IPartyData): string {
  const time = Number(party.startTime || Date.parse(party.createdAt) || Date.now())
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}  ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function getBadgeNames(player: PartyOverviewRankGroup['players'][number]): string {
  const badges = BADGE_DEFINITIONS
    .filter(definition => !!player[definition.flag])
    .map(definition => definition.name)
  return badges.length > 0 ? badges.join(' · ') : 'NPC'
}

function buildRows(overview: PartyOverviewData): PosterRankRow[] {
  return overview.rankingTierGroups.map((group, index) => {
    const player = group.players[0]
    return {
      rank: index + 1,
      name: player.name,
      color: player.color,
      badges: getBadgeNames(player),
      shu: group.shuPart,
      he: group.hePart,
      qian: group.qianPart,
    }
  })
}

function drawAvatar(
  ctx: PosterContext,
  x: number,
  y: number,
  radius: number,
  color: string,
  name: string,
): void {
  ctx.beginPath()
  ctx.fillStyle = color || BRAND_ORANGE
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#FFFFFF'
  setFont(ctx, Math.max(radius * 0.9, 18), 700)
  ctx.textAlign = 'center'
  ctx.fillText((name || '?').slice(0, 1), x, y + 1)
}

function drawSingleColumnRows(
  ctx: PosterContext,
  rows: PosterRankRow[],
  top: number,
  height: number,
): void {
  const rowHeight = Math.min(76, height / Math.max(rows.length, 1))
  rows.forEach((row, index) => {
    const y = top + index * rowHeight
    if (index > 0) {
      ctx.strokeStyle = '#EEF0F4'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(54, y)
      ctx.lineTo(696, y)
      ctx.stroke()
    }

    ctx.fillStyle = index < 3 ? BRAND_ORANGE : '#A6ABB6'
    setFont(ctx, 24, 700)
    ctx.textAlign = 'center'
    ctx.fillText(String(row.rank), 72, y + rowHeight / 2)
    drawAvatar(ctx, 116, y + rowHeight / 2, 23, row.color, row.name)

    ctx.fillStyle = INK
    setFont(ctx, 25, 700)
    ctx.textAlign = 'left'
    ctx.fillText(fitText(ctx, row.name, 112), 153, y + rowHeight * 0.36)
    ctx.fillStyle = MUTED
    setFont(ctx, 16, 400)
    ctx.fillText(fitText(ctx, row.badges, 138), 153, y + rowHeight * 0.7)

    const metricY = y + rowHeight / 2
    const metrics = [
      {x: 355, value: row.shu, color: BRAND_ORANGE},
      {x: 492, value: row.he, color: GREEN},
      {x: 630, value: row.qian, color: RED},
    ]
    metrics.forEach(metric => {
      ctx.fillStyle = metric.color
      setFont(ctx, 21, 700)
      ctx.textAlign = 'center'
      ctx.fillText(metric.value, metric.x, metricY)
    })
  })
}

function drawDoubleColumnRows(
  ctx: PosterContext,
  rows: PosterRankRow[],
  top: number,
  height: number,
): void {
  const perColumn = Math.ceil(rows.length / 2)
  const rowHeight = height / Math.max(perColumn, 1)
  rows.forEach((row, index) => {
    const column = Math.floor(index / perColumn)
    const rowIndex = index % perColumn
    const x = 42 + column * 342
    const y = top + rowIndex * rowHeight

    if (rowIndex > 0) {
      ctx.strokeStyle = '#EEF0F4'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x + 8, y)
      ctx.lineTo(x + 326, y)
      ctx.stroke()
    }
    if (column === 1 && rowIndex === 0) {
      ctx.strokeStyle = '#E4E7EC'
      ctx.beginPath()
      ctx.moveTo(375, top + 4)
      ctx.lineTo(375, top + height - 4)
      ctx.stroke()
    }

    ctx.fillStyle = row.rank <= 3 ? BRAND_ORANGE : '#A6ABB6'
    setFont(ctx, 18, 700)
    ctx.textAlign = 'center'
    ctx.fillText(String(row.rank), x + 20, y + rowHeight / 2)
    drawAvatar(ctx, x + 52, y + rowHeight / 2, 18, row.color, row.name)

    ctx.fillStyle = INK
    setFont(ctx, 20, 700)
    ctx.textAlign = 'left'
    ctx.fillText(fitText(ctx, row.name, 90), x + 80, y + rowHeight * 0.34)
    ctx.fillStyle = MUTED
    setFont(ctx, 13, 400)
    ctx.fillText(fitText(ctx, row.badges, 100), x + 80, y + rowHeight * 0.68)

    const metrics = [
      {x: x + 198, value: row.shu, color: BRAND_ORANGE},
      {x: x + 258, value: row.he, color: GREEN},
      {x: x + 316, value: row.qian, color: RED},
    ]
    metrics.forEach(metric => {
      ctx.fillStyle = metric.color
      setFont(ctx, 14, 700)
      ctx.textAlign = 'center'
      ctx.fillText(metric.value, metric.x, y + rowHeight / 2)
    })
  })
}

function loadCanvasImage(canvas: PosterCanvas, src: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = src
  })
}

async function drawFooterCode(
  ctx: PosterContext,
  canvas: PosterCanvas,
  miniProgramCodePath?: string,
): Promise<void> {
  const codeX = 568
  const codeY = 1192
  const codeSize = 92
  fillRoundedRect(ctx, codeX - 7, codeY - 7, codeSize + 14, codeSize + 14, 16, '#FFFFFF')
  if (miniProgramCodePath) {
    try {
      const codeImage = await loadCanvasImage(canvas, miniProgramCodePath)
      ctx.drawImage(codeImage, codeX, codeY, codeSize, codeSize)
      return
    } catch (err) {
      console.warn('[party poster] mini program code load failed', err)
    }
  }

  // TODO: 若后续更换正式渠道小程序码，在调用方传入资源路径即可替换此保留位。
  ctx.strokeStyle = '#D8DCE4'
  ctx.lineWidth = 2
  ctx.setLineDash([6, 6])
  roundedRect(ctx, codeX, codeY, codeSize, codeSize, 12)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = MUTED
  setFont(ctx, 14, 400)
  ctx.textAlign = 'center'
  ctx.fillText('小程序码', codeX + codeSize / 2, codeY + codeSize / 2)
}

function exportCanvas(
  canvas: PosterCanvas,
  scope: WechatMiniprogram.Component.TrivialInstance,
  dpr: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      destWidth: Math.round(POSTER_WIDTH * dpr),
      destHeight: Math.round(POSTER_HEIGHT * dpr),
      fileType: 'png',
      quality: 1,
      success: result => resolve(result.tempFilePath),
      fail: reject,
    }, scope)
  })
}

/**
 * 使用 Canvas 2D 绘制并导出战绩长图。
 * 画布以 750×1334 逻辑像素排版，实际 backing store 与导出尺寸按 DPR 放大。
 */
export async function generatePartyPoster(options: PartyPosterOptions): Promise<string> {
  const { canvas, scope, party, overview } = options
  const dpr = Math.min(Math.max(Number(options.dpr) || 1, 1), 3)
  canvas.width = Math.round(POSTER_WIDTH * dpr)
  canvas.height = Math.round(POSTER_HEIGHT * dpr)
  const ctx = canvas.getContext('2d') as PosterContext
  if (!ctx) throw new Error('CANVAS_CONTEXT_UNAVAILABLE')
  ctx.scale(dpr, dpr)

  const background = ctx.createLinearGradient(0, 0, POSTER_WIDTH, POSTER_HEIGHT)
  background.addColorStop(0, '#FFF9EF')
  background.addColorStop(0.55, '#F7F5F0')
  background.addColorStop(1, '#FFE4B2')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT)

  ctx.fillStyle = 'rgba(233,146,27,.12)'
  ctx.beginPath()
  ctx.arc(690, 40, 170, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(30, 1120, 130, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = INK
  setFont(ctx, 54, 700)
  ctx.textAlign = 'left'
  ctx.fillText('本场战绩', 46, 72)
  ctx.fillStyle = BRAND_ORANGE
  setFont(ctx, 24, 700)
  ctx.fillText(`${party.players.length} 人聚会 · ${party.settings.unit}制`, 48, 124)
  ctx.fillStyle = MUTED
  setFont(ctx, 20, 400)
  ctx.fillText(formatPartyDate(party), 48, 160)

  fillRoundedRect(ctx, 38, 198, 674, 252, 34, '#FFFFFF')
  ctx.shadowColor = 'rgba(32,36,46,.10)'
  ctx.shadowBlur = 28
  ctx.shadowOffsetY = 10
  ctx.fillStyle = '#FFFFFF'
  roundedRect(ctx, 38, 198, 674, 252, 34)
  ctx.fill()
  ctx.shadowColor = 'transparent'

  const hero = overview.debtChampionHero
  if (hero) {
    fillRoundedRect(ctx, 64, 222, 162, 40, 20, BRAND_ORANGE_LIGHT)
    ctx.fillStyle = BRAND_ORANGE
    setFont(ctx, 20, 700)
    ctx.textAlign = 'center'
    ctx.fillText('本场欠数最多', 145, 242)
    drawAvatar(ctx, 145, 338, 58, hero.color, hero.name)

    ctx.fillStyle = INK
    setFont(ctx, 38, 700)
    ctx.textAlign = 'left'
    ctx.fillText(fitText(ctx, hero.name, 250), 264, 278)
    ctx.fillStyle = RED
    setFont(ctx, 30, 700)
    ctx.fillText(fitText(ctx, `养鱼达人 · 欠 ${hero.debtUnits}${party.settings.unit}`, 402), 264, 330)
    ctx.fillStyle = MUTED
    setFont(ctx, 20, 400)
    ctx.fillText('谁输多少、完成多少，一眼看清', 264, 382)
  } else {
    ctx.fillStyle = MUTED
    setFont(ctx, 28, 700)
    ctx.textAlign = 'center'
    ctx.fillText('本场暂无可展示战绩', POSTER_WIDTH / 2, 324)
  }

  fillRoundedRect(ctx, 38, 474, 674, 656, 34, '#FFFFFF')
  ctx.fillStyle = INK
  setFont(ctx, 30, 700)
  ctx.textAlign = 'left'
  ctx.fillText('参与者排名', 62, 520)
  ctx.fillStyle = MUTED
  setFont(ctx, 16, 400)
  ctx.textAlign = 'right'
  ctx.fillText('输 / 喝 / 欠均为真实记录', 684, 520)

  const rows = buildRows(overview)
  if (rows.length <= 10) {
    drawSingleColumnRows(ctx, rows, 552, 548)
  } else {
    drawDoubleColumnRows(ctx, rows, 552, 548)
  }

  ctx.fillStyle = INK
  setFont(ctx, 28, 700)
  ctx.textAlign = 'left'
  ctx.fillText('记酒小程序', 58, 1206)
  ctx.fillStyle = MUTED
  setFont(ctx, 18, 400)
  ctx.fillText('公平记账 · 清楚对账', 58, 1246)
  await drawFooterCode(ctx, canvas, options.miniProgramCodePath)

  ctx.fillStyle = '#5C606A'
  setFont(ctx, 18, 400)
  ctx.textAlign = 'center'
  ctx.fillText('理性娱乐 · 可用饮料或积分替代 · 饮酒勿驾车', POSTER_WIDTH / 2, 1302)

  await new Promise<void>(resolve => canvas.requestAnimationFrame(() => resolve()))
  return exportCanvas(canvas, scope, dpr)
}
