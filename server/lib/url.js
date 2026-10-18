/** Only http(s) URLs from upstream data are passed to clients. */
export const safeHttpUrl = (value) => {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
};
