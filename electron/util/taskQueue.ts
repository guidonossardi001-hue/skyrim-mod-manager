// Bounded-concurrency task queue (semaphore). Runs at most `concurrency` async tasks at once;
// excess tasks wait in FIFO order and start as slots free. Resilient: a task that rejects frees
// its slot and lets the next one run — one failure never blocks or drops the rest of the queue.
// Electron-free & side-effect-free (state changes are reported via the injected onState hook) so
// the cap and the queued→running transitions are unit-testable in isolation.

export type TaskState = 'queued' | 'running'

export interface TaskQueueOptions {
  concurrency: number
  // Fired when a task's state changes: 'queued' ONLY when it actually has to wait for a slot,
  // 'running' the moment it acquires one. A task that starts immediately never reports 'queued'.
  onState?: (id: number, state: TaskState) => void
}

export class TaskQueue {
  private active = 0
  private readonly pending: Array<() => void> = []
  private readonly cap: number

  constructor(private readonly opts: TaskQueueOptions) {
    this.cap = Math.max(1, Math.floor(opts.concurrency) || 1)
  }

  /** Enqueue a task. Resolves/rejects with the task's own result; the slot is always freed. */
  enqueue<T>(id: number, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.active++
        this.opts.onState?.(id, 'running')
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.active--
            this.next()
          })
      }
      if (this.active < this.cap) {
        run()
      } else {
        this.opts.onState?.(id, 'queued')
        this.pending.push(run)
      }
    })
  }

  private next(): void {
    if (this.active < this.cap && this.pending.length > 0) {
      const run = this.pending.shift()!
      run()
    }
  }

  /** Number of tasks currently executing. */
  get running(): number {
    return this.active
  }
  /** Number of tasks waiting for a slot. */
  get waiting(): number {
    return this.pending.length
  }
  get concurrency(): number {
    return this.cap
  }
}
