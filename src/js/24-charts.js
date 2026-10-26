/* =================================================================
 * Part 3: chart components — plain SVG, dataviz mark specs
 * (thin marks ≤24px, 4px rounded data-ends, 2px surface gaps,
 *  hairline solid grid, crosshair + unified tooltip, table twins)
 * ================================================================= */

const Tooltip = {
  node: null,
  init() { this.node = $('tooltip'); },
  show(cx, cy, title, rows, totalRow) {
    const t = this.node;
    clear(t);
    if (title) t.appendChild(el('div', { class: 'tt-title', text: title }));
    for (const r of rows) {
      const line = el('div', { class: 'tt-row' },
        el('span', { class: 'tt-key', style: { background: r.color } }),
        el('span', { class: 'tt-val', text: r.value }),
        el('span', { class: 'tt-name', text: r.name })
      );
      t.appendChild(line);
    }
    if (totalRow) {
      t.appendChild(el('div', { class: 'tt-row tt-total' },
        el('span', { class: 'tt-key', style: { background: 'transparent' } }),
        el('span', { class: 'tt-val', text: totalRow.value }),
        el('span', { class: 'tt-name', text: totalRow.name })
      ));
    }
    t.style.display = 'block';
    t.setAttribute('aria-hidden', 'false');
    const pad = 14;
    const w = t.offsetWidth, h = t.offsetHeight;
    let x = cx + pad, y = cy + pad;
    if (x + w > innerWidth - 8) x = cx - w - pad;
    if (y + h > innerHeight - 8) y = cy - h - pad;
    t.style.left = Math.max(4, x) + 'px';
    t.style.top = Math.max(4, y) + 'px';
  },
  hide() { if (this.node) { this.node.style.display = 'none'; this.node.setAttribute('aria-hidden', 'true'); } }
};

function niceTicks(maxV, n = 4) {
  if (maxV <= 0) return { ticks: [0, 1], max: 1 };
  const raw = maxV / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(maxV / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 1e6; v += step) ticks.push(v);
  return { ticks, max: top };
}
const fmtTick = (v, metric) => metric === 'cost'
  ? (v >= 1000 ? '$' + fmtCompact(v) : '$' + (v % 1 ? v.toFixed(2) : v))
  : fmtCompact(v);

/* rounded-top rect path (4px data end, square baseline) */
function roundedTopRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}
function roundedRightRect(x, y, w, h, r) {
  r = Math.min(r, h / 2, w);
  return `M${x},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x},${y + h} Z`;
}

/* ---------- stacked daily columns with crosshair ---------- */
function renderStackedColumns(container, { days, series, metric }) {
  const { buckets, unit } = bucketDays(days);
  const labels = buckets.map(b => b.label);
  const tickDays = buckets.map(b => b.days[0]);   // first day actually in range — for week/month buckets this can differ from the bucket key (e.g. a Monday before the range start)
  if (unit !== 'day') {
    const idx = new Map(days.map((d, i) => [d, i]));
    series = series.map(s => ({ ...s, values: buckets.map(b => b.days.reduce((a, d) => a + (s.values[idx.get(d)] || 0), 0)) }));
    days = buckets.map(b => b.key);
  }
  clear(container);
  const W = Math.max(320, container.clientWidth || 700);
  const plotH = 230, axisB = 24, padT = 8, padR = 10;
  // y-axis label width from top tick
  const totals = days.map((d, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const { ticks, max } = niceTicks(Math.max(...totals, 0));
  const padL = 12 + String(fmtTick(ticks[ticks.length - 1], metric)).length * 7;
  const H = padT + plotH + axisB;
  const innerW = W - padL - padR;
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Daily usage stacked column chart' });
  const y = (v) => padT + plotH - (max ? (v / max) * plotH : 0);

  // gridlines + tick labels
  for (const tv of ticks) {
    const yy = Math.round(y(tv)) + 0.5;
    svg.appendChild(el('line', { class: tv === 0 ? 'base-l' : 'grid-l', x1: padL, x2: W - padR, y1: yy, y2: yy }));
    svg.appendChild(el('text', { class: 'axis-t', x: padL - 6, y: yy + 3.5, 'text-anchor': 'end', text: fmtTick(tv, metric) }));
  }

  const n = days.length;
  const band = innerW / Math.max(1, n);
  const barW = Math.max(2, Math.min(24, Math.floor(band * 0.72)));
  const gap = 2;

  // x tick labels (≤8)
  const every = Math.max(1, Math.ceil(n / 8));
  days.forEach((d, i) => {
    if (i % every !== 0 && i !== n - 1) return;
    const cx = padL + band * i + band / 2;
    svg.appendChild(el('text', { class: 'axis-t', x: cx, y: padT + plotH + 16, 'text-anchor': 'middle', text: fmtDayShort(tickDays[i]) }));
  });

  // columns
  days.forEach((d, i) => {
    const x = padL + band * i + (band - barW) / 2;
    let cum = 0;
    const segs = [];
    for (const s of series) {
      const v = s.values[i] || 0;
      if (v > 0) segs.push({ s, v, from: cum, to: cum + v });
      cum += v;
    }
    segs.forEach((seg, si) => {
      const topPx = y(seg.to);
      let botPx = y(seg.from);
      if (si > 0) botPx -= gap;               // 2px surface gap between segments
      const h = botPx - topPx;
      if (h <= 0.6) return;
      const isTop = si === segs.length - 1;
      if (isTop && h > 3) {
        svg.appendChild(el('path', { d: roundedTopRect(x, topPx, barW, h, 4), fill: seg.s.color }));
      } else {
        svg.appendChild(el('rect', { x, y: topPx, width: barW, height: h, fill: seg.s.color }));
      }
    });
  });

  // crosshair + one delegated hit layer (bands themselves are inert visuals)
  const cross = el('line', { class: 'crosshair', y1: padT, y2: padT + plotH, x1: -9, x2: -9, 'pointer-events': 'none' });
  svg.appendChild(cross);
  const hit = el('rect', {
    class: 'hitlayer', x: padL, y: padT, width: innerW, height: plotH, fill: 'transparent',
    tabindex: 0, role: 'img', 'aria-label': 'Daily usage detail, use arrow keys to browse'
  });
  const bandEls = [];
  days.forEach((d, i) => {
    const bx = padL + band * i;
    const bandEl = el('rect', { class: 'colband', x: bx, y: padT, width: band, height: plotH, 'pointer-events': 'none' });
    bandEls.push(bandEl);
    svg.appendChild(bandEl);
  });
  const hideBands = () => { for (const b of bandEls) b.classList.remove('active'); };
  const showDay = (i, clientX, clientY) => {
    const cx = padL + band * i + band / 2;
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
    const rows = series
      .map(s => ({ color: s.color, name: s.name, v: s.values[i] || 0 }))
      .filter(r => r.v > 0)
      .sort((a, b) => b.v - a.v)
      .map(r => ({ color: r.color, name: r.name, value: fmtMetric(r.v, metric) }));
    const total = totals[i] || 0;
    const ttTitle = labels[i];
    Tooltip.show(clientX, clientY, ttTitle,
      rows.length ? rows : [{ color: 'transparent', name: 'no usage', value: '—' }],
      rows.length > 1 ? { name: 'total', value: fmtMetric(total, metric) } : null);
    hit.setAttribute('aria-label', `${ttTitle}: ${fmtMetric(total, metric)} total`);
    for (let j = 0; j < bandEls.length; j++) bandEls[j].classList.toggle('active', j === i);
  };
  let focusIdx = n - 1;
  const clampIdx = (i) => Math.max(0, Math.min(n - 1, i));
  const idxFromClientX = (clientX) => {
    const r = svg.getBoundingClientRect();
    return clampIdx(Math.floor((clientX - r.left - padL) / band));
  };
  const posForIdx = (i) => { const r = svg.getBoundingClientRect(); return { x: r.left + padL + band * i + band / 2, y: r.top + 40 }; };
  hit.addEventListener('pointermove', (e) => { focusIdx = idxFromClientX(e.clientX); showDay(focusIdx, e.clientX, e.clientY); });
  hit.addEventListener('pointerleave', () => { Tooltip.hide(); cross.setAttribute('x1', -9); cross.setAttribute('x2', -9); hideBands(); });
  hit.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') focusIdx = clampIdx(focusIdx - 1);
    else if (e.key === 'ArrowRight') focusIdx = clampIdx(focusIdx + 1);
    else return;
    e.preventDefault();
    const p = posForIdx(focusIdx);
    showDay(focusIdx, p.x, p.y);
  });
  hit.addEventListener('focus', () => { const p = posForIdx(focusIdx); showDay(focusIdx, p.x, p.y); });
  hit.addEventListener('blur', () => { Tooltip.hide(); cross.setAttribute('x1', -9); cross.setAttribute('x2', -9); hideBands(); });
  svg.appendChild(hit);

  container.appendChild(svg);
}

/* ---------- horizontal bars (magnitude, one hue) ---------- */
function renderHBars(container, { items, metric, color }) {
  clear(container);
  const W = Math.max(280, container.clientWidth || 460);
  const rowH = 30, barH = 14, padT = 4;
  const labelW = Math.min(190, Math.max(90, ...items.map(i => i.name.length * 6.6)) + 12);
  const valueW = 62, padR = 8;
  const H = padT + items.length * rowH + 6;
  const maxV = Math.max(...items.map(i => i.value), 0) || 1;
  const innerW = W - labelW - valueW - padR;
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Totals per model, horizontal bars' });
  svg.appendChild(el('line', { class: 'base-l', x1: labelW + 0.5, x2: labelW + 0.5, y1: padT, y2: H - 4 }));
  items.forEach((it, i) => {
    const yc = padT + i * rowH + rowH / 2;
    const w = Math.max(1.5, (it.value / maxV) * innerW);
    const g = el('g', { class: 'hbar-hit', tabindex: 0, role: 'img', 'aria-label': `${it.name}: ${fmtMetric(it.value, metric)}` });
    g.appendChild(el('rect', { x: labelW - labelW, y: yc - rowH / 2, width: W, height: rowH, fill: 'transparent' }));
    const name = el('text', { class: 'axis-t', x: labelW - 8, y: yc + 3.5, 'text-anchor': 'end', text: it.name.length > 26 ? it.name.slice(0, 25) + '…' : it.name });
    name.appendChild(el('title', { text: it.name }));
    g.appendChild(name);
    g.appendChild(el('path', { class: 'mark', d: roundedRightRect(labelW + 1, yc - barH / 2, w, barH, 4), fill: it.color || color }));
    g.appendChild(el('text', { class: 'bar-label', x: labelW + 1 + w + 6, y: yc + 3.5, text: fmtMetric(it.value, metric) }));
    const tip = (e) => Tooltip.show(e.clientX ?? g.getBoundingClientRect().right, e.clientY ?? g.getBoundingClientRect().top,
      it.name, [{ color: it.color || color, name: metric === 'cost' ? 'API-equivalent cost' : 'tokens', value: fmtMetric(it.value, metric) }].concat(
        it.extra ? it.extra.map(x => ({ color: 'transparent', name: x.name, value: x.value })) : []));
    g.addEventListener('pointermove', tip);
    g.addEventListener('pointerleave', () => Tooltip.hide());
    g.addEventListener('focus', tip);
    g.addEventListener('blur', () => Tooltip.hide());
    svg.appendChild(g);
  });
  container.appendChild(svg);
}

/* ---------- single 100% stacked bar (part-to-whole) ---------- */
function renderShareBar(container, { items, metric }) {
  clear(container);
  const W = Math.max(280, container.clientWidth || 460);
  const H = 74, barH = 22, y0 = 12;
  const total = items.reduce((a, b) => a + b.value, 0);
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Share by platform' });
  if (total <= 0) { container.appendChild(svg); return; }
  const gap = 2, padR = 8;
  const innerW = W - padR - 2 - gap * Math.max(0, items.length - 1);
  let x = 1;
  items.forEach((it, i) => {
    const w = Math.max(1.5, (it.value / total) * innerW);
    const isFirst = i === 0, isLast = i === items.length - 1;
    let d;
    if (isFirst && isLast) d = null;
    const r = 4;
    const seg = el('g', { tabindex: 0, role: 'img', 'aria-label': `${it.name}: ${fmtMetric(it.value, metric)} (${(100 * it.value / total).toFixed(1)}%)` });
    let shape;
    if (isFirst || isLast) {
      const rr = Math.min(r, w / 2, barH / 2);
      const x2 = x + w, yTop = y0, yBot = y0 + barH;
      const p = isFirst && isLast
        ? `M${x + rr},${yTop} L${x2 - rr},${yTop} Q${x2},${yTop} ${x2},${yTop + rr} L${x2},${yBot - rr} Q${x2},${yBot} ${x2 - rr},${yBot} L${x + rr},${yBot} Q${x},${yBot} ${x},${yBot - rr} L${x},${yTop + rr} Q${x},${yTop} ${x + rr},${yTop} Z`
        : isFirst
          ? `M${x + rr},${yTop} L${x2},${yTop} L${x2},${yBot} L${x + rr},${yBot} Q${x},${yBot} ${x},${yBot - rr} L${x},${yTop + rr} Q${x},${yTop} ${x + rr},${yTop} Z`
          : `M${x},${yTop} L${x2 - rr},${yTop} Q${x2},${yTop} ${x2},${yTop + rr} L${x2},${yBot - rr} Q${x2},${yBot} ${x2 - rr},${yBot} L${x},${yBot} Z`;
      shape = el('path', { d: p, fill: it.color });
    } else {
      shape = el('rect', { x, y: y0, width: w, height: barH, fill: it.color });
    }
    seg.appendChild(shape);
    const pct = 100 * it.value / total;
    if (w > 46) {
      const lum = /^#/.test(it.color) ? parseInt(it.color.slice(1, 3), 16) * 0.5 + parseInt(it.color.slice(3, 5), 16) * 1.2 + parseInt(it.color.slice(5, 7), 16) * 0.3 : 200;
      seg.appendChild(el('text', {
        x: x + w / 2, y: y0 + barH / 2 + 3.5, 'text-anchor': 'middle',
        fill: lum > 280 ? '#0b0b0b' : '#ffffff', 'font-size': '11', text: pct.toFixed(0) + '%'
      }));
    }
    const tip = (e) => Tooltip.show(e.clientX ?? 0, e.clientY ?? 0, it.name,
      [{ color: it.color, name: metric === 'cost' ? 'cost share' : 'token share', value: `${fmtMetric(it.value, metric)} · ${pct.toFixed(1)}%` }]);
    seg.addEventListener('pointermove', tip);
    seg.addEventListener('pointerleave', () => Tooltip.hide());
    seg.addEventListener('focus', (e) => { const r2 = seg.getBoundingClientRect(); Tooltip.show(r2.left + 20, r2.top + 30, it.name, [{ color: it.color, name: 'share', value: pct.toFixed(1) + '%' }]); });
    seg.addEventListener('blur', () => Tooltip.hide());
    svg.appendChild(seg);
    x += w + gap;
  });
  container.appendChild(svg);
}

/* ---------- sparkline (12 points, de-emphasis hue, accent endpoint) ---------- */
function renderSparkline(container, values) {
  clear(container);
  if (!values || values.length < 2 || values.every(v => !v)) return;
  const W = 150, H = 34, pad = 3;
  const styles = getComputedStyle(document.documentElement);
  const deEmph = styles.getPropertyValue('--seq-250').trim() || '#86b6ef';
  const accent = styles.getPropertyValue('--accent').trim() || '#2a78d6';
  const surface = styles.getPropertyValue('--surface-1').trim() || '#fcfcfb';
  const maxV = Math.max(...values) || 1;
  const stepX = (W - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => [pad + i * stepX, H - pad - (v / maxV) * (H - pad * 2)]);
  const dAttr = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
  svg.appendChild(el('path', { d: dAttr, fill: 'none', stroke: deEmph, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  const last = pts[pts.length - 1];
  svg.appendChild(el('circle', { cx: last[0], cy: last[1], r: 4.5, fill: surface }));
  svg.appendChild(el('circle', { cx: last[0], cy: last[1], r: 3, fill: accent }));
  container.appendChild(svg);
}

/* ---------- calendar heatmap (13 weeks × 7 days) ---------- */
function renderHeatmap(container, hm, metric) {
  clear(container);
  const cell = 12, gap = 2, W = 13 * (cell + gap) + 30, H = 7 * (cell + gap) + 18;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Activity heatmap, last 13 weeks' });
  const styles = getComputedStyle(document.documentElement);
  const c0 = styles.getPropertyValue('--grid').trim(), c1 = styles.getPropertyValue('--seq-150').trim(), c2 = styles.getPropertyValue('--seq-250').trim(), c3 = styles.getPropertyValue('--accent').trim();
  hm.days.forEach((x, i) => {
    const wk = Math.floor(i / 7), dow = i % 7;
    const t = hm.max ? x.v / hm.max : 0;
    const fill = x.v === 0 ? c0 : t < 0.34 ? c1 : t < 0.67 ? c2 : c3;
    const r = el('rect', { class: 'hm', x: 30 + wk * (cell + gap), y: dow * (cell + gap), width: cell, height: cell, rx: 2, fill });
    r.appendChild(el('title', { text: `${x.d}: ${fmtMetric(x.v, metric)}` }));
    svg.appendChild(r);
  });
  ['M', 'W', 'F'].forEach((lab, k) => svg.appendChild(el('text', { class: 'axis-t', x: 0, y: (k * 2) * (cell + gap) + cell - 2, text: lab })));
  container.appendChild(svg);
}
/* ---------- 24-bin hour histogram ---------- */
function renderHourBars(container, hb) {
  const W = 240, H = 44, bw = W / 24;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H + 12}`, role: 'img', 'aria-label': 'Messages by hour of day' });
  const max = Math.max(1, ...hb.bins);
  const styles = getComputedStyle(document.documentElement);
  const fill = styles.getPropertyValue('--s1').trim();
  hb.bins.forEach((v, h) => {
    const bh = (v / max) * H;
    const r = el('rect', { class: 'hb', x: h * bw + 1, y: H - bh, width: bw - 2, height: bh, fill, opacity: v ? 1 : 0.15 });
    r.appendChild(el('title', { text: `${h}:00 — ${v} msgs` }));
    svg.appendChild(r);
  });
  [0, 6, 12, 18].forEach(h => svg.appendChild(el('text', { class: 'axis-t', x: h * bw + 1, y: H + 10, text: String(h) })));
  container.appendChild(svg);
}

/* ---------- legend (shared) ---------- */
function renderLegend(container, series, hidden, onToggle, mirror) {
  clear(container);
  if (series.length < 2) return;
  for (const s of series) {
    const item = el('button', { class: 'item', 'aria-pressed': hidden.has(s.name) ? 'false' : 'true', title: 'Click to show/hide' },
      el('span', { class: 'sw' + (mirror === 'line' ? ' line' : ''), style: { background: s.color } }),
      el('span', { text: s.name })
    );
    item.addEventListener('click', () => onToggle(s.name));
    container.appendChild(item);
  }
}
