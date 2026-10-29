// Всплывающие уведомления. Сработавшее правило должно быть заметно сразу,
// поэтому оно показывается карточкой поверх страницы, а не строкой в списке
// внизу, которую видно только после прокрутки.

const LIFETIME = 9000;
const MAX_VISIBLE = 4;

export function createToaster() {
  const host = document.createElement('div');
  host.className = 'toast-host';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);

  const live = new Set();

  function dismiss(card) {
    if (!live.has(card)) return;
    live.delete(card);
    card.classList.add('is-leaving');
    card.addEventListener('transitionend', () => card.remove(), { once: true });
    // Карточка уходит и без события перехода: если вкладка в фоне, анимации
    // не идут, и элемент остался бы в разметке навсегда.
    setTimeout(() => card.remove(), 400);
  }

  function show({ kind = 'info', title, text = '', meta = '', timeout = LIFETIME, onClick } = {}) {
    const card = document.createElement('div');
    card.className = `toast toast-${kind}`;
    card.innerHTML = `
      <div class="toast-icon">${iconFor(kind)}</div>
      <div class="toast-body">
        <div class="toast-title">${escapeHtml(title)}</div>
        ${text ? `<div class="toast-text">${escapeHtml(text)}</div>` : ''}
        ${meta ? `<div class="toast-meta">${escapeHtml(meta)}</div>` : ''}
      </div>
      <button class="toast-close icon-x" type="button" aria-label="Закрыть"></button>
      <div class="toast-bar"><i></i></div>`;

    card.querySelector('.toast-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss(card);
    });

    if (onClick) {
      card.classList.add('is-clickable');
      card.addEventListener('click', () => {
        onClick();
        dismiss(card);
      });
    }

    host.appendChild(card);
    live.add(card);
    requestAnimationFrame(() => card.classList.add('is-in'));

    while (live.size > MAX_VISIBLE) dismiss(live.values().next().value);

    if (timeout > 0) {
      const bar = card.querySelector('.toast-bar i');
      bar.style.transitionDuration = `${timeout}ms`;
      requestAnimationFrame(() => {
        bar.style.transform = 'scaleX(0)';
      });

      let timer = setTimeout(() => dismiss(card), timeout);
      // Пока курсор на карточке, отсчёт останавливается: иначе уведомление
      // исчезает в момент, когда его как раз начали читать.
      card.addEventListener('mouseenter', () => {
        clearTimeout(timer);
        bar.style.transitionDuration = '0ms';
        bar.style.transform = getComputedStyle(bar).transform;
      });
      card.addEventListener('mouseleave', () => {
        bar.style.transitionDuration = `${timeout}ms`;
        bar.style.transform = 'scaleX(0)';
        timer = setTimeout(() => dismiss(card), timeout);
      });
    }

    return card;
  }

  return { show };
}

function iconFor(kind) {
  if (kind === 'up') return '&#9650;';
  if (kind === 'down') return '&#9660;';
  if (kind === 'error') return '!';
  if (kind === 'success') return '&#10003;';
  return '&#9679;';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}
