// Small inline-SVG charts for Desk (docs/desk-spec.md §1, components/charts.js).
//
// BarChart  grouped or stacked columns with a zero line for negative values, a hover / keyboard
//           readout of every series at that column, a legend from two series up and a
//           screen-reader table of all values. It measures its own width, so it fills any card.
// Sparkline a tiny trend line for stat tiles.
//
// Marks follow the Desk chart rules: columns at most 24px wide, 4px rounded data ends square at
// the baseline, a 2px gap between touching marks, hairline gridlines, text in ink tokens and
// only the marks in series colours (CSS custom properties such as 'var(--gain)').

import { html, useLayoutEffect, useRef, useState } from '../lib/preact.js';
import { cx, useId } from '../lib/ui.js';

const CSS = `
.chart { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.chart-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; color: var(--ink-2); font-size: 12.5px; }
.chart-legend li { display: inline-flex; align-items: center; gap: 6px; }
.chart-swatch { flex: none; width: 10px; height: 10px; border-radius: 2px; }
.chart-plot { position: relative; min-width: 0; border-radius: var(--r-ctl); touch-action: pan-y; }
.chart-plot:focus { outline: none; }
.chart-plot:focus-visible { outline: 2px solid var(--signal); outline-offset: 3px; }
.chart-svg { display: block; width: 100%; overflow: visible; }
.chart-axis { fill: var(--ink-3); font-family: var(--sans); font-size: 11px; font-variant-numeric: tabular-nums; }
.chart-grid { stroke: var(--line); stroke-width: 1; shape-rendering: crispEdges; }
.chart-zero { stroke: var(--line-2); stroke-width: 1; shape-rendering: crispEdges; }
.chart-band { fill: var(--hover); }
.chart-tip { position: absolute; z-index: 2; top: 0; min-width: 128px; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--surface); box-shadow: var(--shadow-pop); font-size: 12.5px; line-height: 1.45; white-space: nowrap; pointer-events: none; transform: translateX(-50%); }
.chart-tip-title { margin-bottom: 3px; color: var(--ink-2); font-weight: 500; }
.chart-tip-row { display: flex; align-items: center; gap: 8px; }
.chart-tip-key { flex: none; width: 12px; height: 2px; border-radius: 1px; }
.chart-tip-value { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.chart-tip-label { color: var(--ink-2); }
.chart-tip-total { margin-top: 3px; padding-top: 3px; border-top: 1px solid var(--line); }
.chart-empty { display: flex; align-items: center; justify-content: center; padding: 16px; border: 1px dashed var(--line-2); border-radius: var(--r-ctl); color: var(--ink-3); font-size: 13px; text-align: center; }
.sparkline { display: block; width: 100%; overflow: visible; }
.sparkline-empty { display: block; }
`;

// Component styles live with the component and are added to <head> once, on first import.
const STYLE_ID = 'desk-charts-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

const FALLBACK_COLORS = ['var(--signal)', 'var(--gain)', 'var(--warn)', 'var(--loss)'];
const TONE_COLORS = {
  gain: 'var(--gain)',
  loss: 'var(--loss)',
  warn: 'var(--warn)',
  signal: 'var(--signal)',
  muted: 'var(--ink-3)',
};

const MAX_BAR = 24; // px: a column never fills its slot
const GAP = 2; // px between touching marks
const RADIUS = 4; // px rounding on the data end
const FALLBACK_WIDTH = 560; // until the first measurement
const AXIS_CHAR_PX = 6.6; // average width of an 11px axis character
const X_LABEL_MIN_PX = 46; // room one x label needs before labels are thinned out
const PAD = { top: 10, right: 6, bottom: 24 };

const plainNumber = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const defaultFormat = (n) => plainNumber.format(n);

// ---- helpers ------------------------------------------------------------------------------

function finite(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return v !== null && v !== '' && Number.isFinite(n) ? n : 0;
}

// '--gain' -> 'var(--gain)'; any other CSS colour passes through.
function seriesColor(color, index) {
  if (typeof color === 'string' && color.trim()) {
    const value = color.trim();
    return value.startsWith('--') ? `var(${value})` : value;
  }
  return FALLBACK_COLORS[index] ?? 'var(--ink-3)';
}

// A "nice" tick step (1, 2, 2.5 or 5 × 10^n) giving about `count` intervals over `span`.
function niceStep(span, count) {
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const factor = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return factor * magnitude;
}

// Axis domain that always includes zero, rounded out to whole ticks.
function axisTicks(min, max) {
  let lo = Math.min(0, min);
  let hi = Math.max(0, max);
  if (lo === hi) hi = lo + 1;
  const step = niceStep(hi - lo, 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let i = 0; lo + i * step <= hi + step * 1e-9; i += 1) {
    ticks.push(Number((lo + i * step).toPrecision(12)) + 0); // + 0 folds -0
  }
  return { lo, hi, ticks };
}

// A column from the baseline side (`from`) to the data end (`to`), rounded only at the data
// end. Works upwards (to < from) and downwards (negative values).
function barPath(x, width, from, to, rounded) {
  const height = Math.abs(to - from);
  const r = rounded ? Math.min(RADIUS, width / 2, height) : 0;
  const right = x + width;
  if (r <= 0) return `M${x},${from}V${to}H${right}V${from}Z`;
  const dir = to < from ? -1 : 1;
  const curveStart = to - dir * r;
  return `M${x},${from}V${curveStart}Q${x},${to} ${x + r},${to}H${right - r}Q${right},${to} ${right},${curveStart}V${from}Z`;
}

function useWidth(ref) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () => setWidth(Math.round(node.clientWidth));
    measure();
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return width;
}

// ---- layout -------------------------------------------------------------------------------

function layoutBars({ rows, series, width, height, stacked, format }) {
  let min = 0;
  let max = 0;
  for (const row of rows) {
    if (stacked) {
      const up = row.values.reduce((sum, v) => sum + Math.max(0, v), 0);
      const down = row.values.reduce((sum, v) => sum + Math.min(0, v), 0);
      max = Math.max(max, up);
      min = Math.min(min, down);
    } else {
      for (const v of row.values) {
        max = Math.max(max, v);
        min = Math.min(min, v);
      }
    }
  }
  const { lo, hi, ticks } = axisTicks(min, max);
  const tickLabels = ticks.map((t) => format(t));
  const longest = tickLabels.reduce((n, label) => Math.max(n, String(label).length), 1);
  const left = Math.min(110, Math.max(28, Math.ceil(longest * AXIS_CHAR_PX) + 10));
  const plotWidth = Math.max(1, width - left - PAD.right);
  const plotHeight = Math.max(1, height - PAD.top - PAD.bottom);
  const y = (v) => PAD.top + ((hi - v) / (hi - lo)) * plotHeight;
  const band = plotWidth / Math.max(1, rows.length);
  const zeroY = y(0);

  const bars = [];
  rows.forEach((row, i) => {
    const bandX = left + i * band;
    if (stacked) {
      const barWidth = Math.max(2, Math.min(MAX_BAR, band * 0.56));
      const x = bandX + (band - barWidth) / 2;
      // Positive values stack up from zero and negative ones down, each in series order;
      // only the outermost segment in each direction gets the rounded end.
      const lastUp = row.values.findLastIndex((v) => v > 0);
      const lastDown = row.values.findLastIndex((v) => v < 0);
      let up = 0;
      let down = 0;
      row.values.forEach((v, j) => {
        if (v === 0) return;
        const base = v > 0 ? up : down;
        const end = base + v;
        const first = base === 0;
        let from = y(base);
        const to = y(end);
        if (!first) from += v > 0 ? -GAP : GAP; // surface gap between stacked segments
        if (v > 0) up = end;
        else down = end;
        if ((v > 0 && from - to < 0.5) || (v < 0 && to - from < 0.5)) return;
        bars.push({ key: `${i}-${j}`, row: i, series: j, d: barPath(x, barWidth, from, to, j === (v > 0 ? lastUp : lastDown)) });
      });
    } else {
      const count = series.length;
      const barWidth = Math.max(2, Math.min(MAX_BAR, (band * 0.72 - GAP * (count - 1)) / count));
      const groupWidth = count * barWidth + GAP * (count - 1);
      row.values.forEach((v, j) => {
        if (v === 0) return;
        const x = bandX + (band - groupWidth) / 2 + j * (barWidth + GAP);
        bars.push({ key: `${i}-${j}`, row: i, series: j, d: barPath(x, barWidth, zeroY, y(v), true) });
      });
    }
  });

  // When labels must be thinned, count back from the last column: in a time series the newest
  // period is the one that has to be named.
  const labelEvery = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(plotWidth / X_LABEL_MIN_PX))));
  return { left, plotWidth, band, zeroY, ticks, tickLabels, y, bars, labelEvery };
}

// ---- BarChart -----------------------------------------------------------------------------

/**
 * BarChart({ data: [{ label, values: [number, …] }], series: [{ key, label, color }],
 *            height = 180, format = n => string, stacked = false, title })
 * `values[j]` belongs to `series[j]`; colours are CSS colours or custom properties
 * ('var(--gain)' or '--gain'). `format` labels the axis, readout and table (e.g. moneyShort).
 */
export function BarChart({
  data = [],
  series = [],
  height = 180,
  format = defaultFormat,
  stacked = false,
  title = 'Bar chart',
  class: classAttr,
  className,
}) {
  const plotRef = useRef(null);
  const measured = useWidth(plotRef);
  const [active, setActive] = useState(-1);
  const baseId = useId('chart');

  const safeSeries = (Array.isArray(series) ? series : []).map((s, j) => ({
    key: s?.key ?? String(j),
    label: s?.label ?? `Series ${j + 1}`,
    color: seriesColor(s?.color, j),
  }));
  const rows = (Array.isArray(data) ? data : [])
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      label: String(row.label ?? ''),
      values: safeSeries.map((_, j) => finite(Array.isArray(row.values) ? row.values[j] : undefined)),
    }));
  const fmt = typeof format === 'function' ? (n) => String(format(n)) : defaultFormat;

  if (!rows.length || !safeSeries.length) {
    return html`<div class=${cx('chart', classAttr, className)}>
      <div class="chart-empty" style=${{ height: `${height}px` }}>No data yet</div>
    </div>`;
  }

  const width = measured || FALLBACK_WIDTH;
  const layout = layoutBars({ rows, series: safeSeries, width, height, stacked, format: fmt });
  const current = active >= 0 && active < rows.length ? active : -1;
  const titleId = `${baseId}-title`;
  const descId = `${baseId}-desc`;
  const describe = (row) => {
    const parts = safeSeries.map((s, j) => `${s.label} ${fmt(row.values[j])}`);
    return `${row.label}: ${parts.join(', ')}`;
  };

  const pick = (index) => setActive(Math.max(-1, Math.min(rows.length - 1, index)));

  const onPointerMove = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    const x = ((event.clientX - box.left) / box.width) * width;
    const index = Math.floor((x - layout.left) / layout.band);
    setActive(x < layout.left || index >= rows.length ? -1 : index);
  };

  const onKeyDown = (event) => {
    const moves = {
      ArrowRight: current < 0 ? 0 : current + 1,
      ArrowLeft: current < 0 ? rows.length - 1 : current - 1,
      Home: 0,
      End: rows.length - 1,
    };
    if (event.key in moves) {
      event.preventDefault();
      pick(Math.max(0, moves[event.key]));
    } else if (event.key === 'Escape' && current >= 0) {
      event.preventDefault();
      setActive(-1);
    }
  };

  const tipCenter = current >= 0 ? layout.left + (current + 0.5) * layout.band : 0;
  const tipLeft = Math.min(Math.max(tipCenter, 72), width - 72);
  const total = current >= 0 ? rows[current].values.reduce((sum, v) => sum + v, 0) : 0;

  return html`<div class=${cx('chart', classAttr, className)}>
    ${safeSeries.length > 1 && html`<ul class="chart-legend" aria-hidden="true">
      ${safeSeries.map((s) => html`<li key=${s.key}><span class="chart-swatch" style=${{ background: s.color }}></span>${s.label}</li>`)}
    </ul>`}
    <div
      ref=${plotRef}
      class="chart-plot"
      tabindex="0"
      aria-label=${`${title}. Use the left and right arrow keys to read each column.`}
      onPointerMove=${onPointerMove}
      onPointerLeave=${() => setActive(-1)}
      onKeyDown=${onKeyDown}
      onBlur=${() => setActive(-1)}
    >
      <svg class="chart-svg" width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`} role="img" aria-labelledby=${`${titleId} ${descId}`}>
        <title id=${titleId}>${title}</title>
        <desc id=${descId}>${`${rows.length} columns${safeSeries.length > 1 ? `, ${stacked ? 'stacked' : 'grouped'} by ${safeSeries.map((s) => s.label).join(' and ')}` : ''}. Values are listed in the table that follows.`}</desc>
        ${layout.ticks.map((tick, i) => {
          const ty = Math.round(layout.y(tick)) + 0.5;
          return html`<g key=${`t${i}`}>
            ${tick !== 0 && html`<line class="chart-grid" x1=${layout.left} x2=${layout.left + layout.plotWidth} y1=${ty} y2=${ty} />`}
            <text class="chart-axis" x=${layout.left - 8} y=${ty} dy="0.32em" text-anchor="end">${layout.tickLabels[i]}</text>
          </g>`;
        })}
        ${current >= 0 && html`<rect class="chart-band" x=${layout.left + current * layout.band} y=${PAD.top - 4} width=${layout.band} height=${height - PAD.top - PAD.bottom + 8} rx="4" />`}
        ${layout.bars.map((bar) => html`<path key=${bar.key} d=${bar.d} style=${`fill: ${safeSeries[bar.series].color}`} />`)}
        <line class="chart-zero" x1=${layout.left} x2=${layout.left + layout.plotWidth} y1=${Math.round(layout.zeroY) + 0.5} y2=${Math.round(layout.zeroY) + 0.5} />
        ${rows.map((row, i) => ((rows.length - 1 - i) % layout.labelEvery === 0 || i === current) && html`<text
          key=${`x${i}`}
          class="chart-axis"
          x=${layout.left + (i + 0.5) * layout.band}
          y=${height - 6}
          text-anchor="middle"
        >${row.label}</text>`)}
      </svg>
      ${current >= 0 && html`<div class="chart-tip" style=${{ left: `${tipLeft}px` }} aria-hidden="true">
        <div class="chart-tip-title">${rows[current].label}</div>
        ${safeSeries.map((s, j) => html`<div class="chart-tip-row" key=${s.key}>
          <span class="chart-tip-key" style=${{ background: s.color }}></span>
          <span class="chart-tip-value">${fmt(rows[current].values[j])}</span>
          <span class="chart-tip-label">${s.label}</span>
        </div>`)}
        ${stacked && safeSeries.length > 1 && html`<div class="chart-tip-row chart-tip-total">
          <span class="chart-tip-value">${fmt(total)}</span><span class="chart-tip-label">Total</span>
        </div>`}
      </div>`}
      <p class="sr-only" aria-live="polite">${current >= 0 ? describe(rows[current]) : ''}</p>
    </div>
    <div class="sr-only">
      <table>
        <caption>${title}</caption>
        <thead><tr><th scope="col">Column</th>${safeSeries.map((s) => html`<th scope="col" key=${s.key}>${s.label}</th>`)}</tr></thead>
        <tbody>
          ${rows.map((row, i) => html`<tr key=${`r${i}`}>
            <th scope="row">${row.label}</th>
            ${row.values.map((v, j) => html`<td key=${safeSeries[j].key}>${fmt(v)}</td>`)}
          </tr>`)}
        </tbody>
      </table>
    </div>
  </div>`;
}

// ---- Sparkline ----------------------------------------------------------------------------

/**
 * Sparkline({ values, height = 32, tone, label })
 * tone: 'gain'|'loss'|'warn'|'signal'|'muted' (default muted). Decorative unless `label` is
 * given. Fewer than two numbers render an empty box of the same height.
 */
export function Sparkline({ values = [], height = 32, tone, label, class: classAttr, className }) {
  const points = (Array.isArray(values) ? values : [])
    .filter((v) => v !== null && v !== '' && Number.isFinite(Number(v)))
    .map(Number);
  if (points.length < 2) {
    return html`<span class=${cx('sparkline-empty', classAttr, className)} style=${{ height: `${height}px` }} aria-hidden="true"></span>`;
  }
  const color = TONE_COLORS[tone] ?? TONE_COLORS.muted;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const inset = 2; // keeps the 2px stroke inside the box
  const usable = Math.max(1, height - inset * 2);
  const yOf = (v) => (max === min ? height / 2 : inset + (1 - (v - min) / (max - min)) * usable);
  const coords = points.map((v, i) => [Number(((i / (points.length - 1)) * 100).toFixed(3)), Number(yOf(v).toFixed(2))]);
  const line = coords.map(([x, yv]) => `${x},${yv}`).join(' ');
  const area = `M0,${height} L${coords.map(([x, yv]) => `${x},${yv}`).join(' L')} L100,${height} Z`;

  return html`<svg
    class=${cx('sparkline', classAttr, className)}
    viewBox=${`0 0 100 ${height}`}
    preserveAspectRatio="none"
    width="100%"
    height=${height}
    role=${label ? 'img' : undefined}
    aria-label=${label || undefined}
    aria-hidden=${label ? undefined : 'true'}
    focusable="false"
  >
    <path d=${area} style=${`fill: ${color}; opacity: 0.1`} />
    <polyline
      points=${line}
      fill="none"
      style=${`stroke: ${color}`}
      stroke-width="2"
      stroke-linejoin="round"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>`;
}
