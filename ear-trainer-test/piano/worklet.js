// Bastard Piano: wyjscie silnika w AudioWorklet. Silnik liczy w Web Workerze (src/audio/bastardPianoWorker.ts) z wyprzedzeniem
// i przysyla kawalki PCM z numerem pierwszej ramki; tu tylko sie je odtwarza w zegarze kontekstu (zero liczenia w watku audio).
const FADE = 576 // 12 ms at 48 kHz
const FADE_IN = 96 // 2 ms: the start of a chunk that came late
const DECLICK = 144 // 3 ms
const QUIET = 1e-4
const JUMP = 0.004
class BastardPianoProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.wp = null
    this.tick = 0
    // 12 Nov: declick. A sound that begins out of silence with a large first sample (a chunk that reached the worklet with the
    // start of its note cut off) was a click; it is faded in over DECLICK frames. A normal note starts at ~0.001 and is untouched.
    this.prev = 0
    this.ramp = 0
    this.port.onmessage = (e) => {
      const m = e.data
      if (m && m.port) {
        this.wp = m.port
        this.queue.length = 0
        this.wp.onmessage = (ev) => {
          const c = ev.data
          if (c.stop) {
            // not a hard cut (a click): what is already queued fades out over FADE frames from the playhead
            const from = currentFrame
            const cut = from + FADE
            for (const q of this.queue) {
              if (q.cut === undefined || q.cut > cut) {
                q.cut = cut
                q.fadeFrom = from
              }
            }
          } else {
            // s4 (11.11): a chunk that comes after its start lost its beginning; tell the worker to render further ahead,
            // and fade the rest in instead of starting mid-wave (a click)
            if (c.start < currentFrame) {
              c.fadeIn = currentFrame
              this.wp.postMessage({ late: currentFrame - c.start })
            } else if (c.fade) c.fadeIn = c.start
            this.queue.push(c)
          }
        }
      }
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0]
    const L = out[0]
    const R = out[1] || out[0]
    const n = L.length
    const frame = currentFrame
    L.fill(0)
    if (R !== L) R.fill(0)
    const q = this.queue
    while (q.length && q[0].start + q[0].n <= frame) q.shift()
    for (let i = 0; i < q.length; i++) {
      const c = q[i]
      if (c.start >= frame + n) break
      const from = Math.max(frame, c.start)
      const to = Math.min(frame + n, c.start + c.n)
      for (let f = from; f < to; f++) {
        let g = 1
        if (c.fadeIn !== undefined && f < c.fadeIn + FADE_IN) g = Math.max(0, (f - c.fadeIn) / FADE_IN)
        if (c.cut !== undefined) {
          if (f >= c.cut) break
          if (f > c.fadeFrom) g *= (c.cut - f) / (c.cut - c.fadeFrom)
        }
        const k = f - c.start
        L[f - frame] += c.data[k] * g
        if (R !== L) R[f - frame] += c.data[c.n + k] * g
      }
    }
    for (let i = 0; i < n; i++) {
      const m = Math.max(Math.abs(L[i]), R !== L ? Math.abs(R[i]) : 0)
      if (this.ramp === 0 && this.prev < QUIET && m > JUMP) this.ramp = DECLICK
      if (this.ramp > 0) {
        const g = 1 - this.ramp / DECLICK
        L[i] *= g
        if (R !== L) R[i] *= g
        this.ramp--
      }
      this.prev = m
    }
    if (this.wp && ++this.tick % 8 === 0) this.wp.postMessage({ frame: currentFrame })
    return true
  }
}
registerProcessor('bastard-piano', BastardPianoProcessor)
