/** Run fn over items with at most `limit` in flight; unfinished items become { error } past `deadlineAt`. */
export const mapLimit = async (items, limit, fn, { deadlineAt = Infinity } = {}) => {
  const results = new Array(items.length);
  if (!items.length) return results;
  let next = 0;
  let timer;
  const expired = new Error('budget exhausted');
  const stopAt = Number.isFinite(deadlineAt)
    ? new Promise((resolve) => {
        const ms = Math.max(0, deadlineAt - Date.now());
        if (ms === 0) resolve(expired);
        else timer = setTimeout(() => resolve(expired), ms);
      })
    : null;

  const worker = async () => {
    while (next < items.length && Date.now() < deadlineAt) {
      const i = next++;
      try {
        const job = Promise.resolve().then(() => fn(items[i], i));
        job.catch(() => {});
        const res = stopAt ? await Promise.race([job, stopAt]) : await job;
        if (res === expired) {
          results[i] = { error: expired };
          break;
        }
        results[i] = res;
      } catch (error) {
        results[i] = { error };
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  } finally {
    clearTimeout(timer);
  }
  for (let i = 0; i < results.length; i++) if (results[i] === undefined) results[i] = { error: expired };
  return results;
};
