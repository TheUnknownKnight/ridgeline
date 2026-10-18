/**
 * Per-chunk hit collection and mile-range consolidation.
 *
 * Adjacent chunks merge ONLY when they carry exactly the same hazards at the
 * same levels and were checked against the same sources. Per-chunk notes and
 * distances never block a merge; the closest one is kept for display.
 */
const round2 = (n) => Math.round(n * 100) / 100;

export const createHitTable = (chunkCount) => {
  const table = Array.from({ length: chunkCount }, () => new Map());
  return {
    table,
    /** hit = { chunk, id, level, note?, distance?, atMile? } — keeps the strongest per hazard per chunk. */
    add(hit) {
      const row = table[hit.chunk];
      if (!row) return;
      const prev = row.get(hit.id);
      if (!prev) { row.set(hit.id, { ...hit }); return; }
      const closer = hit.distance != null && (prev.distance == null || hit.distance < prev.distance);
      if (hit.level > prev.level || (hit.level === prev.level && closer)) row.set(hit.id, { ...hit });
    },
  };
};

const signatureOf = (row, checked) => {
  const parts = [];
  for (const [id, h] of row) parts.push(`${id}@${h.level}`);
  parts.sort();
  return `${parts.join('|')}#${checked.join(',')}`;
};

/**
 * chunks: route chunks; hitTable: from createHitTable; checkedFor(i) -> string[];
 * catalog: Map(id -> hazard). Returns { segments, hazards } where hazards is
 * the catalog (plain object) restricted to hazards with at least one hit,
 * annotated with ranges, max level and closest approach.
 */
export const consolidate = (chunks, hitTable, checkedFor, catalog) => {
  const segments = [];
  let cur = null;

  const refsOf = (row) => [...row.values()]
    .map(h => {
      const ref = { id: h.id, level: h.level };
      if (h.note) ref.note = h.note;
      if (h.distance != null) ref.distance = round2(h.distance);
      if (h.value != null) ref.value = h.value;
      return ref;
    })
    .sort((a, b) => b.level - a.level || a.id.localeCompare(b.id));

  for (let i = 0; i < chunks.length; i++) {
    const row = hitTable.table[i];
    const checked = checkedFor(i);
    const sig = signatureOf(row, checked);
    if (cur && cur.sig === sig) {
      cur.seg.mileEnd = chunks[i].end;
      for (const ref of cur.seg.refs) {
        const h = row.get(ref.id);
        if (!h) continue;
        // Show the worst stretch: closest approach, or the highest forecast value.
        if (h.distance != null && (ref.distance == null || h.distance < ref.distance)) {
          ref.distance = round2(h.distance);
          if (h.note) ref.note = h.note;
        } else if (h.distance == null && h.value != null && (ref.value == null || h.value > ref.value)) {
          ref.value = h.value;
          if (h.note) ref.note = h.note;
        }
      }
      continue;
    }
    const refs = refsOf(row);
    const level = refs.reduce((m, r) => Math.max(m, r.level), 0);
    const atMax = refs.filter(r => r.level === level);
    const estimatedOnly = level > 0 && atMax.every(r => catalog.get(r.id)?.source === 'ESTIMATED');
    cur = {
      sig,
      seg: { mileStart: chunks[i].start, mileEnd: chunks[i].end, level, estimatedOnly, refs, checked },
    };
    segments.push(cur.seg);
  }

  for (const seg of segments) {
    seg.mileStart = round2(seg.mileStart);
    seg.mileEnd = round2(seg.mileEnd);
    for (const ref of seg.refs) delete ref.value;
  }

  // Hazard catalog: ranges + closest approach, from the per-chunk table.
  const hazards = {};
  for (let i = 0; i < chunks.length; i++) {
    for (const [id, h] of hitTable.table[i]) {
      const base = catalog.get(id);
      if (!base) continue;
      let entry = hazards[id];
      if (!entry) {
        entry = hazards[id] = { ...base, level: 0, ranges: [], closest: null };
      }
      entry.level = Math.max(entry.level, h.level);
      const last = entry.ranges[entry.ranges.length - 1];
      if (last && Math.abs(last[1] - chunks[i].start) < 1e-6) last[1] = chunks[i].end;
      else entry.ranges.push([chunks[i].start, chunks[i].end]);
      if (h.distance != null && (!entry.closest || h.distance < entry.closest.miles)) {
        entry.closest = { miles: round2(h.distance), atMile: round2(h.atMile ?? (chunks[i].start + chunks[i].end) / 2) };
      }
    }
  }
  for (const entry of Object.values(hazards)) {
    entry.ranges = entry.ranges.map(([a, b]) => [round2(a), round2(b)]);
  }

  return { segments, hazards };
};
