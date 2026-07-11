import { describe, it, expect } from 'vitest'
import { TaskQueue, type TaskState } from './taskQueue'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('TaskQueue', () => {
  it('never runs more than `concurrency` tasks at once; excess is queued', async () => {
    const q = new TaskQueue({ concurrency: 3 })
    const d = Array.from({ length: 5 }, () => deferred())
    d.forEach((x, i) => q.enqueue(i, () => x.promise))
    await tick()
    expect(q.running).toBe(3) // cap respected
    expect(q.waiting).toBe(2)
    d[0].resolve() // free one slot
    await tick()
    expect(q.running).toBe(3) // the 4th started
    expect(q.waiting).toBe(1)
    d[1].resolve()
    d[2].resolve()
    await tick()
    // freed 2 slots but only 1 task was pending (the 5th) → it starts, leaving 2 active (4th, 5th)
    expect(q.running).toBe(2)
    expect(q.waiting).toBe(0)
    // drain
    d[3].resolve()
    d[4].resolve()
    await tick()
    expect(q.running).toBe(0)
    expect(q.waiting).toBe(0)
  })

  it('reports queued ONLY for tasks that wait, and running when a slot is acquired', async () => {
    const states: Array<[number, TaskState]> = []
    const q = new TaskQueue({ concurrency: 2, onState: (id, s) => states.push([id, s]) })
    const d = Array.from({ length: 4 }, () => deferred())
    d.forEach((x, i) => q.enqueue(i, () => x.promise))
    await tick()
    // tasks 0,1 run immediately (only 'running'); 2,3 wait first ('queued' then 'running' later)
    expect(states).toEqual([
      [0, 'running'],
      [1, 'running'],
      [2, 'queued'],
      [3, 'queued'],
    ])
    d[0].resolve()
    await tick()
    expect(states).toContainEqual([2, 'running']) // slot freed → next promoted to running
  })

  it('a failing task frees its slot and does not block the queue (resilience)', async () => {
    const q = new TaskQueue({ concurrency: 1 })
    const results: string[] = []
    const boom = q.enqueue(1, () => Promise.reject(new Error('boom'))).catch((e) => results.push('rejected:' + (e as Error).message))
    const ok = q.enqueue(2, () => Promise.resolve('ok')).then((r) => results.push('resolved:' + r))
    await Promise.all([boom, ok])
    expect(results).toEqual(['rejected:boom', 'resolved:ok']) // 2nd ran after the 1st failed
    expect(q.running).toBe(0)
  })

  it('resolves each task with its own value', async () => {
    const q = new TaskQueue({ concurrency: 2 })
    const vals = await Promise.all([
      q.enqueue(1, async () => 'a'),
      q.enqueue(2, async () => 'b'),
      q.enqueue(3, async () => 'c'),
    ])
    expect(vals).toEqual(['a', 'b', 'c'])
  })

  it('clamps a bad concurrency to at least 1', () => {
    expect(new TaskQueue({ concurrency: 0 }).concurrency).toBe(1)
    expect(new TaskQueue({ concurrency: -5 }).concurrency).toBe(1)
    expect(new TaskQueue({ concurrency: 3.9 }).concurrency).toBe(3)
  })
})
