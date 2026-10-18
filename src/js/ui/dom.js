/**
 * Tiny element builder. Text always goes through textContent, so data from
 * upstream agencies can never inject markup.
 *
 *   h('button', { class: 'chip', onclick: fn, 'aria-pressed': 'true' }, 'Fire')
 */
export const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
};

const append = (el, children) => {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
};

/** Replace an element's children. */
export const mount = (el, ...children) => {
  el.replaceChildren();
  append(el, children);
  return el;
};

/** Only http(s) links from upstream data are rendered as links. */
export const safeUrl = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
};
