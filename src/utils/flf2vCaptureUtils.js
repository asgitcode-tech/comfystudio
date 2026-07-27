// Capture utilities specifically for the FLF2V (First-Last-Frame-to-Video)
// "Fill Gap" timeline action.
//
// These are deliberately separate from utils/captureTimelineFrame.js (which
// composes the full timeline through the live preview bridge) for three
// reasons:
//
//   1. Gap-boundary capture must seek INSIDE the source clip's
//      [start, start+duration] range. Composing the full timeline at
//      firstFrameTime = gap.endTime + eps returns zero active clips
//      (no clip is at that time) — the original bug that broke gap fill
//      #2 in the ComfyStudio version.
//
//   2. We want each neighbor clip rendered alone, not under effects /
//      transforms from later comp layers.
//
//   3. Chromium has no H.265/AV1 decoder on Linux. The fallback path
//      hands the source file path to ffmpeg-static via IPC and resolves
//      to a PNG the renderer can load.

// Stores
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'

/**
 * Encode a file:// URL so a media element can decode it.
 * Filenames with non-ASCII characters produce raw srcs the browser
 * refuses silently. Percent-encode each path segment.
 */
export function encodeFileUrl(url) {
  if (!url || typeof url !== 'string') return url
  if (!url.startsWith('file://')) return url
  const rest = url.slice('file://'.length)
  const parts = rest.split('/').map((seg) => {
    try {
      return encodeURIComponent(decodeURIComponent(seg))
    } catch (_) {
      return seg
    }
  })
  return 'file://' + parts.join('/')
}

/**
 * Inverse of encodeFileUrl — turn a file:// URL back into an absolute
 * filesystem path. Used so we can hand a real path to ffmpeg-static via
 * IPC for the HEVC/unsupported-codec fallback.
 */
export function filePathFromFileUrl(url) {
  if (!url || typeof url !== 'string') return null
  if (!url.startsWith('file://')) return null
  const rest = url.slice('file://'.length)
  return '/' + rest.split('/').map((seg) => {
    try { return decodeURIComponent(seg) } catch (_) { return seg }
  }).join('/')
}

/**
 * Find the clip + track entries immediately before / after a gap on a
 * given track. `gap = { trackId, startTime, endTime }`.
 * Returns { before: {clip, track}|null, after: {clip, track}|null }.
 */
export function getGapNeighborClips(gap) {
  if (!gap || !gap.trackId) return { before: null, after: null }
  const state = useTimelineStore.getState()
  if (!state || !Array.isArray(state.clips)) return { before: null, after: null }
  const track = (state.tracks || []).find((t) => t && t.id === gap.trackId) || null
  if (!track) return { before: null, after: null }
  const trackClips = state.clips
    .filter((c) => c && c.trackId === gap.trackId)
    .sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
  // The clip whose endTime equals gap.startTime (within 1e-3) is the
  // "before" neighbour; the clip whose startTime equals gap.endTime is
  // the "after" neighbour. Fall back to the closest one if exact
  // matches don't line up.
  let before = null
  let after = null
  let bestBeforeDiff = Infinity
  let bestAfterDiff = Infinity
  for (const c of trackClips) {
    const cEnd = (c.startTime || 0) + (c.duration || 0)
    if (cEnd <= gap.startTime + 1e-3) {
      const diff = gap.startTime - cEnd
      if (diff < bestBeforeDiff) {
        bestBeforeDiff = diff
        before = c
      }
    }
    if ((c.startTime || 0) >= gap.endTime - 1e-3) {
      const diff = (c.startTime || 0) - gap.endTime
      if (diff < bestAfterDiff) {
        bestAfterDiff = diff
        after = c
      }
    }
  }
  return {
    before: before ? { clip: before, track } : null,
    after: after ? { clip: after, track } : null,
  }
}

/**
 * Render a single clip's source frame at a given timeline time to a
 * canvas. The clip MUST be the only thing drawn — no compositing.
 * Returns { element, width, height, cleanup } | null.
 *
 * For images: loads via Image element. For videos: seeks a headless
 * <video> to the correct source time. Falls back to ffmpeg-static via
 * IPC if Chromium refuses the codec (HEVC / AV1 / etc.).
 */
async function loadSingleClipSource(clip, asset, time) {
  if (!clip || !asset) return null
  const src = asset.url
  if (!src) return null

  // Compute the source time inside the clip.
  const clipStart = Number(clip.startTime) || 0
  const baseScale = clip.sourceTimeScale || (clip.timelineFps && clip.sourceFps
    ? clip.timelineFps / clip.sourceFps
    : 1)
  const speed = Number(clip.speed)
  const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
  const timeScale = baseScale * speedScale
  const trimStart = Number(clip.trimStart) || 0
  const trimEnd = Number.isFinite(Number(clip.trimEnd))
    ? Number(clip.trimEnd)
    : trimStart + (Number(clip.duration) || 0) * timeScale
  const reverse = !!clip.reverse
  const maxSrc = Number.isFinite(Number(clip.sourceDuration))
    ? Number(clip.sourceDuration)
    : trimEnd
  const rawSrcTime = reverse
    ? trimEnd - (time - clipStart) * timeScale
    : trimStart + (time - clipStart) * timeScale
  const sourceTime = Math.max(0, Math.min(rawSrcTime, Math.max(0, maxSrc - 0.001)))

  if (clip.type === 'image') {
    const playableSrc = encodeFileUrl(src)
    let blobUrl = null
    if (src.startsWith('file://') || src.startsWith('blob:')) {
      try {
        const resp = await fetch(src)
        if (resp.ok) {
          const blob = await resp.blob()
          blobUrl = URL.createObjectURL(blob)
        }
      } catch (_) { /* fall through */ }
    }
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('image load failed'))
      el.src = blobUrl || playableSrc
    })
    return {
      element: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      cleanup: () => { if (blobUrl) try { URL.revokeObjectURL(blobUrl) } catch (_) {} },
    }
  }

  if (clip.type === 'video') {
    // Prefer fetching a blob URL — Chromium silently rejects file://
    // paths with non-ASCII chars, and even with percent-encoding can
    // still fail for some sources.
    let playableSrc = encodeFileUrl(src)
    let blobUrl = null
    if (src.startsWith('file://') || src.startsWith('blob:')) {
      try {
        const resp = await fetch(src)
        if (resp.ok) {
          const blob = await resp.blob()
          blobUrl = URL.createObjectURL(blob)
          playableSrc = blobUrl
        }
      } catch (_) { /* fall through */ }
    }
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.src = playableSrc
    try {
      await new Promise((resolve, reject) => {
        let settled = false
        const finish = (ok, err) => {
          if (settled) return
          settled = true
          ok ? resolve() : reject(err)
        }
        video.onloadedmetadata = () => {
          try {
            video.currentTime = Math.min(sourceTime, Math.max(0, (video.duration || 0) - 0.01))
          } catch (err) { finish(false, err) }
        }
        video.onseeked = () => finish(true)
        video.onerror = () => {
          finish(false, new Error(
            video.error?.message || `video decode failed (code=${video.error?.code})`
          ))
        }
        setTimeout(() => finish(false, new Error('video seek timeout')), 8000)
      })
      return {
        element: video,
        width: video.videoWidth,
        height: video.videoHeight,
        cleanup: () => {
          try { video.removeAttribute('src'); video.load() } catch (_) {}
          if (blobUrl) try { URL.revokeObjectURL(blobUrl) } catch (_) {}
        },
      }
    } catch (err) {
      // Cleanup the failed video before trying IPC fallback.
      if (blobUrl) try { URL.revokeObjectURL(blobUrl) } catch (_) {}
      try { video.removeAttribute('src'); video.load() } catch (_) {}

      // ffmpeg IPC fallback for codecs Chromium can't decode.
      const code = video.error?.code
      const errMsg = String(video.error?.message || err?.message || '')
      const isUnsupported = code === 4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */
        || code === 3 /* MEDIA_ERR_DECODE */
        || /DEMUXER_ERROR|no supported streams/i.test(errMsg)
      if (!isUnsupported) throw err
      if (!window.electronAPI?.extractVideoFrame) return null

      let filePath = src.startsWith('file://') ? filePathFromFileUrl(src) : null
      if (!filePath && asset.absolutePath) filePath = asset.absolutePath
      if (!filePath) return null

      const projectState = useProjectStore.getState?.()
      const settings = projectState?.getCurrentTimelineSettings?.()
        || projectState?.currentProject?.settings || {}
      const ipcWidth = Math.max(16, Math.min(7680, Number(settings.width) || 1920))
      const ipcHeight = Math.max(16, Math.min(4320, Number(settings.height) || 1080))

      try {
        const ipcResult = await window.electronAPI.extractVideoFrame({
          filePath,
          timeSeconds: sourceTime,
          width: ipcWidth,
          height: ipcHeight,
        })
        if (!ipcResult?.success || !ipcResult.data) return null
        const pngBlob = new Blob([ipcResult.data], { type: 'image/png' })
        const pngUrl = URL.createObjectURL(pngBlob)
        const img = await new Promise((resolve, reject) => {
          const el = new Image()
          el.onload = () => resolve(el)
          el.onerror = () => reject(new Error('ffmpeg frame load failed'))
          el.src = pngUrl
        })
        return {
          element: img,
          width: img.naturalWidth,
          height: img.naturalHeight,
          cleanup: () => { try { URL.revokeObjectURL(pngUrl) } catch (_) {} },
        }
      } catch (_) {
        return null
      }
    }
  }
  return null
}

/**
 * Capture one frame from a single clip at a timeline time. Returns
 * { blobUrl, file, width, height } | null.
 */
export async function captureSingleClipFrame(clip, asset, time) {
  if (!clip || !asset?.url) return null
  const projectState = useProjectStore.getState?.()
  const settings = projectState?.getCurrentTimelineSettings?.()
    || projectState?.currentProject?.settings || {}
  const width = Math.max(16, Math.min(7680, Number(settings.width) || 1920))
  const height = Math.max(16, Math.min(4320, Number(settings.height) || 1080))

  const loaded = await loadSingleClipSource(clip, asset, time)
  if (!loaded?.element) return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return null
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(loaded.element, 0, 0, width, height)
    const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
    if (!blob) return null
    const file = new File([blob], `flf2v_frame_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`, { type: 'image/png' })
    const blobUrl = URL.createObjectURL(blob)
    return {
      blobUrl,
      file,
      width: loaded.width || width,
      height: loaded.height || height,
    }
  } finally {
    try { loaded.cleanup?.() } catch (_) {}
  }
}

/**
 * Capture the last frame of the before-clip and the first frame of the
 * after-clip for an FLF2V gap fill. Seeks INSIDE each clip's range so
 * we never depend on the timeline composite returning a clip past its
 * edge.
 *
 * gap = { trackId, startTime, endTime }
 * Returns { start: {blobUrl,file,width,height} | null, end: same }.
 */
export async function captureGapBoundaryFrames(gap) {
  if (!gap) return { start: null, end: null }
  const { before, after } = getGapNeighborClips(gap)
  const fps = Math.max(
    1,
    Number(before?.clip?.timelineFps) || Number(after?.clip?.timelineFps) || 24
  )
  const eps = 1 / fps

  const assetsState = useAssetsStore.getState()
  let start = null
  let end = null

  if (before?.clip) {
    const asset = assetsState?.getAssetById?.(before.clip.assetId)
    if (asset?.url) {
      const cStart = Number(before.clip.startTime) || 0
      const cDur = Number(before.clip.duration) || 0
      // Last frame of the clip — but never earlier than the clip's
      // start edge (defends against zero/negative-duration edge case).
      const t = Math.max(cStart + eps, cStart + cDur - eps)
      start = await captureSingleClipFrame(before.clip, asset, t)
    }
  }

  if (after?.clip) {
    const asset = assetsState?.getAssetById?.(after.clip.assetId)
    if (asset?.url) {
      const cStart = Number(after.clip.startTime) || 0
      const t = cStart + eps
      end = await captureSingleClipFrame(after.clip, asset, t)
    }
  }

  return { start, end }
}
