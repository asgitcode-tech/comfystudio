import { create } from 'zustand'

/**
 * Store for "frame from timeline" sent to Generate tab for AI extend/keyframe
 * (single frame), or for the FLF2V "Fill Gap" timeline action (two frames).
 *
 * Shapes:
 *   Single-frame: { blobUrl, file, mode: 'extend'|'keyframe' }
 *   FLF2V: {
 *     mode: 'flf2v',
 *     startFrame: { blobUrl, file, width, height },
 *     endFrame:   { blobUrl, file, width, height },
 *     targetDurationSeconds,   // gap length (informational; the FLF2V
 *                              // card decides its own form values)
 *     targetTrackId,           // for gap-result splicing
 *     targetGapStartTime,      // for gap-result splicing
 *   }
 *
 * The FLF2V card (src/components/Flf2vDraftCard.jsx) reads this store
 * directly via useFrameForAIStore.getState() and handles its own submit /
 * poll / splice flow; no other consumer needs to inspect the flf2v shape.
 */
function revokeSafely(url) {
  if (!url) return
  try { URL.revokeObjectURL(url) } catch (_) { /* ignore */ }
}

function revokeFrame(frame) {
  if (!frame) return
  if (typeof frame === 'string') {
    revokeSafely(frame)
    return
  }
  revokeSafely(frame.blobUrl)
}

export const useFrameForAIStore = create((set) => ({
  frame: null,

  setFrame: (frame) => {
    set({ frame })
  },

  clearFrame: () => {
    set((state) => {
      const f = state.frame
      if (!f) return { frame: null }
      if (f.mode === 'flf2v') {
        revokeFrame(f.startFrame)
        revokeFrame(f.endFrame)
      } else {
        revokeFrame(f)
      }
      return { frame: null }
    })
  },
}))
