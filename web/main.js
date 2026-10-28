import Chart from 'chart.js/auto';
import {
  trimZeros,
  parseHistory,
  parseStreamMessage,
  crossRate,
  buildAlertPayload,
  describeAlert,
  errorText,
} from './parse.js';

const state = {
  token: localStorage.getItem('token'),
  expiresAt: localStorage.getItem('expires_at'),
  isRegisterMode: false,
  assets: [],
  watchlist: [],
  selectedPair: null,
  refreshTimer: null,
  currentPeriod: '1h',
  currentMode: 'cross'
};

async function api(path, options = {}) {
  if (state.token && state.expiresAt && new Date(state.expiresAt) <= new Date()) {
    logout('Срок сессии истёк. Войдите снова.');
    throw new Error('Session expired');
  }

  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  const res = await fetch(`/api${path}`, { ...options, headers });

  if (res.status === 401 && !path.startsWith('/auth/')) {
    logout('Сессия недействительна. Пожалуйста, выполните вход.');
    throw new Error('Unauthorized');
  }

  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(errorText(data));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function setSession(token, expiresAt) {
  state.token = token;
  state.expiresAt = expiresAt;
  localStorage.setItem('token', token);
  localStorage.setItem('expires_at', expiresAt);
}

function logout(message = '') {
  stopRealtimeStream();
  state.token = null;
  state.expiresAt = null;
  state.selectedPair = null;
  localStorage.removeItem('token');
  localStorage.removeItem('expires_at');
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  showAuthView();
  if (message) showAuthError(message);
}

function showAuthView() {
  document.getElementById('auth-view').classList.remove('hidden');
  document.getElementById('app-view').classList.add('hidden');
}

function showAppView() {
  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  initAppData();
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideAuthError() {
  document.getElementById('auth-error').classList.add('hidden');
}

const authForm = document.getElementById('auth-form');
const authTitle = document.getElementById('auth-title');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const toggleBtn = document.getElementById('toggle-btn');
const toggleText = document.getElementById('toggle-text');

toggleBtn.addEventListener('click', () => {
  state.isRegisterMode = !state.isRegisterMode;
  hideAuthError();
  if (state.isRegisterMode) {
    authTitle.textContent = 'Регистрация';
    authSubmitBtn.textContent = 'Зарегистрироваться';
    toggleText.textContent = 'Уже есть аккаунт?';
    toggleBtn.textContent = 'Войти';
  } else {
    authTitle.textContent = 'Вход в систему';
    authSubmitBtn.textContent = 'Войти';
    toggleText.textContent = 'Нет аккаунта?';
    toggleBtn.textContent = 'Зарегистрироваться';
  }
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;

  if (password.length < 8) {
    showAuthError('Пароль должен быть не короче 8 символов');
    return;
  }

  const endpoint = state.isRegisterMode ? '/auth/register' : '/auth/login';

  try {
    const res = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    setSession(res.token, res.expires_at);
    showAppView();
  } catch (err) {
    if (err.status === 409) {
      showAuthError('Пользователь с таким email уже существует');
    } else if (err.status === 401) {
      showAuthError('Неверный адрес или пароль');
    } else if (err.status === 400) {
      showAuthError(err.message || 'Пароль короче 8 символов или неверный формат');
    } else {
      showAuthError(err.message || 'Ошибка соединения с сервером');
    }
  }
});

document.getElementById('logout-btn').addEventListener('click', () => logout());

const markSeenBtn = document.getElementById('mark-seen-btn');
if (markSeenBtn) {
  markSeenBtn.addEventListener('click', async () => {
    // Уведомления остаются в истории, гасится только отметка непрочитанного.
    try {
      await api('/notifications/seen', { method: 'POST', body: JSON.stringify({}) });
      await loadNotifications();
    } catch (err) {
      console.warn('Не удалось отметить прочитанными:', err);
    }
  });
}

async function initAppData() {
  await loadAssets();
  await loadWatchlist();
  
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(loadWatchlist, 60000);

  await loadAlerts();
  loadNotifications();
  setInterval(loadNotifications, 15000);
}

async function loadAssets() {
  try {
    state.assets = await api('/assets');
    populateAssetSelects();
  } catch (err) {
    console.error('Ошибка загрузки активов:', err);
  }
}

async function loadWatchlist() {
  try {
    state.watchlist = await api('/watchlist');
    renderWatchlist();
  } catch (err) {
    console.error('Ошибка обновления списка пар:', err);
  }
}

function formatRate(rateStr) {
  if (!rateStr) return 'нет данных';
  const num = parseFloat(rateStr);
  return isNaN(num) ? 'нет данных' : num.toLocaleString('ru-RU', { maximumFractionDigits: 6 });
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderWatchlist() {
  const container = document.getElementById('watchlist-container');
  container.innerHTML = '';

  if (!state.watchlist || state.watchlist.length === 0) {
    container.innerHTML = `
      <div class="empty-watchlist">
        У вас пока нет отслеживаемых пар.<br>
        Нажмите <b>«+ Добавить пару»</b> ниже.
      </div>
    `;
    return;
  }

  state.watchlist.forEach((pair) => {
    const card = document.createElement('div');
    const isSelected = state.selectedPair && state.selectedPair.id === pair.id;
    card.className = `pair-item ${isSelected ? 'active' : ''}`;

    const formattedRate = formatRate(pair.rate);
    const staleBadge = pair.stale ? `<span class="stale-tag" title="Котировка устарела">Устарело</span>` : '';
    const updatedTime = formatDate(pair.updated_at);

    card.innerHTML = `
      <div class="pair-item-row">
        <span class="pair-symbols">${pair.base.symbol} / ${pair.quote.symbol}</span>
        <button class="delete-btn" data-id="${pair.id}" title="Удалить пару">&times;</button>
      </div>
      <div class="pair-item-row">
        <span class="pair-rate">${formattedRate}</span>
        ${staleBadge}
      </div>
      <div class="pair-meta">
        <span>${pair.base.type} / ${pair.quote.type}</span>
        <span>Обновлено: ${updatedTime || '—'}</span>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('delete-btn')) return;
      selectPair(pair);
    });

    card.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deletePair(pair.id);
    });

    container.appendChild(card);
  });
}

const addModal = document.getElementById('add-pair-modal');
const baseSelect = document.getElementById('base-asset-select');
const quoteSelect = document.getElementById('quote-asset-select');
const addError = document.getElementById('add-pair-error');

function populateAssetSelects() {
  baseSelect.innerHTML = '';
  quoteSelect.innerHTML = '';

  state.assets.forEach((a) => {
    const opt1 = new Option(`${a.symbol} (${a.type})`, a.symbol);
    const opt2 = new Option(`${a.symbol} (${a.type})`, a.symbol);
    baseSelect.appendChild(opt1);
    quoteSelect.appendChild(opt2);
  });

  if (quoteSelect.options.length > 1) {
    quoteSelect.selectedIndex = 1;
  }
}

document.getElementById('open-add-dialog-btn').addEventListener('click', () => {
  addError.classList.add('hidden');
  addModal.showModal();
});

document.getElementById('close-add-modal-btn').addEventListener('click', () => addModal.close());
document.getElementById('cancel-add-btn').addEventListener('click', () => addModal.close());

document.getElementById('add-pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  addError.classList.add('hidden');

  const base = baseSelect.value;
  const quote = quoteSelect.value;

  if (base === quote) {
    addError.textContent = 'Стороны пары должны отличаться';
    addError.classList.remove('hidden');
    return;
  }

  try {
    await api('/watchlist', {
      method: 'POST',
      body: JSON.stringify({ base, quote })
    });
    addModal.close();
    await loadWatchlist();
  } catch (err) {
    addError.classList.remove('hidden');
    if (err.status === 409) {
      addError.textContent = 'Эта пара уже добавлена в ваш список';
    } else {
      addError.textContent = err.message || 'Не удалось добавить пару';
    }
  }
});

async function deletePair(id) {
  try {
    await api(`/watchlist/${id}`, { method: 'DELETE' });
    if (state.selectedPair && state.selectedPair.id === id) {
      state.selectedPair = null;
      document.getElementById('selected-pair-title').textContent = 'Выберите пару слева';
      document.getElementById('selected-pair-meta').textContent = '';
      stopRealtimeStream();
      renderChart();
    }
    await loadWatchlist();
  } catch (err) {
    alert(err.message || 'Ошибка при удалении пары');
  }
}

function selectPair(pair) {
  state.selectedPair = pair;
  renderWatchlist();

  document.getElementById('selected-pair-title').textContent = `${pair.base.symbol} / ${pair.quote.symbol}`;
  document.getElementById('selected-pair-meta').textContent = 
    `Базовый: ${pair.base.symbol} (${pair.base.type}) | Котируемый: ${pair.quote.symbol} (${pair.quote.type}) | Текущий курс: ${formatRate(pair.rate)}`;

  applyPeriodRules(pair);
  updateAlertTargetOptions();

  if (state.currentPeriod === 'rt') {
    startRealtimeStream();
  } else {
    renderChart();
  }
}

function applyPeriodRules(pair) {
  const isBothFiat = pair.base.type === 'fiat' && pair.quote.type === 'fiat';

  const btn1h = document.querySelector('.btn-period[data-period="1h"]');
  const btn4h = document.querySelector('.btn-period[data-period="4h"]');
  const btnRt = document.querySelector('.realtime-tab');

  if (isBothFiat) {
    btn1h.disabled = true;
    btn4h.disabled = true;
    btnRt.disabled = true;
    const tooltip = 'Недоступно: пара из фиатных валют обновляется раз в сутки';
    btn1h.title = tooltip;
    btn4h.title = tooltip;
    btnRt.title = tooltip;

    if (state.currentPeriod === '1h' || state.currentPeriod === '4h' || state.currentPeriod === 'rt') {
      setPeriod('1d');
    }
  } else {
    btn1h.disabled = false;
    btn4h.disabled = false;
    btnRt.disabled = false;
    btn1h.removeAttribute('title');
    btn4h.removeAttribute('title');
    btnRt.removeAttribute('title');
  }
}

function setPeriod(p) {
  state.currentPeriod = p;
  document.querySelectorAll('.btn-period').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-period') === p);
  });

  if (p === 'rt') {
    startRealtimeStream();
  } else {
    stopRealtimeStream();
    renderChart();
  }
}

document.querySelectorAll('.btn-period').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!btn.disabled) setPeriod(btn.getAttribute('data-period'));
  });
});

document.querySelectorAll('.btn-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.currentMode = btn.getAttribute('data-mode');
    updateAlertTargetOptions();
    if (state.currentPeriod !== 'rt') {
      renderChart();
    }
  });
});

let chartInstance = null;
// Разобранные ряды держатся рядом с графиком: подсказке нужны открытие,
// максимум и минимум, а в сам Chart.js уходят только цены закрытия.
let chartPoints = [];

function showChartMessage(text) {
  const emptyState = document.getElementById('chart-empty-state');
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  emptyState.textContent = text;
  emptyState.classList.remove('hidden');
  setChartMeta('');
}

function setChartMeta(text) {
  const el = document.getElementById('chart-meta');
  if (el) el.textContent = text;
}

function formatPointTime(ms) {
  const d = new Date(ms);
  const short = state.currentPeriod === '1h' || state.currentPeriod === '4h' || state.currentPeriod === 'rt';
  return short
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function resolutionName(resolution) {
  return { 1: '1 минута', 5: '5 минут', 60: '1 час', 1440: '1 сутки' }[resolution] || resolution + ' мин';
}

// Требование US-2: при наведении выделенная кривая показывается свечой.
// Chart.js рисует линию, поэтому OHLC выводится в подсказке.
function ohlcLines(items) {
  if (!items.length) return [];

  const item = items[0];
  const serie = chartPoints[item.datasetIndex];
  const point = serie && serie.points[item.dataIndex];
  if (!point || point.o === undefined) return [];

  return [
    `открытие ${formatRate(point.o)}`,
    `максимум ${formatRate(point.h)}`,
    `минимум  ${formatRate(point.l)}`,
    `закрытие ${formatRate(point.c)}`,
  ];
}

// Требование US-4: показатели считает сервер и возвращает вместе с графиком.
function renderAnalytics(analytics) {
  const box = document.getElementById('analytics-box');
  if (!box) return;

  if (!analytics || !state.selectedPair) {
    box.innerHTML = '<small class="analytics-empty">Показатели появятся вместе с графиком</small>';
    return;
  }

  const base = state.selectedPair.base.symbol;
  const quote = state.selectedPair.quote.symbol;
  const cells = [
    [`Изменение ${base}`, percent(analytics.base_change)],
    [`Изменение ${quote}`, percent(analytics.quote_change)],
    ['Разность', percent(analytics.change_diff)],
    [`Волатильность ${base}`, fixed(analytics.base_volatility, 3)],
    [`Волатильность ${quote}`, fixed(analytics.quote_volatility, 3)],
    ['Корреляция', fixed(analytics.correlation, 3)],
  ];

  box.innerHTML = cells
    .map(([k, v]) => `<div class="analytics-cell"><span class="k">${k}</span><span class="v">${v}</span></div>`)
    .join('');
}

// Сервер присылает null, когда точек за период недостаточно для расчёта.
function percent(value) {
  if (value === null || value === undefined) return '<i class="muted">недостаточно данных</i>';
  const cls = value >= 0 ? 'up' : 'down';
  return `<span class="${cls}">${value >= 0 ? '+' : ''}${value.toFixed(2)} %</span>`;
}

function fixed(value, digits) {
  if (value === null || value === undefined) return '<i class="muted">недостаточно данных</i>';
  return value.toFixed(digits);
}

async function renderChart() {
  const canvas = document.getElementById('main-chart');
  const emptyState = document.getElementById('chart-empty-state');
  if (!canvas) return;

  if (!state.selectedPair) {
    if (chartInstance) chartInstance.destroy();
    emptyState.textContent = 'Выберите пару в боковом меню для просмотра графика';
    emptyState.classList.remove('hidden');
    return;
  }

  let parsed = { series: [], analytics: null };

  try {
    const query = new URLSearchParams({
      base: state.selectedPair.base.symbol,
      quote: state.selectedPair.quote.symbol,
      period: state.currentPeriod,
      mode: state.currentMode
    });

    const res = await api(`/history?${query.toString()}`);
    parsed = parseHistory(res, state.currentMode);
  } catch (err) {
    renderAnalytics(null);
    showChartMessage(err.message || 'Не удалось загрузить историю');
    return;
  }

  chartPoints = parsed.series;
  renderAnalytics(parsed.analytics);

  const main = parsed.series[0];
  if (!main || main.points.length === 0) {
    // Пустой период так и показывается пустым. Рисовать здесь своё нельзя:
    // выдуманную кривую примут за настоящий курс.
    showChartMessage('Нет данных за выбранный период');
    return;
  }

  const labels = main.points.map(p => formatPointTime(p.t));
  const series1 = main.points.map(p => p.c);
  const series2 = state.currentMode === 'compare' && parsed.series[1]
    ? parsed.series[1].points.map(p => p.c)
    : [];

  setChartMeta(`Детализация: ${resolutionName(main.resolution)} · точек: ${main.points.length}`);
  emptyState.classList.add('hidden');

  if (chartInstance) {
    chartInstance.destroy();
  }

  const ctx = canvas.getContext('2d');

  if (state.currentMode === 'cross') {
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: `Кросс-курс ${state.selectedPair.base.symbol}/${state.selectedPair.quote.symbol}`,
          data: series1,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.08)',
          fill: true,
          tension: 0.2,
          borderWidth: 2,
          pointRadius: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { tooltip: { callbacks: { afterBody: ohlcLines } } },
        scales: {
          x: { grid: { display: false } },
          y: { position: 'left', grid: { color: '#f1f5f9' } }
        }
      }
    });
  } else {
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: `${state.selectedPair.base.symbol} (базовый)`,
            data: series1,
            borderColor: '#2563eb',
            yAxisID: 'y_base',
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.2
          },
          {
            label: `${state.selectedPair.quote.symbol} (котируемый)`,
            data: series2,
            borderColor: '#10b981',
            yAxisID: 'y_quote',
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: { tooltip: { callbacks: { afterBody: ohlcLines } } },
        onHover: (event, activeElements) => {
          if (!chartInstance) return;
          if (activeElements && activeElements.length > 0) {
            const activeIdx = activeElements[0].datasetIndex;
            chartInstance.data.datasets.forEach((ds, idx) => {
              if (idx === activeIdx) {
                ds.borderWidth = 3;
                ds.borderColor = idx === 0 ? '#1d4ed8' : '#047857';
              } else {
                ds.borderWidth = 1;
                ds.borderColor = idx === 0 ? 'rgba(37, 99, 235, 0.25)' : 'rgba(16, 185, 129, 0.25)';
              }
            });
          } else {
            chartInstance.data.datasets[0].borderColor = '#2563eb';
            chartInstance.data.datasets[0].borderWidth = 2;
            chartInstance.data.datasets[1].borderColor = '#10b981';
            chartInstance.data.datasets[1].borderWidth = 2;
          }
          chartInstance.update('none');
        },
        scales: {
          x: { grid: { display: false } },
          y_base: {
            type: 'linear',
            position: 'left',
            title: { display: true, text: state.selectedPair.base.symbol, color: '#2563eb' }
          },
          y_quote: {
            type: 'linear',
            position: 'right',
            grid: { drawOnChartArea: false },
            title: { display: true, text: state.selectedPair.quote.symbol, color: '#10b981' }
          }
        }
      }
    });
  }
}

let realtimeSocket = null;
let realtimePoints = [];
// Поток присылает цены сторон по отдельности, а показывать надо курс пары.
let realtimeSnapshots = {};
let realtimeLatest = {};
// Подпись ставится по снимку при подключении, когда буфер котируемой
// стороны ещё может быть пуст. Если её котировки пойдут позже, подпись
// нужно поправить, иначе она так и останется неверной.
let realtimeBaseOnly = false;

function startRealtimeStream() {
  stopRealtimeStream();
  realtimeSnapshots = {};
  realtimeLatest = {};

  const banner = document.getElementById('realtime-status-banner');
  banner.textContent = 'Подключение к потоку реального времени...';
  banner.classList.remove('hidden');

  if (!state.selectedPair) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/api/stream?base=${state.selectedPair.base.symbol}&quote=${state.selectedPair.quote.symbol}&token=${state.token}`;

  try {
    realtimeSocket = new WebSocket(wsUrl);

    realtimeSocket.onopen = () => {
      banner.textContent = 'Поток реального времени активен (15м)';
      banner.style.color = '#15803d';
      banner.style.backgroundColor = '#f0fdf4';
      banner.style.borderColor = '#bbf7d0';
    };

    realtimeSocket.onmessage = (event) => {
      const msg = parseStreamMessage(event.data);
      const base = state.selectedPair.base.symbol;
      const quote = state.selectedPair.quote.symbol;

      if (msg.type === 'snapshot') {
        realtimeSnapshots[msg.symbol] = msg.points;
        if (msg.points.length) realtimeLatest[msg.symbol] = msg.points[msg.points.length - 1].v;
        rebuildRealtimeChart(base, quote);
        return;
      }

      if (msg.type !== 'tick') return;

      let at = 0;
      for (const tick of msg.ticks) {
        realtimeLatest[tick.symbol] = tick.v;
        if (tick.t > at) at = tick.t;
      }

      if (realtimeBaseOnly && realtimeLatest[quote] !== undefined) {
        realtimeBaseOnly = false;
        setChartMeta('Детализация: 1 секунда · окно 15 минут');
      }

      const value = crossRate(realtimeLatest, base, quote);
      if (value !== null) appendRealtimePoint({ t: at || Date.now(), v: value });
    };

    realtimeSocket.onerror = () => {
      // Требование ТЗ: если поток недоступен, показывается последнее значение с пометкой о задержке
      banner.textContent = `Поток недоступен. Последний курс: ${formatRate(state.selectedPair?.rate)} (задержка)`;
      banner.style.color = '#92400e';
      banner.style.backgroundColor = '#fffbeb';
      banner.style.borderColor = '#fde68a';

      // Требование US-2: последнее сохранённое значение всё равно показывается.
      if (state.selectedPair && state.selectedPair.rate) {
        initRealtimeChart(
          [{ t: new Date(state.selectedPair.updated_at || Date.now()).getTime(),
             v: parseFloat(state.selectedPair.rate) }],
          false);
      }
    };

    realtimeSocket.onclose = () => {
      console.log('WS соединение закрыто');
    };
  } catch (err) {
    banner.textContent = `Поток недоступен. Курс: ${formatRate(state.selectedPair?.rate)} (задержка)`;
  }
}

function stopRealtimeStream() {
  if (realtimeSocket) {
    realtimeSocket.close();
    realtimeSocket = null;
  }
  const banner = document.getElementById('realtime-status-banner');
  if (banner) banner.classList.add('hidden');
}

// Снимок приходит отдельным сообщением на каждую сторону. Курс пары — это
// их отношение, поэтому ряд собирается после получения обоих снимков.
function rebuildRealtimeChart(base, quote) {
  const basePoints = realtimeSnapshots[base] || [];
  const quotePoints = realtimeSnapshots[quote];
  const hasQuote = Array.isArray(quotePoints) && quotePoints.length > 0;

  realtimePoints = basePoints.map((point, i) => {
    if (!hasQuote) return { t: point.t, v: point.v };
    const q = (quotePoints[i] || quotePoints[quotePoints.length - 1]).v;
    return { t: point.t, v: q ? point.v / q : point.v };
  });

  initRealtimeChart(realtimePoints, !hasQuote);
}

function appendRealtimePoint(point) {
  if (!chartInstance) return;

  chartInstance.data.labels.push(formatRealtimeTime(point.t));
  chartInstance.data.datasets[0].data.push(point.v);

  // Окно реального времени — 15 минут при котировке раз в секунду.
  while (chartInstance.data.labels.length > 900) {
    chartInstance.data.labels.shift();
    chartInstance.data.datasets[0].data.shift();
  }

  chartInstance.update('none');
}

function formatRealtimeTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function initRealtimeChart(points, baseOnly) {
  const canvas = document.getElementById('main-chart');
  if (!canvas) return;
  if (chartInstance) chartInstance.destroy();

  const emptyState = document.getElementById('chart-empty-state');
  if (emptyState) emptyState.classList.add('hidden');

  const base = state.selectedPair.base.symbol;
  const quote = state.selectedPair.quote.symbol;
  realtimeBaseOnly = !!baseOnly;
  setChartMeta(baseOnly
    ? `Котировки ${quote} в потоке не передаются: показана цена ${base} в USDT`
    : 'Детализация: 1 секунда · окно 15 минут');

  const ctx = canvas.getContext('2d');
  const labels = points.map(p => formatRealtimeTime(p.t));
  const data = points.map(p => p.v);

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: baseOnly ? `Реальное время: ${base} в USDT` : `Реальное время: ${base}/${quote}`,
        data: data,
        borderColor: '#ef4444',
        backgroundColor: 'rgba(239, 68, 68, 0.05)',
        borderWidth: 1.5,
        fill: true,
        pointRadius: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { grid: { display: false } },
        y: { position: 'left' }
      }
    }
  });
}

let userAlerts = [];

async function loadAlerts() {
  try {
    userAlerts = await api('/alerts') || [];
    renderAlertsList();
  } catch (err) {
    console.warn('Серверные алерты пока не настроены:', err);
  }
}

// Эндпоинт отдаёт только непрочитанные, поэтому их число — длина списка.
async function loadNotifications() {
  try {
    const list = (await api('/notifications')) || [];
    document.getElementById('unread-alerts-badge').textContent = list.length;
    renderNotifications(list);
  } catch (err) {
    console.warn('Уведомления недоступны:', err);
  }
}

function renderNotifications(list) {
  const box = document.getElementById('notifications-list');
  if (!box) return;

  if (list.length === 0) {
    box.innerHTML = '<small class="muted">Непрочитанных уведомлений нет</small>';
    return;
  }

  box.innerHTML = list.map((n) => {
    // В ответе нет типа условия, поэтому расшифровка берётся из правила:
    // иначе процентное правило читалось бы как цена — «выше 3».
    const rule = userAlerts.find(r => r.id === n.alert_rule_id);
    const text = rule
      ? describeAlert(rule)
      : `${n.direction === 'above' ? 'выше' : 'ниже'} ${formatRate(n.target_value)}`;
    return `<div class="notification-row"><b>${n.target}</b> ${text}
      <span class="muted">${new Date(n.triggered_at).toLocaleString('ru-RU')}</span></div>`;
  }).join('');
}

// Цель правила — это ряд: либо курс отдельного актива в USDT, либо кросс-курс
// пары. В значении option хранится и тип цели, и её опознаватель.
function updateAlertTargetOptions() {
  const targetSelect = document.getElementById('alert-target-select');
  if (!targetSelect || !state.selectedPair) return;

  const base = state.selectedPair.base.symbol;
  const quote = state.selectedPair.quote.symbol;

  targetSelect.innerHTML = '';
  if (state.currentMode === 'compare') {
    targetSelect.appendChild(new Option(`Курс ${base} в USDT`, `asset:${base}`));
    targetSelect.appendChild(new Option(`Курс ${quote} в USDT`, `asset:${quote}`));
  } else {
    targetSelect.appendChild(new Option(`Кросс-курс ${base}/${quote}`, `pair:${state.selectedPair.id}`));
  }
  updateAlertHint();
}

function showAlertError(message) {
  const el = document.getElementById('alert-error');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

// Пороговое правило срабатывает при ПЕРЕСЕЧЕНИИ порога между двумя соседними
// свечами. Если курс уже по нужную сторону, пересекать нечего, и правило будет
// молчать — без подсказки это выглядит как поломка.
function updateAlertHint() {
  const hint = document.getElementById('alert-hint');
  if (!hint || !state.selectedPair) return;

  const kind = document.getElementById('alert-type-select').value;
  const value = parseFloat((document.getElementById('alert-value-input').value || '').replace(',', '.'));
  const rate = parseFloat(state.selectedPair.rate);

  if ((kind !== 'above' && kind !== 'below') || !isFinite(value) || !isFinite(rate)) {
    hint.textContent = 'Правила сверяются с сохранёнными свечами; котировки потока в базу не пишутся.';
    hint.className = 'alert-hint';
    return;
  }

  const crossed = kind === 'above' ? rate >= value : rate <= value;
  if (crossed) {
    hint.textContent = `Курс уже ${kind === 'above' ? 'выше' : 'ниже'} порога (${formatRate(state.selectedPair.rate)}). ` +
      'Правило ждёт пересечения и сейчас не сработает.';
    hint.className = 'alert-hint warn';
  } else {
    hint.textContent = `Текущий курс ${formatRate(state.selectedPair.rate)} — порог ещё не пересечён.`;
    hint.className = 'alert-hint';
  }
}

const alertForm = document.getElementById('create-alert-form');
if (alertForm) {
  alertForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showAlertError('');

    const target = document.getElementById('alert-target-select').value;
    if (!target) {
      showAlertError('Сначала выберите пару');
      return;
    }

    const [targetType, id] = target.split(':');
    const payload = buildAlertPayload({
      kind: document.getElementById('alert-type-select').value,
      value: (document.getElementById('alert-value-input').value || '').trim().replace(',', '.'),
      windowMinutes: document.getElementById('alert-interval-select').value,
      targetType,
      symbol: targetType === 'asset' ? id : undefined,
      pairId: targetType === 'pair' ? Number(id) : undefined,
    });

    try {
      await api('/alerts', { method: 'POST', body: JSON.stringify(payload) });
      document.getElementById('alert-value-input').value = '';
      await loadAlerts();
      updateAlertHint();
    } catch (err) {
      // Правило, которого нет на сервере, показывать нельзя: оно не сработает,
      // а в списке будет выглядеть действующим.
      showAlertError(err.message || 'Правило не создано');
    }
  });
}

['alert-type-select', 'alert-target-select'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', updateAlertHint);
});
const alertValueInput = document.getElementById('alert-value-input');
if (alertValueInput) alertValueInput.addEventListener('input', updateAlertHint);

function renderAlertsList() {
  const container = document.getElementById('alerts-list');
  if (!container) return;
  container.innerHTML = '';

  if (userAlerts.length === 0) {
    container.innerHTML = '<small class="muted">Нет правил оповещений</small>';
    return;
  }

  userAlerts.forEach((rule) => {
    const row = document.createElement('div');
    row.className = 'alert-row';

    const target = rule.pair || rule.symbol || '—';
    const fired = rule.status === 'triggered' ? '<span class="fired-tag">сработало</span>' : '';

    row.innerHTML = `
      <span><b>${target}</b> ${describeAlert(rule)} ${fired}</span>
      <span class="alert-row-actions">
        <button class="btn-small" data-action="edit">Изменить</button>
        <button class="btn-small danger" data-action="delete">Удалить</button>
      </span>
    `;

    row.querySelector('[data-action="edit"]').addEventListener('click', () => editAlert(rule));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => deleteAlert(rule));

    container.appendChild(row);
  });
}

// US-3: список правил служит для просмотра, изменения и удаления. Изменение
// заодно снимает отметку «сработало», и правило начинает действовать снова.
async function editAlert(rule) {
  const next = prompt('Новое значение правила:', trimZeros(rule.target_value));
  if (next === null) return;

  try {
    await api(`/alerts/${rule.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ target_value: next.trim().replace(',', '.') }),
    });
    await loadAlerts();
  } catch (err) {
    showAlertError(err.message || 'Правило не изменено');
  }
}

async function deleteAlert(rule) {
  try {
    await api(`/alerts/${rule.id}`, { method: 'DELETE' });
    await loadAlerts();
  } catch (err) {
    showAlertError(err.message || 'Правило не удалено');
  }
}

if (state.token && state.expiresAt && new Date(state.expiresAt) > new Date()) {
  showAppView();
} else {
  showAuthView();
}