import { aggregateCandles } from './parse.js';

// Отрисовка графика курсов на canvas.
//
// Готовая библиотека здесь не подошла: нужны свечи, которые проявляются
// у ближайшей к курсору кривой, своя панорама с зумом по времени и жёсткая
// гарантия, что подписи не вылезут за пределы области. В chart.js всё это
// дорисовывается плагинами поверх его разметки и спорит с его же отступами.

const TIME_STEPS = [
  1e3, 5e3, 15e3, 30e3,
  60e3, 120e3, 300e3, 900e3, 1800e3,
  3600e3, 7200e3, 14400e3, 21600e3, 43200e3,
  86400e3, 172800e3, 604800e3,
];

const HOVER_RADIUS = 20;
// Насколько ближе должна оказаться соседняя кривая, чтобы перехватить
// наведение у текущей. Без этого запаса курсор между двумя кривыми
// заставляет свечи мигать, переключаясь туда-сюда на каждый пиксель.
const HOVER_HYSTERESIS = 10;
const MIN_POINTS_IN_VIEW = 3;
// Задержка перед тем, как отпустить кривую. Свечи не должны пропадать от
// случайного проскока мимо: курсор успевает вернуться, и рисунок не мигает.
const HOVER_LINGER = 420;
const MONO = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const palette = {
  grid: 'rgba(148, 163, 184, 0.09)',
  gridStrong: 'rgba(148, 163, 184, 0.20)',
  text: 'rgba(203, 213, 225, 0.80)',
  textDim: 'rgba(148, 163, 184, 0.65)',
  crosshair: 'rgba(226, 232, 240, 0.30)',
  up: '#16c784',
  down: '#ea3943',
  chipBg: 'rgba(12, 15, 22, 0.94)',
  chipText: '#e8edf7',
};

export function createPlot(host, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'plot-canvas';
  host.appendChild(canvas);

  const tip = document.createElement('div');
  tip.className = 'plot-tip is-hidden';
  host.appendChild(tip);

  const ctx = canvas.getContext('2d');
  const onHover = options.onHover || (() => {});
  const onViewChange = options.onViewChange || (() => {});

  const st = {
    series: [],
    mode: options.mode || 'absolute',
    view: null,
    bounds: null,
    range: null,
    follow: true,
    pointer: null,
    activeId: null,
    alpha: new Map(),
    reveal: 1,
    revealAt: 0,
    drag: null,
    release: null,
    zoomed: false,
    box: { w: 0, h: 0 },
    rect: { left: 0, top: 0, right: 0, bottom: 0 },
    frame: null,
    disposed: false,
  };

  // ——— значения и масштабы ——————————————————————————————————————

  function value(s, raw) {
    if (raw === undefined || raw === null || !Number.isFinite(raw)) return null;
    if (st.mode === 'percent') {
      if (!s.base) return null;
      return (raw / s.base - 1) * 100;
    }
    return raw;
  }

  function visible() {
    return st.series.filter((s) => !s.hidden && s.points.length > 0);
  }

  function lowerBound(points, t) {
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Края берутся с запасом на одну точку: иначе линия обрывается, не доходя
  // до границы области, и график выглядит короче своих данных.
  function slice(s, from, to) {
    const lo = Math.max(0, lowerBound(s.points, from) - 1);
    const hi = Math.min(s.points.length - 1, lowerBound(s.points, to));
    return { lo, hi };
  }

  function dataBounds() {
    let from = Infinity;
    let to = -Infinity;
    for (const s of visible()) {
      from = Math.min(from, s.points[0].t);
      to = Math.max(to, s.points[s.points.length - 1].t);
    }
    if (!Number.isFinite(from)) return null;
    if (to - from < 60e3) to = from + 60e3;
    return { from, to };
  }

  // Границы графика — это запрошенный период, а не только то, что в нём
  // нашлось. Иначе час и неделя с одинаково короткой историей выглядят
  // одинаково, и деления оси не меняются при переключении периода.
  function limits() {
    const data = dataBounds();
    if (!st.range) return data;
    if (!data) return { ...st.range };
    return {
      from: Math.min(data.from, st.range.from),
      to: Math.max(data.to, st.range.to),
    };
  }

  // Размах считается по максимумам и минимумам свечей, а не только по цене
  // закрытия: иначе появление свечей растягивало бы ось и график прыгал.
  function valueExtent(from, to) {
    let min = Infinity;
    let max = -Infinity;

    for (const s of visible()) {
      const { lo, hi } = slice(s, from, to);
      for (let i = lo; i <= hi; i += 1) {
        const p = s.points[i];
        const c = value(s, p.c);
        if (c === null) continue;
        const h = value(s, p.h) ?? c;
        const l = value(s, p.l) ?? c;
        if (l < min) min = l;
        if (c < min) min = c;
        if (h > max) max = h;
        if (c > max) max = c;
      }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

    let span = max - min;
    if (span <= 0) span = Math.abs(max) * 0.01 || 1;
    const pad = span * 0.08;
    return { min: min - pad, max: max + pad };
  }

  function niceTicks(min, max, count) {
    const raw = (max - min) / Math.max(2, count);
    if (!(raw > 0)) return [min];
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = mag * (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10);
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return ticks;
  }

  function tzOffset() {
    return -new Date().getTimezoneOffset() * 60e3;
  }

  // Суточные и недельные деления выравниваются по местной полуночи, иначе
  // подпись «28.10» стояла бы в три часа ночи двадцать восьмого.
  function alignDown(t, step) {
    const off = step >= 86400e3 ? tzOffset() : 0;
    return Math.floor((t + off) / step) * step - off;
  }

  function timeTicks(from, to, width) {
    const want = (to - from) / Math.max(2, Math.floor(width / 96));
    const step = TIME_STEPS.find((s) => s >= want) || TIME_STEPS[TIME_STEPS.length - 1];
    const ticks = [];
    for (let t = alignDown(from, step) + step; t <= to; t += step) ticks.push(t);
    return { ticks, step };
  }

  // ——— форматирование ——————————————————————————————————————————

  function digitsFor(scale) {
    const base = Math.abs(scale);
    if (!(base > 0)) return 2;
    if (base >= 1000) return 0;
    if (base >= 100) return 1;
    if (base >= 10) return 2;
    if (base >= 1) return 3;
    if (base >= 0.1) return 4;
    if (base >= 0.01) return 5;
    if (base >= 0.001) return 6;
    return 8;
  }

  function fmtAxis(v, span) {
    if (st.mode === 'percent') {
      // У почти неподвижного ряда все подписи сошлись бы в «+0.00%».
      const d = span >= 10 ? 1 : span >= 1 ? 2 : span >= 0.1 ? 3 : 4;
      return `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
    }
    const d = digitsFor(span / 6);
    return v.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtPrice(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const d = digitsFor(v);
    return v.toLocaleString('ru-RU', {
      minimumFractionDigits: Math.min(d, 2),
      maximumFractionDigits: d,
    });
  }

  function fmtTime(t, step) {
    const d = new Date(t);
    if (step < 60e3) {
      return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    if (step < 86400e3) {
      return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }

  function fmtFull(t) {
    const d = new Date(t);
    const date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `${date} ${time}`;
  }

  // ——— свечи ———————————————————————————————————————————————————

  // Шаг свечи подбирается под масштаб: при отдалении свечи укрупняются,
  // при приближении доходят до собственного шага ряда. Мельче ряд не даст —
  // между его точками данных нет. Ряд без OHLC (кросс-курс приходит одним
  // числом) собирается в свечи из нескольких своих точек, поэтому его шаг
  // берётся с запасом: иначе каждая свеча выродится в черту.
  function candleStep(s, span, width) {
    const want = span / Math.max(6, width / 12);
    const step = TIME_STEPS.find((x) => x >= want) || TIME_STEPS[TIME_STEPS.length - 1];
    const floor = s.ohlc ? s.stepMs || 0 : (s.stepMs || 60e3) * 4;
    return Math.max(step, floor);
  }

  function buildCandles(s, step, from, to) {
    const { lo, hi } = slice(s, from - step, to + step);
    const offset = step >= 86400e3 ? tzOffset() : 0;
    return aggregateCandles(s.points.slice(lo, hi + 1), step, offset);
  }

  // ——— геометрия ————————————————————————————————————————————————

  function seriesPath(s, from, to, x, y) {
    const { lo, hi } = slice(s, from, to);
    const pts = [];
    for (let i = lo; i <= hi; i += 1) {
      const v = value(s, s.points[i].c);
      if (v === null) continue;
      pts.push({ t: s.points[i].t, px: x(s.points[i].t), py: y(v), i });
    }

    // Суточный ряд тянется вправо последним известным значением: новых
    // котировок внутри суток нет, но курс всё это время действует. Точка
    // помечена служебной — свечу из неё не строят и маркер на неё не ставят.
    if (s.carry && pts.length > 0) {
      const last = pts[pts.length - 1];
      if (last.t < to && last.i === s.points.length - 1) {
        pts.push({ t: to, px: x(to), py: last.py, i: last.i, virtual: true });
      }
    }
    return pts;
  }

  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    if (len === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function nearestByTime(pts, t) {
    if (pts.length === 0) return null;
    let best = null;
    let bestd = Infinity;
    for (const p of pts) {
      if (p.virtual) continue;
      const d = Math.abs(p.t - t);
      if (d < bestd) {
        bestd = d;
        best = p;
      }
    }
    return best;
  }

  function hoveredTime() {
    if (!st.pointer || !st.view) return null;
    const { left, right } = st.rect;
    if (st.pointer.x < left - 2 || st.pointer.x > right + 2) return null;
    const ratio = (st.pointer.x - left) / Math.max(1, right - left);
    return st.view.from + ratio * (st.view.to - st.view.from);
  }

  // ——— размеры ——————————————————————————————————————————————————

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w === 0 || h === 0) return;

    st.box = { w, h };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    schedule();
  }

  // ——— анимация ————————————————————————————————————————————————

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function animating() {
    if (st.revealAt) return true;
    for (const s of st.series) {
      const target = st.activeId === s.id ? 1 : 0;
      if (Math.abs((st.alpha.get(s.id) || 0) - target) > 0.004) return true;
    }
    return false;
  }

  function stepAnimations() {
    if (st.revealAt) {
      const t = Math.min(1, (performance.now() - st.revealAt) / 420);
      st.reveal = easeOut(t);
      if (t >= 1) st.revealAt = 0;
    }
    for (const s of st.series) {
      const target = st.activeId === s.id ? 1 : 0;
      const cur = st.alpha.get(s.id) || 0;
      st.alpha.set(s.id, Math.abs(target - cur) < 0.004 ? target : cur + (target - cur) * 0.16);
    }
  }

  function schedule() {
    if (st.frame || st.disposed) return;
    st.frame = requestAnimationFrame(() => {
      st.frame = null;
      draw();
      if (animating()) schedule();
    });
  }

  // ——— рисование ————————————————————————————————————————————————

  function draw() {
    const { w, h } = st.box;
    if (!w || !h) return;

    ctx.clearRect(0, 0, w, h);
    stepAnimations();

    const list = visible();
    if (list.length === 0 || !st.view) {
      tip.classList.add('is-hidden');
      onHover(null);
      return;
    }

    const { from, to } = st.view;
    const extent = valueExtent(from, to);
    if (!extent) return;

    const span = extent.max - extent.min;
    ctx.font = MONO;

    // Отступ слева считается по самой широкой подписи оси: только так числа
    // гарантированно не выходят за край панели при любом порядке величин.
    const ticks = niceTicks(extent.min, extent.max, Math.max(2, Math.floor(h / 48)));
    let labelW = 0;
    for (const v of ticks) labelW = Math.max(labelW, ctx.measureText(fmtAxis(v, span)).width);

    const rect = {
      left: Math.ceil(labelW) + 16,
      top: 16,
      right: w - 14,
      bottom: h - 26,
    };
    st.rect = rect;
    const pw = rect.right - rect.left;
    const ph = rect.bottom - rect.top;
    if (pw <= 20 || ph <= 20) return;

    const x = (t) => rect.left + ((t - from) / (to - from)) * pw;
    const y = (v) => rect.top + ((extent.max - v) / span) * ph;

    drawValueAxis(ticks, span, rect, y);
    const timeStep = drawTimeAxis(from, to, rect, pw, x);

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.left, rect.top - 4, pw, ph + 8);
    ctx.clip();

    const paths = new Map();
    for (const s of list) paths.set(s.id, seriesPath(s, from, to, x, y));

    drawLines(list, paths, rect, ph);
    const active = drawCandles(list, rect, ph, from, to, pw, x, y);
    const markers = drawCrosshair(list, paths, rect);

    ctx.restore();

    drawAxisChips(rect, extent, span, ph, x);
    updateTip(active, markers);

    const hovered = hoveredTime();
    onHover(
      markers.length
        ? { time: hovered, values: markers.map((m) => ({ id: m.s.id, point: m.s.points[m.p.i] })) }
        : null,
    );
    void timeStep;
  }

  function drawValueAxis(ticks, span, rect, y) {
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const v of ticks) {
      const py = Math.round(y(v)) + 0.5;
      if (py < rect.top - 1 || py > rect.bottom + 1) continue;
      ctx.strokeStyle = palette.grid;
      ctx.beginPath();
      ctx.moveTo(rect.left, py);
      ctx.lineTo(rect.right, py);
      ctx.stroke();
      ctx.fillStyle = palette.text;
      ctx.fillText(fmtAxis(v, span), rect.left - 8, py);
    }
  }

  function drawTimeAxis(from, to, rect, pw, x) {
    const { ticks, step } = timeTicks(from, to, pw);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    let lastRight = -Infinity;

    for (const t of ticks) {
      const px = Math.round(x(t)) + 0.5;
      ctx.strokeStyle = palette.grid;
      ctx.beginPath();
      ctx.moveTo(px, rect.top);
      ctx.lineTo(px, rect.bottom);
      ctx.stroke();

      const label = fmtTime(t, step);
      const tw = ctx.measureText(label).width;
      let cx = Math.min(Math.max(px, rect.left + tw / 2), rect.right - tw / 2);
      if (cx - tw / 2 < lastRight + 12) continue;
      lastRight = cx + tw / 2;
      ctx.fillStyle = palette.textDim;
      ctx.fillText(label, cx, rect.bottom + 8);
    }

    ctx.strokeStyle = palette.gridStrong;
    ctx.beginPath();
    ctx.moveTo(rect.left, Math.round(rect.bottom) + 0.5);
    ctx.lineTo(rect.right, Math.round(rect.bottom) + 0.5);
    ctx.stroke();
    return step;
  }

  function drawLines(list, paths, rect, ph) {
    const revealW = Math.max(0, (rect.right - rect.left) * st.reveal);
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.left, rect.top - 4, revealW, ph + 8);
    ctx.clip();

    for (const s of list) {
      const pts = paths.get(s.id);
      if (pts.length === 0) continue;
      const alpha = st.alpha.get(s.id) || 0;
      const dim = st.activeId !== null && st.activeId !== s.id;
      const fillAlpha = list.length === 1 ? 1 : alpha;

      if (fillAlpha > 0.01) {
        const grad = ctx.createLinearGradient(0, rect.top, 0, rect.bottom);
        grad.addColorStop(0, withAlpha(s.color, 0.28 * fillAlpha));
        grad.addColorStop(1, withAlpha(s.color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        tracePath(ctx, pts, s.stepped);
        ctx.lineTo(pts[pts.length - 1].px, rect.bottom + 4);
        ctx.lineTo(pts[0].px, rect.bottom + 4);
        ctx.closePath();
        ctx.fill();
      }

      ctx.globalAlpha = dim ? 0.42 : 1;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = st.activeId === s.id ? 2.4 : 1.8;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      tracePath(ctx, pts, s.stepped);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawCandles(list, rect, ph, from, to, pw, x, y) {
    const hovered = hoveredTime();
    let found = null;

    for (const s of list) {
      const alpha = st.alpha.get(s.id) || 0;
      if (alpha < 0.02) continue;

      const step = candleStep(s, to - from, pw);
      const slot = (step / (to - from)) * pw;
      if (slot < 2.5) continue;

      const bodyW = Math.max(1, Math.min(slot * 0.62, 140));
      const candles = buildCandles(s, step, from, to);

      for (const c of candles) {
        const cx = x(c.t + c.w / 2);
        if (cx < rect.left - slot || cx > rect.right + slot) continue;

        const vo = value(s, c.o);
        const vc = value(s, c.c);
        const vh = value(s, c.h);
        const vl = value(s, c.l);
        if (vo === null || vc === null) continue;

        const inside = hovered !== null && hovered >= c.t && hovered < c.t + c.w;
        if (inside && s.id === st.activeId) found = { series: s, candle: c };

        const col = c.c >= c.o ? palette.up : palette.down;
        const top = Math.min(y(vo), y(vc));
        const height = Math.max(1, Math.abs(y(vo) - y(vc)));
        const left = cx - bodyW / 2;

        if (inside) {
          ctx.globalAlpha = alpha * 0.14;
          ctx.fillStyle = col;
          ctx.fillRect(cx - slot / 2, rect.top, slot, ph);
        }

        ctx.globalAlpha = alpha * (inside ? 1 : 0.78);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        const wick = Math.round(cx) + 0.5;
        ctx.beginPath();
        ctx.moveTo(wick, y(vh));
        ctx.lineTo(wick, y(vl));
        ctx.stroke();

        // Широкая свеча — это суточный фиатный курс, растянутый на свой
        // интервал. Заливка у неё слабее, иначе она перекрывает кривые.
        ctx.fillStyle = col;
        ctx.globalAlpha = alpha * (inside ? 0.9 : bodyW > 44 ? 0.24 : 0.6);
        ctx.fillRect(left, top, bodyW, height);
        ctx.globalAlpha = alpha * (inside ? 1 : 0.85);
        ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.max(1, Math.round(bodyW) - 1), Math.max(1, Math.round(height) - 1));
      }
      ctx.globalAlpha = 1;
    }
    return found;
  }

  function drawCrosshair(list, paths, rect) {
    const hovered = hoveredTime();
    if (!st.pointer || hovered === null) return [];

    const x = (t) => rect.left + ((t - st.view.from) / (st.view.to - st.view.from)) * (rect.right - rect.left);
    const hx = Math.round(x(hovered)) + 0.5;

    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = palette.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, rect.top);
    ctx.lineTo(hx, rect.bottom);
    ctx.stroke();
    if (st.pointer.y > rect.top && st.pointer.y < rect.bottom) {
      const hy = Math.round(st.pointer.y) + 0.5;
      ctx.beginPath();
      ctx.moveTo(rect.left, hy);
      ctx.lineTo(rect.right, hy);
      ctx.stroke();
    }
    ctx.restore();

    const markers = [];
    for (const s of list) {
      const near = nearestByTime(paths.get(s.id), hovered);
      if (!near) continue;
      markers.push({ s, p: near });

      ctx.globalAlpha = st.activeId && st.activeId !== s.id ? 0.45 : 1;
      ctx.beginPath();
      ctx.fillStyle = s.color;
      ctx.arc(near.px, near.py, st.activeId === s.id ? 4.5 : 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(8, 10, 16, 0.85)';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    return markers;
  }

  function drawAxisChips(rect, extent, span, ph, x) {
    if (!st.pointer) return;
    if (st.pointer.y > rect.top && st.pointer.y < rect.bottom) {
      const v = extent.max - ((st.pointer.y - rect.top) / ph) * span;
      drawChip(fmtAxis(v, span), rect.left - 6, st.pointer.y, 'right');
    }
    const hovered = hoveredTime();
    if (hovered !== null) {
      drawChip(fmtFull(hovered), x(hovered), rect.bottom + 7, 'center');
    }
  }

  function tracePath(c, pts, stepped) {
    c.moveTo(pts[0].px, pts[0].py);
    for (let i = 1; i < pts.length; i += 1) {
      if (stepped) c.lineTo(pts[i].px, pts[i - 1].py);
      c.lineTo(pts[i].px, pts[i].py);
    }
  }

  function drawChip(text, px, py, align) {
    ctx.font = MONO;
    const w = ctx.measureText(text).width + 12;
    const h = 18;
    let left = align === 'right' ? px - w : align === 'center' ? px - w / 2 : px;
    let top = align === 'center' ? py : py - h / 2;
    left = Math.max(2, Math.min(left, st.box.w - w - 2));
    top = Math.max(2, Math.min(top, st.box.h - h - 2));

    ctx.fillStyle = palette.chipBg;
    roundRect(left, top, w, h, 4);
    ctx.fill();
    ctx.strokeStyle = palette.gridStrong;
    ctx.lineWidth = 1;
    roundRect(left + 0.5, top + 0.5, w - 1, h - 1, 4);
    ctx.stroke();
    ctx.fillStyle = palette.chipText;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + 6, top + h / 2);
  }

  function roundRect(x0, y0, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
    ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
    ctx.arcTo(x0, y0 + h, x0, y0, r);
    ctx.arcTo(x0, y0, x0 + w, y0, r);
    ctx.closePath();
  }

  // ——— подсказка ————————————————————————————————————————————————

  function updateTip(active, markers) {
    const hovered = hoveredTime();
    if (!st.pointer || hovered === null || (!active && markers.length === 0)) {
      tip.classList.add('is-hidden');
      return;
    }

    if (active) {
      const { series: s, candle: c } = active;
      const up = c.c >= c.o;
      const delta = c.o ? ((c.c / c.o - 1) * 100).toFixed(2) : '0.00';
      const width = c.w >= 86400e3 ? ' · суточная свеча' : '';
      tip.innerHTML = `
        <div class="plot-tip-head">
          <span class="plot-tip-dot" style="background:${s.color}"></span>
          <b>${s.label}</b>
          <span class="plot-tip-when">${fmtFull(c.t)}</span>
        </div>
        <div class="plot-tip-ohlc">
          <span><i>O</i>${fmtPrice(c.o)}</span>
          <span><i>H</i>${fmtPrice(c.h)}</span>
          <span><i>L</i>${fmtPrice(c.l)}</span>
          <span><i>C</i>${fmtPrice(c.c)}</span>
        </div>
        <div class="plot-tip-foot">
          <span class="${up ? 'is-up' : 'is-down'}">${up ? '+' : ''}${delta}%</span>
          <span class="plot-tip-when">${c.v ? `объём ${fmtPrice(c.v)}` : `${c.n} ${plural(c.n, 'точка', 'точки', 'точек')}`}${width}</span>
        </div>`;
    } else {
      const rows = markers
        .map(
          (m) => `<span><span class="plot-tip-dot" style="background:${m.s.color}"></span>${m.s.label}
            <b>${fmtPrice(m.s.points[m.p.i].c)}</b></span>`,
        )
        .join('');
      tip.innerHTML = `
        <div class="plot-tip-head"><span class="plot-tip-when">${fmtFull(hovered)}</span></div>
        <div class="plot-tip-rows">${rows}</div>
        <div class="plot-tip-foot"><span class="plot-tip-when">наведите курсор на кривую — появятся свечи</span></div>`;
    }

    tip.classList.remove('is-hidden');

    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = st.pointer.x + 18;
    if (left + tw > st.box.w - 6) left = st.pointer.x - tw - 18;
    left = Math.max(6, Math.min(left, Math.max(6, st.box.w - tw - 6)));
    let top = st.pointer.y - th - 16;
    if (top < 6) top = st.pointer.y + 20;
    top = Math.max(6, Math.min(top, Math.max(6, st.box.h - th - 6)));
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  // ——— ввод ————————————————————————————————————————————————————

  // Свечи — продолжение своей кривой: пока курсор внутри свечи, кривая
  // остаётся активной, даже если сама линия уже далеко. Иначе свечи гаснут
  // ровно в тот момент, когда к ним подводят мышь.
  function pointerOnCandle(s, from, to, pw, rect, x, y) {
    if ((st.alpha.get(s.id) || 0) < 0.3) return false;

    const step = candleStep(s, to - from, pw);
    const slot = (step / (to - from)) * pw;
    if (slot < 2.5) return false;

    const at = from + ((st.pointer.x - rect.left) / pw) * (to - from);
    for (const c of buildCandles(s, step, from, to)) {
      if (at < c.t || at >= c.t + c.w) continue;
      const high = value(s, c.h);
      const low = value(s, c.l);
      if (high === null || low === null) return false;
      return st.pointer.y >= y(high) - 8 && st.pointer.y <= y(low) + 8;
    }
    return false;
  }

  // Активной становится кривая, до которой от курсора меньше HOVER_RADIUS
  // пикселей. Расстояние считается до отрезков, а не до точек: между двумя
  // точками кривая тоже есть, и наводить надо на неё, а не на узлы.
  function pickActive() {
    if (!st.pointer || !st.view) {
      setActive(null);
      return;
    }
    const rect = st.rect;
    const pw = rect.right - rect.left;
    const ph = rect.bottom - rect.top;
    if (pw <= 0 || ph <= 0) return;

    const { from, to } = st.view;
    const extent = valueExtent(from, to);
    if (!extent) return;
    const span = extent.max - extent.min;
    const x = (t) => rect.left + ((t - from) / (to - from)) * pw;
    const y = (v) => rect.top + ((extent.max - v) / span) * ph;
    const cursorTime = from + ((st.pointer.x - rect.left) / pw) * (to - from);

    let bestId = null;
    let bestD = HOVER_RADIUS;
    const distance = new Map();

    for (const s of visible()) {
      const pts = seriesPath(s, from, to, x, y);
      if (pts.length === 0) continue;

      if (pts.length === 1) {
        const d = Math.hypot(st.pointer.x - pts[0].px, st.pointer.y - pts[0].py);
        distance.set(s.id, d);
        if (d < bestD) {
          bestD = d;
          bestId = s.id;
        }
        continue;
      }

      // Хватает нескольких отрезков вокруг курсора: дальше кривая уже не
      // может оказаться ближе, а полный перебор тысячи точек на каждом
      // движении мыши заметен.
      const at = Math.max(0, lowerBound(pts, cursorTime) - 3);
      let near = Infinity;
      for (let i = at; i < Math.min(pts.length - 1, at + 7); i += 1) {
        const d = distToSegment(st.pointer.x, st.pointer.y, pts[i].px, pts[i].py, pts[i + 1].px, pts[i + 1].py);
        if (d < near) near = d;
      }
      distance.set(s.id, near);
      if (near < bestD) {
        bestD = near;
        bestId = s.id;
      }
    }

    setActive(holdActive(bestId, bestD, distance, from, to, pw, rect, x, y));
  }

  // Кривая отпускается не сразу: пока идёт отсчёт, свечи остаются на месте,
  // и возврат курсора отменяет его. Переход на другую кривую мгновенный —
  // ждать там нечего.
  function setActive(id) {
    if (id !== null) {
      clearTimeout(st.release);
      st.release = null;
      st.activeId = id;
      return;
    }
    if (st.activeId === null || st.release) return;

    st.release = setTimeout(() => {
      st.release = null;
      st.activeId = null;
      schedule();
    }, HOVER_LINGER);
  }

  // Текущая кривая удерживает наведение, пока курсор на ней самой или на её
  // свече. Соседняя перехватывает его, только если оказалась заметно ближе,
  // — иначе переключение дёргалось бы на каждом движении мыши.
  function holdActive(bestId, bestD, distance, from, to, pw, rect, x, y) {
    const prev = st.activeId;
    if (!prev || prev === bestId) return bestId;

    const kept = visible().find((s) => s.id === prev);
    if (!kept) return bestId;

    if (pointerOnCandle(kept, from, to, pw, rect, x, y)) return prev;

    const near = distance.get(prev);
    if (near === undefined || near > HOVER_RADIUS) return bestId;
    return bestId && bestD + HOVER_HYSTERESIS < near ? bestId : prev;
  }

  function pointerAt(e) {
    const box = canvas.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  function onPointerMove(e) {
    st.pointer = pointerAt(e);

    if (st.drag) {
      const pw = st.rect.right - st.rect.left;
      const span = st.drag.to - st.drag.from;
      const shift = (-(st.pointer.x - st.drag.x) / pw) * span;
      setView(st.drag.from + shift, st.drag.to + shift);
      st.zoomed = true;
      st.follow = atRightEdge();
      onViewChange();
      schedule();
      return;
    }

    pickActive();
    schedule();
  }

  function onPointerLeave() {
    st.pointer = null;
    setActive(null);
    tip.classList.add('is-hidden');
    onHover(null);
    schedule();
  }

  function onPointerDown(e) {
    if (e.button !== 0 || !st.view) return;
    canvas.setPointerCapture(e.pointerId);
    st.drag = { x: pointerAt(e).x, from: st.view.from, to: st.view.to };
    canvas.classList.add('is-dragging');
  }

  function onPointerUp(e) {
    if (!st.drag) return;
    st.drag = null;
    canvas.classList.remove('is-dragging');
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    pickActive();
    schedule();
  }

  function onWheel(e) {
    // Колесо над графиком всегда остаётся графику: случайная прокрутка
    // страницы в тот момент, когда масштаб уже доведён до предела,
    // сбивает просмотр.
    e.preventDefault();
    if (!st.view || !st.bounds) return;
    if (st.pointer && (st.pointer.x < st.rect.left || st.pointer.x > st.rect.right)) return;

    const pw = st.rect.right - st.rect.left;
    const span = st.view.to - st.view.from;
    const ratio = st.pointer ? Math.max(0, Math.min(1, (st.pointer.x - st.rect.left) / pw)) : 0.5;
    const anchor = st.view.from + ratio * span;
    const next = span * Math.exp((e.deltaY > 0 ? 1 : -1) * 0.2);
    const before = st.view;

    setView(anchor - ratio * next, anchor + (1 - ratio) * next);
    if (st.view.from === before.from && st.view.to === before.to) return;
    st.zoomed = true;
    st.follow = atRightEdge();
    pickActive();
    onViewChange();
    schedule();
  }

  // Шаг сдвига окна равен ширине свечи при текущем масштабе: окно едет
  // ровно тогда, когда на графике начинается новая свеча.
  function followStep(span) {
    const pw = Math.max(1, st.rect.right - st.rect.left);
    const want = span / Math.max(6, pw / 12);
    return TIME_STEPS.find((s) => s >= want) || TIME_STEPS[TIME_STEPS.length - 1];
  }

  function atRightEdge() {
    if (!st.view || !st.bounds) return true;
    return st.view.to >= st.bounds.to - (st.view.to - st.view.from) * 0.03;
  }

  // Нижний предел приближения — несколько свечей ряда, но не больше
  // половины всего окна. Иначе у суточного ряда на однодневном периоде
  // предел (три свечи, то есть трое суток) оказывается шире самого окна,
  // и первое же движение мыши растягивает график до этого предела,
  // после чего он намертво упирается в границы и перестаёт двигаться.
  function minSpan() {
    let step = Infinity;
    for (const s of visible()) step = Math.min(step, s.stepMs || 60e3);
    if (!Number.isFinite(step)) step = 60e3;

    const wanted = step * MIN_POINTS_IN_VIEW;
    const full = st.bounds ? st.bounds.to - st.bounds.from : wanted;
    return Math.min(wanted, full / 2);
  }

  // Окно всегда остаётся внутри данных: уехать в пустоту и потерять кривую
  // из вида нельзя ни перетаскиванием, ни колесом.
  function setView(from, to) {
    const b = st.bounds;
    if (!b) return;
    const full = b.to - b.from;
    const span = Math.max(minSpan(), Math.min(to - from, full * 1.08));
    const pad = full * 0.03;

    let lo = Math.max(from, b.from - pad);
    let hi = lo + span;
    if (hi > b.to + pad) {
      hi = b.to + pad;
      lo = hi - span;
    }
    st.view = { from: lo, to: hi };
  }

  function resetView() {
    st.bounds = limits();
    if (!st.bounds) {
      st.view = null;
      return;
    }
    if (st.range) {
      st.view = { ...st.range };
    } else {
      const pad = (st.bounds.to - st.bounds.from) * 0.02;
      st.view = { from: st.bounds.from - pad, to: st.bounds.to + pad };
    }
    st.follow = true;
    st.zoomed = false;
    onViewChange();
    schedule();
  }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', resetView);

  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  return {
    setSeries(series, { keepView = false, range = null, animate = true } = {}) {
      st.range = range;
      st.series = series.map((s) => ({
        hidden: false,
        stepped: false,
        carry: false,
        ohlc: false,
        stepMs: 60e3,
        base: s.points && s.points.length ? s.points[0].c : 1,
        ...s,
      }));
      for (const s of st.series) if (!st.alpha.has(s.id)) st.alpha.set(s.id, 0);

      const prev = st.view;
      st.bounds = limits();
      if (keepView && prev && st.bounds) setView(prev.from, prev.to);
      else resetView();

      // Перерисовка по таймеру идёт без вычерчивания: мигание кривой раз
      // в минуту выглядело бы как сбой, а не как обновление.
      const quiet = keepView || !animate;
      st.reveal = quiet ? 1 : 0;
      st.revealAt = quiet ? 0 : performance.now();
      schedule();
    },

    setMode(mode) {
      st.mode = mode;
      schedule();
    },

    toggleSeries(id, hidden) {
      const s = st.series.find((x) => x.id === id);
      if (s) s.hidden = hidden;
      pickActive();
      schedule();
    },

    // Поток реального времени: точка уходит в конец ряда, а окно сдвигается
    // только если пользователь сам не ушёл с правого края.
    appendPoint(id, point, windowMs) {
      const s = st.series.find((x) => x.id === id);
      if (!s) return;
      s.points.push(point);
      if (windowMs) {
        const edge = point.t - windowMs;
        while (s.points.length > 2 && s.points[0].t < edge) s.points.shift();
      }
      st.bounds = limits();
      if (st.follow && st.view && st.bounds) {
        // Окно сдвигается не на каждую секунду, а ступенями в одну свечу:
        // иначе вся кривая ползёт влево на пиксель каждую секунду и рябит.
        // Между сдвигами график стоит на месте, а новая точка просто
        // дорисовывается справа.
        const span = Math.max(st.view.to - st.view.from, st.zoomed ? 0 : st.bounds.to - st.bounds.from);
        const step = followStep(span);
        const edge = Math.ceil(st.bounds.to / step) * step;
        if (edge > st.view.to) st.view = { from: edge - span, to: edge };
      }
      schedule();
    },

    resetView,

    // Сравнение с тем окном, которое показывается по умолчанию: у периода
    // это он сам, и приближением считается уход от него, а не от границ
    // данных — иначе кнопка сброса горела бы сразу после загрузки.
    isZoomed() {
      const base = st.range || st.bounds;
      if (!st.view || !base) return false;
      const full = base.to - base.from;
      return st.view.to - st.view.from < full * 0.95
        || Math.abs(st.view.from - base.from) > full * 0.05;
    },

    destroy() {
      st.disposed = true;
      clearTimeout(st.release);
      if (st.frame) cancelAnimationFrame(st.frame);
      ro.disconnect();
      canvas.remove();
      tip.remove();
    },
  };
}

function plural(n, one, few, many) {
  const tail = n % 10;
  const hundred = n % 100;
  if (tail === 1 && hundred !== 11) return one;
  if (tail >= 2 && tail <= 4 && (hundred < 10 || hundred >= 20)) return few;
  return many;
}

function withAlpha(color, alpha) {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return color;
}
