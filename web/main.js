import { createPlot } from './plot.js';
import { createToaster } from './toast.js';
import { enhanceSelect, enhanceNumber, enhanceSearch } from './ui.js';
import {
  trimZeros,
  parseHistory,
  parseStreamMessage,
  crossRate,
  buildAlertPayload,
  describeAlert,
  errorText,
} from './parse.js';

const el = (id) => document.getElementById(id);
const toaster = createToaster();

// Системные списки и счётчики заменяются своими сразу: дальше код работает
// с теми же элементами и ничего не знает о подмене.
['alert-target', 'alert-kind', 'alert-window', 'base-asset', 'quote-asset'].forEach((id) => enhanceSelect(el(id)));
const alertValue = enhanceNumber(el('alert-value'));
enhanceSearch(el('watchlist-filter'));

const COLORS = { cross: '#2de2a4', base: '#38bdf8', quote: '#f0b429', rt: '#2de2a4' };
const PERIOD_LABEL = { '1h': 'за час', '4h': 'за 4 часа', '1d': 'за сутки', '1w': 'за неделю', rt: 'за 15 минут' };
const RESOLUTION_NAME = { 1: '1 минута', 5: '5 минут', 60: '1 час', 1440: '1 сутки' };
const RT_WINDOW_MS = 15 * 60e3;

const state = {
  token: localStorage.getItem('token'),
  expiresAt: localStorage.getItem('expires_at'),
  email: localStorage.getItem('email') || '',
  isRegister: false,
  assets: [],
  watchlist: [],
  selectedPair: null,
  period: '1h',
  mode: 'cross',
  filter: '',
  alerts: [],
  series: [],
  seen: new Set(),
  notificationsReady: false,
  refreshTimer: null,
  notifyTimer: null,
  chartTimer: null,
};

let plot = null;

// ——— обращения к серверу ————————————————————————————————————————

async function api(path, options = {}) {
  if (state.token && state.expiresAt && new Date(state.expiresAt) <= new Date()) {
    logout('Срок сессии истёк. Войдите снова.');
    throw new Error('Session expired');
  }

  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(`/api${path}`, { ...options, headers });

  if (res.status === 401 && !path.startsWith('/auth/')) {
    logout('Сессия недействительна. Выполните вход.');
    throw new Error('Unauthorized');
  }

  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(errorText(data));
    err.status = res.status;
    throw err;
  }
  return data;
}

// ——— форматирование ————————————————————————————————————————————

function digitsFor(value) {
  const base = Math.abs(value);
  if (!(base > 0)) return 2;
  if (base >= 1000) return 2;
  if (base >= 1) return 4;
  if (base >= 0.01) return 6;
  return 8;
}

function formatRate(value) {
  const num = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(num)) return '—';
  const d = digitsFor(num);
  return num.toLocaleString('ru-RU', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
}

function formatPercent(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)} %`;
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Свежесть пары считается по наиболее отставшей стороне, а у фиата это может
// быть вчерашняя полночь. Одно время без даты в таком случае обманывает.
function formatWhen(iso) {
  if (!iso) return '—';
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay
    ? at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : at.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ——— вход и регистрация ————————————————————————————————————————

function setSession(token, expiresAt, email) {
  state.token = token;
  state.expiresAt = expiresAt;
  state.email = email;
  localStorage.setItem('token', token);
  localStorage.setItem('expires_at', expiresAt);
  localStorage.setItem('email', email);
}

function logout(message = '') {
  stopStream();
  clearInterval(state.refreshTimer);
  clearInterval(state.notifyTimer);
  clearInterval(state.chartTimer);
  state.token = null;
  state.expiresAt = null;
  state.selectedPair = null;
  state.watchlist = [];
  state.seen = new Set();
  state.notificationsReady = false;
  localStorage.removeItem('token');
  localStorage.removeItem('expires_at');

  state.alerts = [];
  state.period = '1h';
  markPeriod('1h');
  resetHead();
  renderAlerts();

  el('auth-view').classList.remove('is-hidden');
  el('app-view').classList.add('is-hidden');
  if (message) showAuthError(message);
}

function showAuthError(message) {
  const box = el('auth-error');
  box.textContent = message;
  box.classList.remove('is-hidden');
}

function setAuthMode(mode) {
  state.isRegister = mode === 'register';
  el('auth-error').classList.add('is-hidden');
  el('auth-submit').textContent = state.isRegister ? 'Создать аккаунт' : 'Войти';
  el('auth-password').autocomplete = state.isRegister ? 'new-password' : 'current-password';
  document.querySelectorAll('[data-auth-mode]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.authMode === mode);
  });
}

document.querySelectorAll('[data-auth-mode]').forEach((btn) => {
  btn.addEventListener('click', () => setAuthMode(btn.dataset.authMode));
});

el('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('auth-error').classList.add('is-hidden');

  const email = el('auth-email').value.trim();
  const password = el('auth-password').value;
  if (password.length < 8) {
    showAuthError('Пароль должен быть не короче 8 символов');
    return;
  }

  const submit = el('auth-submit');
  submit.disabled = true;

  try {
    const res = await api(state.isRegister ? '/auth/register' : '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setSession(res.token, res.expires_at, email);
    enterApp();
  } catch (err) {
    if (err.status === 409) showAuthError('Пользователь с таким адресом уже существует');
    else if (err.status === 401) showAuthError('Неверный адрес или пароль');
    else showAuthError(err.message || 'Не удалось связаться с сервером');
  } finally {
    submit.disabled = false;
  }
});

el('logout-btn').addEventListener('click', () => logout());

// ——— запуск приложения ————————————————————————————————————————

function enterApp() {
  el('auth-view').classList.add('is-hidden');
  el('app-view').classList.remove('is-hidden');
  el('user-email').textContent = state.email || 'аккаунт';

  loadAssets();
  loadWatchlist();
  loadAlerts();
  pollNotifications();

  clearInterval(state.refreshTimer);
  clearInterval(state.notifyTimer);
  clearInterval(state.chartTimer);
  state.refreshTimer = setInterval(loadWatchlist, 60000);
  state.notifyTimer = setInterval(pollNotifications, 15000);

  // Свечи приходят раз в минуту, поэтому и график перечитывается раз
  // в минуту. В потоковом режиме обновлять нечего — там свой сокет.
  state.chartTimer = setInterval(() => {
    if (state.selectedPair && state.period !== 'rt') loadChart({ quiet: true });
  }, 60000);
}

function ensurePlot() {
  if (!plot) {
    plot = createPlot(el('chart-stage'), {
      onHover: updateLegendValues,
      onViewChange: () => el('reset-zoom').classList.toggle('is-hidden', !plot || !plot.isZoomed()),
    });
  }
  return plot;
}

async function loadAssets() {
  try {
    state.assets = await api('/assets');
    fillAssetSelects();
  } catch (err) {
    toaster.show({ kind: 'error', title: 'Справочник активов недоступен', text: err.message });
  }
}

async function loadWatchlist() {
  try {
    state.watchlist = await api('/watchlist');
    if (state.selectedPair) {
      const fresh = state.watchlist.find((p) => p.id === state.selectedPair.id);
      if (fresh) {
        state.selectedPair = fresh;
        renderPairHead(fresh);
      }
    }
    renderWatchlist();

    // Пустой экран после входа не нужен: открывается первая пара списка.
    if (!state.selectedPair && state.watchlist.length > 0) selectPair(state.watchlist[0]);
  } catch (err) {
    console.warn('Список пар не обновлён:', err);
  }
}

// ——— список пар ————————————————————————————————————————————————

el('watchlist-filter').addEventListener('input', (e) => {
  state.filter = e.target.value.trim().toUpperCase();
  renderWatchlist();
});

function renderWatchlist() {
  const box = el('watchlist');
  const list = state.watchlist.filter((p) => {
    if (!state.filter) return true;
    return `${p.base.symbol}/${p.quote.symbol}`.includes(state.filter);
  });

  el('watchlist-count').textContent = state.watchlist.length;
  box.innerHTML = '';

  if (state.watchlist.length === 0) {
    box.innerHTML = `<div class="empty-box">Пока нет отслеживаемых пар.<br>Добавьте первую кнопкой ниже.</div>`;
    return;
  }
  if (list.length === 0) {
    box.innerHTML = `<div class="empty-box">Ничего не найдено по запросу «${state.filter}»</div>`;
    return;
  }

  for (const pair of list) {
    const card = document.createElement('div');
    card.className = 'pair-card' + (state.selectedPair && state.selectedPair.id === pair.id ? ' is-active' : '');
    card.innerHTML = `
      <div class="pair-card-top">
        <span class="pair-name">${pair.base.symbol} <span>/</span> ${pair.quote.symbol}</span>
        <button class="card-remove icon-x" type="button" aria-label="Убрать пару"></button>
      </div>
      <div class="pair-card-top">
        <span class="pair-card-rate">${formatRate(pair.rate)}</span>
        ${pair.stale ? '<span class="stale-tag">устарело</span>' : ''}
      </div>
      <div class="pair-card-bottom">
        <span>
          <span class="type-tag is-${pair.base.type}">${pair.base.type}</span>
          <span class="type-tag is-${pair.quote.type}">${pair.quote.type}</span>
        </span>
        <span>${pair.updated_at ? formatWhen(pair.updated_at) : 'нет котировок'}</span>
      </div>`;

    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('card-remove')) return;
      selectPair(pair);
    });
    card.querySelector('.card-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removePair(pair);
    });

    box.appendChild(card);
  }
}

async function removePair(pair) {
  try {
    await api(`/watchlist/${pair.id}`, { method: 'DELETE' });
    if (state.selectedPair && state.selectedPair.id === pair.id) {
      state.selectedPair = null;
      stopStream();
      resetHead();
    }
    await loadWatchlist();
    await loadAlerts();
    toaster.show({ kind: 'info', title: 'Пара убрана', text: `${pair.base.symbol}/${pair.quote.symbol} больше не отслеживается`, timeout: 4000 });
  } catch (err) {
    toaster.show({ kind: 'error', title: 'Не удалось убрать пару', text: err.message });
  }
}

function samePair(pair) {
  return Boolean(pair && state.selectedPair && state.selectedPair.id === pair.id);
}

function selectPair(pair) {
  state.selectedPair = pair;
  renderWatchlist();
  renderPairHead(pair);
  updateAlertTargets();

  // Пара из двух фиатов не живёт на коротких периодах, и переключение само
  // перерисует график. Иначе он грузился бы дважды.
  if (!applyPeriodRules(pair)) loadChart();
}

function resetHead() {
  el('pair-title').textContent = 'Выберите пару';
  el('pair-badges').innerHTML = '';
  el('pair-rate').textContent = '—';
  el('pair-change').textContent = '';
  el('pair-change').className = 'delta';
  el('pair-meta').textContent = 'Слева выберите пару или добавьте новую';
  el('chart-legend').innerHTML = '';
  el('chart-meta').textContent = '';
  renderAnalytics(null);
  showChartEmpty('Выберите пару в списке слева');
}

function renderPairHead(pair) {
  el('pair-title').textContent = `${pair.base.symbol} / ${pair.quote.symbol}`;
  el('pair-badges').innerHTML = `
    <span class="type-tag is-${pair.base.type}">${pair.base.symbol} · ${pair.base.type}</span>
    <span class="type-tag is-${pair.quote.type}">${pair.quote.symbol} · ${pair.quote.type}</span>
    ${pair.stale ? '<span class="stale-tag">котировка устарела</span>' : ''}`;

  // В потоковом режиме курс в заголовке идёт из сокета и обновляется каждую
  // секунду. Обновление списка пар раз в минуту не должно его затирать
  // значением из базы — оно заметно отстаёт.
  if (state.period !== 'rt') el('pair-rate').textContent = formatRate(pair.rate);
  el('pair-meta').textContent = pair.updated_at
    ? `1 ${pair.base.symbol} = ${formatRate(pair.rate)} ${pair.quote.symbol} · обновлено ${formatWhen(pair.updated_at)}`
    : 'Котировок по этой паре пока нет';
}

function setHeadChange(value) {
  const box = el('pair-change');
  const text = formatPercent(value);
  if (!text) {
    box.textContent = '';
    box.className = 'delta';
    return;
  }
  box.textContent = `${text} ${PERIOD_LABEL[state.period] || ''}`;
  box.className = `delta ${value >= 0 ? 'is-up' : 'is-down'}`;
}

// ——— периоды и режимы ————————————————————————————————————————

function applyPeriodRules(pair) {
  const bothFiat = pair.base.type === 'fiat' && pair.quote.type === 'fiat';
  const short = ['1h', '4h', 'rt'];

  document.querySelectorAll('#period-switch .seg-btn').forEach((btn) => {
    const locked = bothFiat && short.includes(btn.dataset.period);
    btn.disabled = locked;
    if (locked) btn.title = 'Недоступно: фиатные курсы обновляются раз в сутки';
    else btn.removeAttribute('title');
  });

  if (bothFiat && short.includes(state.period)) {
    setPeriod('1d');
    return true;
  }
  return false;
}

function markPeriod(period) {
  document.querySelectorAll('#period-switch .seg-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.period === period);
  });
}

function setPeriod(period) {
  state.period = period;
  markPeriod(period);
  loadChart();
}

document.querySelectorAll('#period-switch .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!btn.disabled) setPeriod(btn.dataset.period);
  });
});

document.querySelectorAll('#mode-switch .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode;
    document.querySelectorAll('#mode-switch .seg-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    updateAlertTargets();
    if (state.period === 'rt') setPeriod('1h');
    else loadChart();
  });
});

el('reset-zoom').addEventListener('click', () => {
  if (plot) plot.resetView();
});

// ——— график ————————————————————————————————————————————————————

function showChartEmpty(text) {
  el('chart-empty').textContent = text;
  el('chart-empty').classList.remove('is-hidden');
  if (plot) plot.setSeries([]);
  state.series = [];
  el('chart-legend').innerHTML = '';
  el('reset-zoom').classList.add('is-hidden');
}

function hideChartEmpty() {
  el('chart-empty').classList.add('is-hidden');
}

function setChartMeta(text) {
  el('chart-meta').textContent = text;
}

// Сборщик пишет свечи постоянно, а график перечитывает их раз в минуту.
// Между обновлениями видно, насколько свежо показанное: если последняя
// свеча старше двух с половиной своих шагов, данные помечаются устаревшими.
function setFreshness(series) {
  const now = Date.now();
  const stale = series.some((s) => {
    const last = s.points[s.points.length - 1];
    return now - last.t > (s.resolution || 1) * 60e3 * 2.5;
  });

  if (stale) {
    const oldest = Math.min(...series.map((s) => s.points[s.points.length - 1].t));
    setStreamState(`Данные устарели · последняя свеча ${formatWhen(new Date(oldest).toISOString())}`, 'is-warn');
    return;
  }
  setStreamState(`Обновлено ${formatTime(new Date(now).toISOString())}`, '');
}

function setStreamState(text, kind) {
  const box = el('stream-state');
  if (!text) {
    box.classList.add('is-hidden');
    return;
  }
  box.textContent = text;
  box.className = `stream-state ${kind || ''}`.trim();
}

// quiet — обновление по таймеру: оно не должно ни гасить график на время
// запроса, ни сбрасывать масштаб, выбранный пользователем.
async function loadChart({ quiet = false } = {}) {
  if (!state.selectedPair) {
    resetHead();
    return;
  }
  if (state.period === 'rt') {
    if (!quiet) startStream();
    return;
  }

  stopStream();
  if (!quiet) setStreamState('');
  const pair = state.selectedPair;

  let parsed;
  let span;
  try {
    const query = new URLSearchParams({
      base: pair.base.symbol,
      quote: pair.quote.symbol,
      period: state.period,
      mode: state.mode,
    });
    const res = await api(`/history?${query}`);
    parsed = parseHistory(res, state.mode);
    // Ось показывает весь запрошенный период, а не только то, что в нём
    // нашлось: иначе час и неделя с короткой историей выглядят одинаково.
    span = { from: Date.parse(res.from), to: Date.parse(res.to) };
  } catch (err) {
    if (quiet) {
      setStreamState('Не удалось обновить данные', 'is-warn');
      return;
    }
    renderAnalytics(null);
    showChartEmpty(err.message || 'Не удалось загрузить историю');
    setChartMeta('');
    return;
  }

  // Сравнение по идентификатору, а не по ссылке: обновление списка пар
  // раз в минуту подменяет объект, и проверка на тождество выбрасывала бы
  // отсюда каждое обновление по таймеру.
  if (!samePair(pair)) return;

  renderAnalytics(parsed.analytics);
  const series = buildSeries(parsed.series, pair);

  if (series.length === 0 && quiet) {
    setStreamState('Данные устарели · новых свечей нет', 'is-warn');
    return;
  }
  if (series.length === 0) {
    showChartEmpty(
      state.mode === 'cross'
        ? 'За выбранный период котировок нет. Попробуйте период шире.'
        : 'Ни по одной стороне пары нет свечей за этот период.',
    );
    setChartMeta('');
    setHeadChange(null);
    return;
  }

  hideChartEmpty();
  state.series = series;

  const chart = ensurePlot();
  chart.setMode(state.mode === 'compare' ? 'percent' : 'absolute');
  chart.setSeries(series, {
    range: Number.isFinite(span.from) && Number.isFinite(span.to) ? span : null,
    // Масштаб, выбранный пользователем, переживает обновление по таймеру.
    keepView: quiet && chart.isZoomed(),
    animate: !quiet,
  });
  renderLegend(series);
  if (!quiet) el('reset-zoom').classList.add('is-hidden');
  setFreshness(series);

  const steps = series.map((s) => RESOLUTION_NAME[s.resolution] || `${s.resolution} мин`);
  const note = state.mode === 'compare'
    ? 'кривые приведены к проценту от начала периода'
    : 'курс пары как отношение котировок сторон';

  // Сторона без свечей просто не рисуется, и без пояснения это выглядит как
  // пропажа: у фиатной валюты внутри суток котировок нет.
  const missing = parsed.series.filter((s) => s.points.length === 0).map((s) => s.symbol);
  const gap = missing.length
    ? ` · ${missing.join(', ')}: курс суточный, за этот период свечей нет`
    : '';

  setChartMeta(`Детализация: ${[...new Set(steps)].join(' / ')} · точек: ${series.reduce((n, s) => n + s.points.length, 0)} · ${note}${gap}`);

  if (state.mode === 'cross') {
    const points = series[0].points;
    const first = points[0].c;
    const last = points[points.length - 1].c;
    setHeadChange(first ? (last / first - 1) * 100 : null);
  } else {
    setHeadChange(parsed.analytics ? parsed.analytics.change_diff : null);
  }
}

// Ряд с суточным разрешением рисуется ступенькой: внутри суток котировки
// нет, и соединять точки наклонной линией значило бы показывать курс,
// которого не было. По той же причине его свеча остаётся одной на сутки.
function buildSeries(parsed, pair) {
  if (state.mode === 'cross') {
    const cross = parsed[0];
    if (!cross || cross.points.length === 0) return [];
    return [{
      id: 'cross',
      label: `${pair.base.symbol}/${pair.quote.symbol}`,
      color: COLORS.cross,
      points: cross.points,
      resolution: cross.resolution,
      stepMs: (cross.resolution || 1) * 60e3,
      stepped: (cross.resolution || 1) >= 1440,
      carry: (cross.resolution || 1) >= 1440,
      ohlc: false,
    }];
  }

  return parsed
    .map((side, i) => ({
      id: i === 0 ? 'base' : 'quote',
      label: `${side.symbol} в USDT`,
      color: i === 0 ? COLORS.base : COLORS.quote,
      points: side.points,
      resolution: side.resolution,
      stepMs: (side.resolution || 1) * 60e3,
      stepped: (side.resolution || 1) >= 1440,
      carry: (side.resolution || 1) >= 1440,
      ohlc: true,
    }))
    .filter((s) => s.points.length > 0);
}

function renderLegend(series) {
  const box = el('chart-legend');
  box.innerHTML = '';

  for (const s of series) {
    const last = s.points[s.points.length - 1];
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'legend-chip';
    chip.dataset.id = s.id;
    chip.innerHTML = `<i style="background:${s.color}"></i>${s.label} <b>${formatRate(last.c)}</b>`;
    chip.dataset.tip = 'Щелчок — скрыть или показать кривую';
    chip.classList.add('tip');
    chip.addEventListener('click', () => {
      // Спрятать последнюю видимую кривую нельзя: остался бы пустой холст
      // без осей, и это выглядело бы как поломка.
      const shown = box.querySelectorAll('.legend-chip:not(.is-off)');
      if (shown.length === 1 && !chip.classList.contains('is-off')) return;
      const off = chip.classList.toggle('is-off');
      ensurePlot().toggleSeries(s.id, off);
    });
    box.appendChild(chip);
  }
}

function updateLegendValues(info) {
  for (const chip of el('chart-legend').querySelectorAll('.legend-chip')) {
    const s = state.series.find((x) => x.id === chip.dataset.id);
    if (!s || s.points.length === 0) continue;
    const hovered = info && info.values.find((v) => v.id === s.id);
    const point = hovered ? hovered.point : s.points[s.points.length - 1];
    chip.querySelector('b').textContent = formatRate(point.c);
  }
}

// ——— показатели ————————————————————————————————————————————————

function renderAnalytics(analytics) {
  const box = el('analytics');
  el('analytics-note').textContent = analytics ? PERIOD_LABEL[state.period] || '' : '';

  if (!analytics || !state.selectedPair) {
    box.innerHTML = '<small class="muted">Показатели появятся вместе с графиком</small>';
    return;
  }

  const base = state.selectedPair.base.symbol;
  const quote = state.selectedPair.quote.symbol;
  const cells = [
    [`Изменение ${base}`, signed(analytics.base_change)],
    [`Изменение ${quote}`, signed(analytics.quote_change)],
    ['Разность изменений', signed(analytics.change_diff)],
    [`Волатильность ${base}`, plain(analytics.base_volatility, 3)],
    [`Волатильность ${quote}`, plain(analytics.quote_volatility, 3)],
    ['Корреляция', plain(analytics.correlation, 3)],
  ];

  box.innerHTML = cells
    .map(([k, v]) => `<div class="stat"><span class="stat-k">${k}</span><span class="stat-v">${v}</span></div>`)
    .join('');
}

// Сервер присылает null, когда точек за период недостаточно для расчёта.
function signed(value) {
  const text = formatPercent(value);
  if (!text) return '<i>мало данных</i>';
  return `<span class="${value >= 0 ? 'is-up' : 'is-down'}">${text}</span>`;
}

function plain(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '<i>мало данных</i>';
  return value.toFixed(digits);
}

// ——— поток реального времени ————————————————————————————————————

let socket = null;
let streamLatest = {};
let streamSnapshots = {};
// Сохранённые минутные точки за прошедшие 15 минут и последняя известная
// цена котируемой стороны: буфер сервера наполняется, только пока пару
// кто-то смотрит, поэтому на момент подключения прошлого в нём нет.
let streamSeed = [];
let streamCarried = null;
let streamBaseOnly = false;
let streamRun = 0;

async function startStream() {
  stopStream();
  streamLatest = {};
  streamSnapshots = {};
  streamSeed = [];
  streamCarried = null;
  streamBaseOnly = false;

  const run = ++streamRun;
  const pair = state.selectedPair;
  if (!pair) return;

  renderAnalytics(null);
  el('analytics-note').textContent = 'в потоковом режиме показатели не считаются';
  setStreamState('Загрузка окна…', '');
  showChartEmpty('Загрузка последних 15 минут…');

  await loadStreamSeed(pair);
  if (run !== streamRun) return;

  if (streamSeed.length > 0) setStreamSeries(pair, []);
  openStreamSocket(pair, run);
}

// Сохранённые котировки за окно: кросс-курс даёт готовый ряд пары, а
// суточный запрос — последнюю цену котируемой стороны в USDT. Она нужна,
// чтобы перевести поток базового актива в курс пары: у фиата котировок
// внутри суток нет, и сервер считает кросс-курс тем же переносом.
async function loadStreamSeed(pair) {
  const query = (period, mode) => new URLSearchParams({
    base: pair.base.symbol,
    quote: pair.quote.symbol,
    period,
    mode,
  });

  try {
    // Недельное окно, а не суточное: свеча фиата приходится на полночь UTC
    // и под конец суток уже не попадает в последние 24 часа.
    const [crossRes, sidesRes] = await Promise.all([
      api(`/history?${query('1h', 'cross')}`),
      api(`/history?${query('1w', 'compare')}`),
    ]);

    const edge = Date.now() - RT_WINDOW_MS;
    const cross = parseHistory(crossRes, 'cross').series[0];
    streamSeed = (cross ? cross.points : []).filter((p) => p.t >= edge);

    const quoteSide = parseHistory(sidesRes, 'compare').series.find((s) => s.symbol === pair.quote.symbol);
    if (quoteSide && quoteSide.points.length > 0) {
      streamCarried = quoteSide.points[quoteSide.points.length - 1].c;
    }
  } catch (err) {
    console.warn('История для потока недоступна:', err);
  }
}

function openStreamSocket(pair, run) {
  setStreamState('Подключение к потоку…', '');

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/api/stream`
    + `?base=${pair.base.symbol}&quote=${pair.quote.symbol}&token=${state.token}`;

  try {
    socket = new WebSocket(url);
  } catch {
    streamFallback(pair);
    return;
  }

  socket.onopen = () => setStreamState('Поток активен · окно 15 минут', 'is-live');

  socket.onmessage = (event) => {
    if (run !== streamRun || !samePair(pair)) return;
    const msg = parseStreamMessage(event.data);

    if (msg.type === 'snapshot') {
      // Буфер сервера хранит последние 900 значений, а не последние
      // 15 минут: если пару уже смотрели раньше, в снимок попадают
      // котировки того сеанса. По времени их надо отрезать.
      const edge = Date.now() - RT_WINDOW_MS;
      streamSnapshots[msg.symbol] = msg.points.filter((p) => p.t >= edge);
      if (msg.points.length) streamLatest[msg.symbol] = msg.points[msg.points.length - 1].v;
      rebuildStreamSeries(pair);
      return;
    }
    if (msg.type !== 'tick') return;

    let at = 0;
    for (const tick of msg.ticks) {
      streamLatest[tick.symbol] = tick.v;
      if (tick.t > at) at = tick.t;
    }

    // Котировки котируемой стороны могут пойти позже базовых: тогда ряд
    // надо пересобрать, иначе он так и останется ценой базы в USDT.
    if (streamBaseOnly && streamLatest[pair.quote.symbol] !== undefined) {
      rebuildStreamSeries(pair);
      return;
    }

    const value = crossRate(streamLatest, pair.base.symbol, pair.quote.symbol, streamCarried);
    if (value === null) return;

    const point = { t: at || Date.now(), c: value };
    if (state.series.length === 0 || state.series[0].id !== 'rt') {
      setStreamSeries(pair, [point]);
      return;
    }

    ensurePlot().appendPoint('rt', point, RT_WINDOW_MS);
    el('pair-rate').textContent = formatRate(value);
    updateLegendValues(null);
  };

  socket.onerror = () => streamFallback(pair);
  socket.onclose = (e) => {
    if (!e.wasClean && run === streamRun && state.period === 'rt') streamFallback(pair);
  };
}

function stopStream() {
  streamRun += 1;
  if (socket) {
    const old = socket;
    socket.onclose = null;
    socket = null;
    old.close();
  }
  setStreamState('');
}

// Снимок приходит отдельным сообщением на каждую сторону. Курс пары — это
// отношение цен, причём котируемая сторона берётся последней известной на
// момент точки: так же, как её переносит сервер при расчёте кросс-курса.
function rebuildStreamSeries(pair) {
  const basePoints = streamSnapshots[pair.base.symbol] || [];
  if (basePoints.length === 0) return;

  const quotePoints = streamSnapshots[pair.quote.symbol] || [];
  streamBaseOnly = quotePoints.length === 0 && streamCarried === null;

  let index = 0;
  let carried = streamCarried;
  const live = [];

  for (const point of basePoints) {
    while (index < quotePoints.length && quotePoints[index].t <= point.t) {
      carried = quotePoints[index].v;
      index += 1;
    }
    if (streamBaseOnly) live.push({ t: point.t, c: point.v });
    else if (carried) live.push({ t: point.t, c: point.v / carried });
  }

  setStreamSeries(pair, live);
}

// Пропуск в потоке, который имеет смысл закрывать сохранённой свечой.
const STREAM_GAP_MS = 30e3;

// Ряд склеивается из сохранённых минутных свечей и котировок потока.
//
// Подписку на биржу сборщик держит, только пока пару кто-то смотрит, и за
// время без зрителей в буфере сервера остаётся разрыв: буфер хранит
// последние 900 значений, а не последние 15 минут, поэтому они могут быть
// растянуты на час с лишним. Минутные свечи при этом пишутся непрерывно,
// ими разрывы и закрываются — иначе несколько минут без котировок
// рисуются одной прямой чертой.
function streamPoints(live) {
  if (streamBaseOnly) return live;

  const edge = Date.now() - RT_WINDOW_MS;
  const stream = live.filter((p) => p.t >= edge);
  const stored = streamSeed.filter((p) => p.t >= edge);
  if (stream.length === 0) return stored;

  const filler = [];
  let i = 0;
  for (const point of stored) {
    while (i + 1 < stream.length && stream[i + 1].t <= point.t) i += 1;
    const before = stream[i].t <= point.t ? stream[i] : null;
    const after = stream[i].t > point.t ? stream[i] : stream[i + 1];
    const distance = Math.min(
      before ? point.t - before.t : Infinity,
      after ? after.t - point.t : Infinity,
    );
    if (distance > STREAM_GAP_MS) filler.push(point);
  }

  return filler.length === 0 ? stream : filler.concat(stream).sort((a, b) => a.t - b.t);
}

function setStreamSeries(pair, live) {
  const points = streamPoints(live);
  if (points.length === 0) return;

  const label = streamBaseOnly ? `${pair.base.symbol} в USDT` : `${pair.base.symbol}/${pair.quote.symbol}`;
  const series = [{
    id: 'rt',
    label: `${label} · реальное время`,
    color: COLORS.rt,
    points,
    resolution: 1,
    stepMs: 1000,
    ohlc: false,
  }];

  state.series = series;
  hideChartEmpty();

  const chart = ensurePlot();
  chart.setMode('absolute');
  chart.setSeries(series);
  renderLegend(series);
  setChartMeta(streamMeta(pair, live.length));

  const last = points[points.length - 1];
  el('pair-rate').textContent = formatRate(last.c);
  setHeadChange(points[0].c ? (last.c / points[0].c - 1) * 100 : null);
}

function streamMeta(pair, liveCount) {
  if (streamBaseOnly) {
    return `Котировок ${pair.quote.symbol} нет ни в потоке, ни в истории: показана цена ${pair.base.symbol} в USDT · окно 15 минут`;
  }

  const parts = ['Окно 15 минут'];
  parts.push(liveCount > 0
    ? 'поток по секундам, перерывы закрыты сохранёнными свечами'
    : 'сохранённые свечи · ожидание первых котировок потока');
  if (streamLatest[pair.quote.symbol] === undefined && streamCarried !== null) {
    parts.push(`курс ${pair.quote.symbol} взят последним известным — он обновляется раз в сутки`);
  }
  return parts.join(' · ');
}

function streamFallback(pair) {
  if (!samePair(pair)) return;
  setStreamState('Поток недоступен — показан последний сохранённый курс', 'is-warn');

  // Требование ТЗ: если поток недоступен, показывается последнее значение
  // с пометкой о задержке.
  if (streamSeed.length > 0) {
    setStreamSeries(pair, []);
    setChartMeta(`Сохранённые свечи за 15 минут · поток недоступен`);
    return;
  }
  if (pair.rate) {
    const at = new Date(pair.updated_at || Date.now()).getTime();
    streamSeed = [{ t: at - 1000, c: parseFloat(pair.rate) }, { t: at, c: parseFloat(pair.rate) }];
    setStreamSeries(pair, []);
    setChartMeta(`Последний сохранённый курс на ${formatWhen(pair.updated_at)} · поток недоступен`);
    return;
  }
  showChartEmpty('Поток недоступен, а сохранённых котировок по паре нет');
}

// ——— добавление пары ————————————————————————————————————————————

const modal = el('add-pair-modal');

function fillAssetSelects() {
  const crypto = state.assets.filter((a) => a.type === 'crypto');
  const fiat = state.assets.filter((a) => a.type === 'fiat');

  const options = (selected) => {
    const group = (label, list) => `<optgroup label="${label}">${list
      .map((a) => `<option value="${a.symbol}" ${a.symbol === selected ? 'selected' : ''}>${a.symbol}</option>`)
      .join('')}</optgroup>`;
    return group('Криптовалюты', crypto) + group('Фиатные валюты', fiat);
  };

  el('base-asset').innerHTML = options('BTC');
  el('quote-asset').innerHTML = options('USDT');
}

el('add-pair-btn').addEventListener('click', () => {
  el('add-pair-error').classList.add('is-hidden');
  updatePairPreview();
  modal.showModal();
});
el('modal-close').addEventListener('click', () => modal.close());
el('modal-cancel').addEventListener('click', () => modal.close());

// Щелчок мимо окна закрывает его: сам <dialog> этого не делает, а фон
// выглядит кликабельным.
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.close();
});

el('swap-assets').addEventListener('click', () => {
  const base = el('base-asset').value;
  setSelect(el('base-asset'), el('quote-asset').value);
  setSelect(el('quote-asset'), base);
});

function setSelect(select, value) {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function updatePairPreview() {
  const base = el('base-asset').value;
  const quote = el('quote-asset').value;
  const text = el('pair-preview-text');
  const same = base === quote;

  text.textContent = same ? 'Стороны пары должны различаться' : `1 ${base} в ${quote}`;
  text.parentElement.classList.toggle('is-bad', same);
}

el('base-asset').addEventListener('change', updatePairPreview);
el('quote-asset').addEventListener('change', updatePairPreview);

el('add-pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = el('add-pair-error');
  error.classList.add('is-hidden');

  const base = el('base-asset').value;
  const quote = el('quote-asset').value;
  if (base === quote) {
    error.textContent = 'Стороны пары должны различаться';
    error.classList.remove('is-hidden');
    return;
  }

  try {
    await api('/watchlist', { method: 'POST', body: JSON.stringify({ base, quote }) });
    modal.close();
    await loadWatchlist();
    const added = state.watchlist.find((p) => p.base.symbol === base && p.quote.symbol === quote);
    toaster.show({ kind: 'success', title: 'Пара добавлена', text: `${base}/${quote} в списке отслеживания`, timeout: 4000 });
    if (added) selectPair(added);
  } catch (err) {
    error.textContent = err.status === 409 ? 'Эта пара уже в списке' : err.message || 'Не удалось добавить пару';
    error.classList.remove('is-hidden');
  }
});

// ——— правила оповещений ————————————————————————————————————————

async function loadAlerts() {
  try {
    state.alerts = (await api('/alerts')) || [];
    renderAlerts();
  } catch (err) {
    console.warn('Правила недоступны:', err);
  }
}

// Цель правила — это ряд: либо курс отдельного актива в USDT, либо кросс-курс
// пары. В значении option хранится и тип цели, и её опознаватель.
function updateAlertTargets() {
  const select = el('alert-target');
  const pair = state.selectedPair;
  if (!pair) {
    select.innerHTML = '<option value="">Сначала выберите пару</option>';
    return;
  }

  const base = pair.base.symbol;
  const quote = pair.quote.symbol;
  select.innerHTML = '';

  if (state.mode === 'compare') {
    select.appendChild(new Option(`Курс ${base} в USDT`, `asset:${base}`));
    select.appendChild(new Option(`Курс ${quote} в USDT`, `asset:${quote}`));
  } else {
    select.appendChild(new Option(`Кросс-курс ${base}/${quote}`, `pair:${pair.id}`));
  }
  updateAlertInputs();
  updateAlertHint();
}

// Пороговое правило срабатывает при ПЕРЕСЕЧЕНИИ порога между двумя соседними
// свечами. Если курс уже по нужную сторону, пересекать нечего, и правило будет
// молчать — без подсказки это выглядит как поломка.
function updateAlertHint() {
  const hint = el('alert-hint');
  const pair = state.selectedPair;
  if (!pair) {
    hint.textContent = 'Правила создаются для выбранной пары.';
    hint.className = 'hint';
    return;
  }

  const kind = el('alert-kind').value;
  const value = parseFloat((el('alert-value').value || '').replace(',', '.'));
  const rate = parseFloat(pair.rate);

  if ((kind !== 'above' && kind !== 'below') || !Number.isFinite(value) || !Number.isFinite(rate)) {
    hint.textContent = 'Правила сверяются с сохранёнными свечами; котировки потока в базу не пишутся.';
    hint.className = 'hint';
    return;
  }

  if (kind === 'above' ? rate >= value : rate <= value) {
    hint.textContent = `Курс уже ${kind === 'above' ? 'выше' : 'ниже'} порога (${formatRate(pair.rate)}). `
      + 'Правило ждёт пересечения и сейчас не сработает.';
    hint.className = 'hint is-warn';
  } else {
    hint.textContent = `Текущий курс ${formatRate(pair.rate)} — порог ещё не пересечён.`;
    hint.className = 'hint';
  }
}

// Интервал нужен только процентным правилам, а единица и шаг значения
// зависят от условия: порог измеряется в котируемой валюте, рост — в
// процентах, и шагать по ним надо совсем по-разному.
function updateAlertInputs() {
  const percent = ['growth', 'drop'].includes(el('alert-kind').value);
  el('alert-window-field').classList.toggle('is-hidden', !percent);

  if (percent) {
    alertValue.setUnit('%');
    alertValue.setStep(0.1);
    alertValue.setPlaceholder('например, 3');
    return;
  }

  const pair = state.selectedPair;
  const rate = pair ? parseFloat(pair.rate) : NaN;
  const target = el('alert-target').value;
  const asset = target.startsWith('asset:') ? target.slice(6) : null;

  alertValue.setUnit(asset ? 'USDT' : pair ? pair.quote.symbol : '');
  if (Number.isFinite(rate) && rate > 0) {
    alertValue.setStep(Math.pow(10, Math.floor(Math.log10(rate)) - 3));
    alertValue.setPlaceholder(asset ? 'курс в USDT' : formatRate(rate));
  } else {
    alertValue.setStep(1);
    alertValue.setPlaceholder('порог');
  }
}

el('alert-kind').addEventListener('change', () => {
  updateAlertInputs();
  updateAlertHint();
});
el('alert-target').addEventListener('change', () => {
  updateAlertInputs();
  updateAlertHint();
});
el('alert-value').addEventListener('input', updateAlertHint);

el('alert-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = el('alert-error');
  error.classList.add('is-hidden');

  const target = el('alert-target').value;
  if (!target) {
    error.textContent = 'Сначала выберите пару';
    error.classList.remove('is-hidden');
    return;
  }

  const [targetType, id] = target.split(':');
  const payload = buildAlertPayload({
    kind: el('alert-kind').value,
    value: (el('alert-value').value || '').trim().replace(',', '.'),
    windowMinutes: el('alert-window').value,
    targetType,
    symbol: targetType === 'asset' ? id : undefined,
    pairId: targetType === 'pair' ? Number(id) : undefined,
  });

  try {
    await api('/alerts', { method: 'POST', body: JSON.stringify(payload) });
    el('alert-value').value = '';
    await loadAlerts();
    updateAlertHint();
    toaster.show({ kind: 'success', title: 'Правило добавлено', text: 'Оповещение придёт при выполнении условия', timeout: 4000 });
  } catch (err) {
    // Правило, которого нет на сервере, показывать нельзя: оно не сработает,
    // а в списке будет выглядеть действующим.
    error.textContent = err.message || 'Правило не создано';
    error.classList.remove('is-hidden');
  }
});

function renderAlerts() {
  const box = el('alerts-list');
  el('alerts-count').textContent = state.alerts.length;
  box.innerHTML = '';

  if (state.alerts.length === 0) {
    box.innerHTML = '<small class="muted">Правил пока нет</small>';
    return;
  }

  for (const rule of state.alerts) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="row-main">
        <b>${rule.pair || rule.symbol || '—'}</b> ${describeAlert(rule)}
        ${rule.status === 'triggered' ? '<span class="fired-tag">сработало</span>' : ''}
        <div class="row-sub">создано ${new Date(rule.created_at).toLocaleString('ru-RU')}</div>
      </div>
      <div class="row-actions">
        <button class="btn btn-ghost btn-xs" data-act="edit" type="button">Изменить</button>
        <button class="btn btn-danger btn-xs" data-act="del" type="button">Удалить</button>
      </div>`;

    row.querySelector('[data-act="edit"]').addEventListener('click', () => editAlert(rule, row));
    row.querySelector('[data-act="del"]').addEventListener('click', () => deleteAlert(rule));
    box.appendChild(row);
  }
}

// US-3: список правил служит для просмотра, изменения и удаления. Изменение
// заодно снимает отметку «сработало», и правило начинает действовать снова.
function editAlert(rule, row) {
  row.innerHTML = `
    <div class="row-main row-edit">
      <b>${rule.pair || rule.symbol || '—'}</b>
      <span>${rule.condition_type === 'percent' ? 'на' : 'порог'}</span>
      <input type="number" step="any" class="row-input" value="${trimZeros(rule.target_value)}">
    </div>
    <div class="row-actions">
      <button class="btn btn-primary btn-xs" data-act="save" type="button">Сохранить</button>
      <button class="btn btn-ghost btn-xs" data-act="cancel" type="button">Отмена</button>
    </div>`;

  const input = row.querySelector('.row-input');
  input.focus();
  input.select();

  const save = async () => {
    try {
      await api(`/alerts/${rule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ target_value: (input.value || '').trim().replace(',', '.') }),
      });
      await loadAlerts();
    } catch (err) {
      toaster.show({ kind: 'error', title: 'Правило не изменено', text: err.message });
      renderAlerts();
    }
  };

  row.querySelector('[data-act="save"]').addEventListener('click', save);
  row.querySelector('[data-act="cancel"]').addEventListener('click', renderAlerts);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') renderAlerts();
  });
}

async function deleteAlert(rule) {
  try {
    await api(`/alerts/${rule.id}`, { method: 'DELETE' });
    await loadAlerts();
  } catch (err) {
    toaster.show({ kind: 'error', title: 'Правило не удалено', text: err.message });
  }
}

// ——— уведомления ————————————————————————————————————————————————

// Эндпоинт отдаёт только непрочитанные, поэтому их число — длина списка.
async function pollNotifications() {
  let list;
  try {
    list = (await api('/notifications')) || [];
  } catch (err) {
    console.warn('Уведомления недоступны:', err);
    return;
  }

  const badge = el('unread-badge');
  badge.textContent = list.length;
  badge.classList.toggle('is-hidden', list.length === 0);
  renderNotifications(list);

  // Первый опрос только наполняет список: иначе при каждом входе на экран
  // вываливались бы все накопленные уведомления сразу. Вместо вороха
  // карточек показывается одна — сколько накопилось, пока не смотрели.
  if (!state.notificationsReady && list.length > 0) {
    toaster.show({
      kind: 'info',
      title: `Непрочитанных уведомлений: ${list.length}`,
      text: 'Правила сработали, пока страница была закрыта',
      onClick: () => el('notifications-panel').scrollIntoView({ behavior: 'smooth', block: 'center' }),
    });
  }

  for (const n of list) {
    if (!state.seen.has(n.id)) {
      state.seen.add(n.id);
      if (state.notificationsReady) popNotification(n);
    }
  }
  state.notificationsReady = true;
}

function describeNotification(n) {
  // В ответе нет типа условия, поэтому расшифровка берётся из правила:
  // иначе процентное правило читалось бы как цена — «выше 3».
  const rule = state.alerts.find((r) => r.id === n.alert_rule_id);
  return rule ? describeAlert(rule) : `${n.direction === 'above' ? 'выше' : 'ниже'} ${formatRate(n.target_value)}`;
}

function popNotification(n) {
  const pair = state.watchlist.find((p) => `${p.base.symbol}/${p.quote.symbol}` === n.target);
  toaster.show({
    kind: n.direction === 'above' ? 'up' : 'down',
    title: `${n.target} — ${describeNotification(n)}`,
    text: 'Правило оповещения сработало',
    meta: new Date(n.triggered_at).toLocaleString('ru-RU'),
    onClick: pair ? () => selectPair(pair) : undefined,
  });
}

function renderNotifications(list) {
  const box = el('notifications-list');

  if (list.length === 0) {
    box.innerHTML = '<small class="muted">Непрочитанных уведомлений нет</small>';
    return;
  }

  box.innerHTML = list
    .map((n) => `
      <div class="row ${state.seen.has(n.id) ? '' : 'is-new'}">
        <div class="row-main">
          <b>${n.target}</b> ${describeNotification(n)}
          <div class="row-sub">${new Date(n.triggered_at).toLocaleString('ru-RU')}</div>
        </div>
        <span class="type-tag is-${n.direction === 'above' ? 'up' : 'down'}">${n.direction === 'above' ? 'рост' : 'падение'}</span>
      </div>`)
    .join('');
}

el('mark-seen-btn').addEventListener('click', async () => {
  // Уведомления остаются в истории, гасится только отметка непрочитанного.
  try {
    await api('/notifications/seen', { method: 'POST', body: JSON.stringify({}) });
    await pollNotifications();
  } catch (err) {
    toaster.show({ kind: 'error', title: 'Не удалось отметить прочитанными', text: err.message });
  }
});

el('bell-btn').addEventListener('click', () => {
  el('notifications-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ——— старт ——————————————————————————————————————————————————————

setAuthMode('login');
updateAlertTargets();
updateAlertInputs();

if (state.token && state.expiresAt && new Date(state.expiresAt) > new Date()) {
  enterApp();
} else {
  el('auth-view').classList.remove('is-hidden');
}
