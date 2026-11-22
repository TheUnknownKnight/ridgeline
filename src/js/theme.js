/**
 * Theme management (dark default, optional light mode persisted in localStorage)
 * and pure mobile 4-tab navigation transition helpers.
 */

export const DEFAULT_THEME = 'dark';
export const THEME_STORAGE_KEY = 'ridgeline-theme';
export const THEME_COLORS = {
  dark: '#141916',
  light: '#edf0ea',
};

export const normalizeTheme = (value) => (value === 'light' ? 'light' : DEFAULT_THEME);

const defaultStorage = () => (typeof localStorage !== 'undefined' ? localStorage : null);
const defaultDoc = () => (typeof document !== 'undefined' ? document : null);
const defaultWin = () => (typeof window !== 'undefined' ? window : null);

/** Read stored theme from localStorage, defaulting to 'dark' when unset or blocked. */
export const getStoredTheme = (storage = defaultStorage()) => {
  if (!storage) return DEFAULT_THEME;
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
};

/** Apply theme to <html data-theme="..."> and <meta name="theme-color">. */
const applyThemeToDoc = (theme, doc = defaultDoc()) => {
  const next = normalizeTheme(theme);
  if (!doc) return next;
  if (doc.documentElement) doc.documentElement.dataset.theme = next;
  const color = THEME_COLORS[next];
  const metas = doc.querySelectorAll ? [...doc.querySelectorAll('meta[name="theme-color"]')] : [];
  if (metas.length) {
    for (const meta of metas) meta.setAttribute('content', color);
  } else if (doc.head && doc.createElement) {
    const meta = doc.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', color);
    doc.head.appendChild(meta);
  }
  return next;
};

/** Initialize theme from storage (defaults to 'dark') and sync the document immediately. */
export const initTheme = ({ storage = defaultStorage(), doc = defaultDoc() } = {}) => {
  const theme = getStoredTheme(storage);
  return applyThemeToDoc(theme, doc);
};

/** Persist theme, apply to document, and notify listeners via 'ridgeline-theme'. */
export const setTheme = (theme, { storage = defaultStorage(), doc = defaultDoc(), win = defaultWin() } = {}) => {
  const next = normalizeTheme(theme);
  if (storage) {
    try {
      storage.setItem(THEME_STORAGE_KEY, next);
    } catch { /* storage blocked: theme still applies for this session */ }
  }
  applyThemeToDoc(next, doc);
  if (win?.dispatchEvent && typeof CustomEvent !== 'undefined') {
    win.dispatchEvent(new CustomEvent('ridgeline-theme', { detail: { theme: next } }));
  }
  return next;
};

/** Flip between 'dark' and 'light' and persist. */
export const toggleTheme = ({ storage = defaultStorage(), doc = defaultDoc(), win = defaultWin() } = {}) => {
  const docTheme = doc?.documentElement?.dataset?.theme;
  const current = docTheme === 'light' || docTheme === 'dark' ? docTheme : getStoredTheme(storage);
  return setTheme(current === 'dark' ? 'light' : 'dark', { storage, doc, win });
};

// ------------------------------------------------ mobile 4-tab state helpers

export const MOBILE_TABS = ['explore', 'briefing', 'map', 'ontrail'];
export const DEFAULT_MOBILE_TAB = 'explore';

export const normalizeMobileTab = (tab) => (MOBILE_TABS.includes(tab) ? tab : DEFAULT_MOBILE_TAB);

/**
 * Pure state transition for the 4-tab mobile navigation ('explore' | 'briefing' | 'map' | 'ontrail').
 * Every tab immediately renders a full-screen view with zero collapsed bottom-sheet state.
 */
export const transitionMobileTab = (currentTab, targetTab, { hasRoute = false } = {}) => {
  const prev = normalizeMobileTab(currentTab);
  const tab = normalizeMobileTab(targetTab);
  return {
    prev,
    tab,
    changed: prev !== tab,
    modeChange: tab === 'ontrail' ? 'on-trail' : null,
    startGps: tab === 'ontrail',
    shouldResizeMap: tab === 'map',
    closeInspectCard: tab !== 'map',
    needsRoutePrompt: (tab === 'briefing' || tab === 'ontrail') && !hasRoute,
  };
};

export const mobileTabOnRouteOpen = () => 'briefing';
export const mobileTabOnRouteClose = () => 'explore';
