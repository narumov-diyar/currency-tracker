// Замена системных элементов управления.
//
// Нативный <select> и стрелки числового поля рисует операционная система:
// они не поддаются оформлению и в каждом браузере выглядят по-своему, из-за
// чего посреди тёмной страницы появляются светлые окна Windows. Поэтому
// список и счётчик нарисованы своей разметкой.
//
// Сам <select> при этом остаётся в документе и хранит значение: остальной
// код читает select.value и слушает change, ничего не зная о подмене.

const openPopups = new Set();

export function enhanceSelect(select, { searchable = 'auto' } = {}) {
  if (select.dataset.enhanced) return;
  select.dataset.enhanced = '1';

  const box = document.createElement('div');
  box.className = 'select';
  select.parentNode.insertBefore(box, select);
  box.appendChild(select);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'select-btn';
  button.innerHTML = '<span class="select-value"></span><i class="select-caret"></i>';

  const pop = document.createElement('div');
  pop.className = 'select-pop is-hidden';

  box.append(button, pop);

  let items = [];
  let active = -1;

  const withSearch = () => searchable === true || (searchable === 'auto' && select.options.length > 8);

  function syncLabel() {
    const option = select.selectedOptions[0];
    button.querySelector('.select-value').textContent = option ? option.textContent : '';
    button.disabled = select.disabled;
    box.classList.toggle('is-disabled', select.disabled);
  }

  function buildList(filter = '') {
    pop.querySelectorAll('.select-opt, .select-group, .select-none').forEach((n) => n.remove());
    items = [];
    const needle = filter.trim().toLowerCase();

    for (const node of select.children) {
      const options = node.tagName === 'OPTGROUP' ? [...node.children] : [node];
      const matched = options.filter((o) => !needle || o.textContent.toLowerCase().includes(needle));
      if (matched.length === 0) continue;

      if (node.tagName === 'OPTGROUP') {
        const head = document.createElement('div');
        head.className = 'select-group';
        head.textContent = node.label;
        pop.appendChild(head);
      }

      for (const option of matched) {
        const row = document.createElement('div');
        row.className = 'select-opt';
        row.textContent = option.textContent;
        row.dataset.value = option.value;
        row.setAttribute('role', 'option');
        if (option.value === select.value) row.classList.add('is-current');
        row.addEventListener('mouseenter', () => highlight(items.indexOf(row)));
        row.addEventListener('click', () => choose(option.value));
        pop.appendChild(row);
        items.push(row);
      }
    }

    if (items.length === 0) {
      const none = document.createElement('div');
      none.className = 'select-none';
      none.textContent = 'Ничего не найдено';
      pop.appendChild(none);
    }

    highlight(items.findIndex((row) => row.classList.contains('is-current')));
  }

  function highlight(index) {
    if (active >= 0 && items[active]) items[active].classList.remove('is-active');
    active = index;
    if (active >= 0 && items[active]) {
      items[active].classList.add('is-active');
      items[active].scrollIntoView({ block: 'nearest' });
    }
  }

  function choose(value) {
    close();
    if (select.value === value) return;
    select.value = value;
    syncLabel();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function open() {
    if (select.disabled) return;
    for (const other of openPopups) other();

    pop.innerHTML = '';
    if (withSearch()) {
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'select-search';
      search.placeholder = 'Поиск…';
      search.addEventListener('input', () => buildList(search.value));
      search.addEventListener('keydown', onKeys);
      pop.appendChild(search);
      setTimeout(() => search.focus(), 0);
    }

    buildList();
    pop.classList.remove('is-hidden');
    box.classList.add('is-open');
    // Список может не поместиться под кнопкой — тогда он раскрывается вверх.
    pop.classList.toggle('is-up', button.getBoundingClientRect().bottom + 280 > window.innerHeight);
    openPopups.add(close);
  }

  function close() {
    pop.classList.add('is-hidden');
    box.classList.remove('is-open');
    openPopups.delete(close);
  }

  function onKeys(e) {
    if (e.key === 'Escape') {
      close();
      button.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (pop.classList.contains('is-hidden')) {
        open();
        return;
      }
      const next = active + (e.key === 'ArrowDown' ? 1 : -1);
      highlight(Math.max(0, Math.min(items.length - 1, next)));
      return;
    }
    if (e.key === 'Enter' && !pop.classList.contains('is-hidden')) {
      e.preventDefault();
      if (items[active]) choose(items[active].dataset.value);
    }
  }

  button.addEventListener('click', () => (pop.classList.contains('is-hidden') ? open() : close()));
  button.addEventListener('keydown', onKeys);
  document.addEventListener('pointerdown', (e) => {
    if (!box.contains(e.target)) close();
  });

  // Список целей и активов перерисовывается кодом страницы, поэтому надпись
  // на кнопке обновляется по изменению самого <select>, а не вручную.
  new MutationObserver(syncLabel).observe(select, {
    childList: true,
    attributes: true,
    attributeFilter: ['disabled', 'value'],
  });
  select.addEventListener('change', syncLabel);
  syncLabel();
}

// Числовое поле: системные стрелки крошечные и в тёмной теме выглядят
// чужеродно. Шаг задаётся снаружи — порог курса и проценты меняются
// величинами разного порядка.
export function enhanceNumber(input) {
  if (input.controls) return input.controls;

  const box = document.createElement('div');
  box.className = 'number';
  input.parentNode.insertBefore(box, input);
  box.appendChild(input);

  const unit = document.createElement('span');
  unit.className = 'number-unit';

  const steps = document.createElement('div');
  steps.className = 'number-steps';
  steps.innerHTML = '<button type="button" class="number-btn" data-dir="1">+</button>'
    + '<button type="button" class="number-btn" data-dir="-1">&minus;</button>';

  box.append(unit, steps);

  let step = 1;

  function nudge(dir) {
    const current = parseFloat((input.value || '').replace(',', '.'));
    const next = (Number.isFinite(current) ? current : 0) + dir * step;
    // Шаг может быть дробным, и обычное сложение даёт 0.30000000000000004.
    const digits = Math.max(0, -Math.floor(Math.log10(step)));
    input.value = next <= 0 ? '' : next.toFixed(digits).replace(/\.?0+$/, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  steps.querySelectorAll('.number-btn').forEach((btn) => {
    btn.addEventListener('click', () => nudge(Number(btn.dataset.dir)));
  });

  input.controls = {
    setUnit(text) {
      unit.textContent = text || '';
      box.classList.toggle('has-unit', Boolean(text));
    },
    setStep(value) {
      if (value > 0) step = value;
    },
    setPlaceholder(text) {
      input.placeholder = text;
    },
  };
  return input.controls;
}

// Поле поиска с кнопкой очистки: системный крестик есть не везде и
// появляется только в части браузеров.
export function enhanceSearch(input) {
  if (input.dataset.enhanced) return;
  input.dataset.enhanced = '1';

  const box = document.createElement('div');
  box.className = 'search-box';
  input.parentNode.insertBefore(box, input);
  box.appendChild(input);

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'search-clear icon-x is-hidden';
  clear.setAttribute('aria-label', 'Очистить поиск');
  box.appendChild(clear);

  const sync = () => clear.classList.toggle('is-hidden', input.value === '');
  input.addEventListener('input', sync);
  clear.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });
  sync();
}
