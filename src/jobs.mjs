// Scheduling: at most `max` sessions working at once across the org, and one request at a time
// per session key (its box, checkout and Codex session are shared state); FIFO otherwise.
export function scheduler(max) {
  let active = 0
  const waiting = []
  const tails = new Map() // session key → promise of its latest job

  const acquire = () =>
    new Promise((resolve) => {
      if (active < max) {
        active++
        resolve()
      } else waiting.push(resolve)
    })
  const release = () => {
    const next = waiting.shift()
    if (next) next() // hand the slot straight over
    else active--
  }

  return function schedule(key, task) {
    const job = (tails.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await acquire()
        try {
          return await task()
        } finally {
          release()
        }
      })
    tails.set(key, job)
    job.catch(() => {}).finally(() => {
      if (tails.get(key) === job) tails.delete(key)
    })
    return job
  }
}
