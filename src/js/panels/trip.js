/**
 * Optional Plan-mode itinerary strip: collapsed by default so casual checks
 * stay free of form chrome, expanding cleanly to walk a start time and daily
 * pace up to NWS's 168-hour forecast reach.
 */
import { h, mount } from '../ui/dom.js';
import { fmtWhen } from './common.js';

const pad2 = (n) => String(n).padStart(2, '0');

export const toLocalDatetimeValue = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

export const defaultTripStartMs = (now = Date.now()) => {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(7, 0, 0, 0);
  return d.getTime();
};

export const parseTripForm = (startValue, paceValue) => {
  const trimmed = String(startValue || '').trim();
  const startMs = trimmed ? Date.parse(trimmed) : NaN;
  if (!trimmed || !Number.isFinite(startMs)) {
    return { error: 'Enter a valid start date and time.' };
  }
  const pace = Number(paceValue);
  if (!Number.isFinite(pace) || pace < 1 || pace > 100) {
    return { error: 'Enter a pace from 1 to 100 mi/day.' };
  }
  return {
    trip: {
      startAt: new Date(startMs).toISOString(),
      paceMilesPerDay: Math.round(pace * 10) / 10,
    },
  };
};

const fmtPace = (p) => (Number.isInteger(p) ? String(p) : p.toFixed(1));

export const createTripPlanner = (container, { onApply, onClear } = {}) => {
  const summaryLabel = h('span', { class: 'trip-label' });
  const editButton = h('button', { type: 'button', class: 'btn btn-small trip-toggle', 'aria-expanded': 'false' }, 'Set trip dates');
  const clearButton = h('button', { type: 'button', class: 'btn btn-quiet btn-small', hidden: true }, 'Clear');
  const head = h('div', { class: 'trip-head' },
    h('p', { class: 'trip-summary' }, summaryLabel),
    h('div', { class: 'trip-head-actions' }, editButton, clearButton));

  const startInput = h('input', { id: 'trip-start', class: 'input input-datetime', type: 'datetime-local', 'aria-describedby': 'trip-error' });
  const paceInput = h('input', { id: 'trip-pace', class: 'input input-pace', type: 'number', inputmode: 'decimal', min: '1', max: '100', step: '1', 'aria-describedby': 'trip-error' });
  const errorEl = h('p', { id: 'trip-error', class: 'field-error', role: 'alert', hidden: true });
  const cancelButton = h('button', { type: 'button', class: 'btn btn-quiet btn-small' }, 'Cancel');
  const form = h('form', { class: 'trip-form', novalidate: true, hidden: true },
    h('div', { class: 'trip-fields' },
      h('div', { class: 'trip-field' },
        h('label', { for: 'trip-start', class: 'field-label' }, 'Start'),
        startInput),
      h('div', { class: 'trip-field trip-field-pace' },
        h('label', { for: 'trip-pace', class: 'field-label' }, 'Pace (mi/day)'),
        paceInput)),
    errorEl,
    h('p', { class: 'trip-hint' }, 'Checks forecasts along your daily pace up to 7 days ahead; later miles stay unchecked.'),
    h('div', { class: 'trip-form-actions' },
      h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, 'Check trip'),
      cancelButton));

  mount(container, head, form);

  let state = { open: false, trip: null, defaultPace: 12, timeZone: null };

  const setOpen = (open) => {
    state.open = open;
    form.hidden = !open;
    editButton.setAttribute('aria-expanded', String(open));
    editButton.hidden = open;
    clearButton.hidden = open || !state.trip;
    if (open) {
      errorEl.hidden = true;
      startInput.removeAttribute('aria-invalid');
      paceInput.removeAttribute('aria-invalid');
      startInput.value = toLocalDatetimeValue(state.trip ? Date.parse(state.trip.startAt) : defaultTripStartMs());
      paceInput.value = String(state.trip?.paceMilesPerDay ?? state.defaultPace);
      startInput.focus();
    }
  };

  editButton.addEventListener('click', () => setOpen(true));
  cancelButton.addEventListener('click', () => {
    setOpen(false);
    editButton.focus();
  });
  clearButton.addEventListener('click', () => {
    setOpen(false);
    onClear?.();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const parsed = parseTripForm(startInput.value, paceInput.value);
    if (parsed.error) {
      errorEl.textContent = parsed.error;
      errorEl.hidden = false;
      const startBad = parsed.error.includes('date');
      startInput.setAttribute('aria-invalid', String(startBad));
      paceInput.setAttribute('aria-invalid', String(!startBad));
      (startBad ? startInput : paceInput).focus();
      return;
    }
    setOpen(false);
    onApply?.(parsed.trip);
  });

  const render = ({ trip = null, defaultPace = 12, result = null } = {}) => {
    state.trip = trip;
    state.defaultPace = defaultPace;
    state.timeZone = result?.route?.timeZone || null;

    if (trip) {
      const when = fmtWhen(trip.startAt, state.timeZone) || trip.startAt;
      summaryLabel.textContent = `Itinerary: ${when}, ${fmtPace(trip.paceMilesPerDay)} mi/day`;
      editButton.textContent = 'Edit';
    } else {
      summaryLabel.textContent = 'Forecast timing: next 72 hours';
      editButton.textContent = 'Set trip dates';
    }
    editButton.hidden = state.open;
    clearButton.hidden = state.open || !trip;
  };

  return { render };
};
