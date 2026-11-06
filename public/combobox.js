// Reusable searchable combobox (ARIA 1.2 "select-only combobox with listbox popup" + a search field).
// Used for chain, token and liquidity-pool selection; each caller supplies loading and rendering.
//
// options:
//   label, placeholder, searchPlaceholder
//   loadItems(query, signal) -> Promise<item[]>   called on open and (debounced) while typing
//   getKey(item) -> string, renderOption(item) -> Node, renderValue(item) -> Node
//   emptyText(query) -> string, footer -> Node (optional)
//   debounceMs (default 250), onChange(item)
// All item text must be rendered with DOM nodes / textContent, never innerHTML.

let uid = 0;

export function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class Combobox {
  constructor(mount, options) {
    this.o = { debounceMs: 250, searchPlaceholder: 'Search', emptyText: () => 'No results found.', ...options };
    this.id = `cb${++uid}`;
    this.items = [];
    this.value = null;
    this.active = -1;
    this.isOpen = false;
    this.query = '';
    this.requestId = 0;
    this.build(mount);
    this.renderTrigger();
  }

  build(mount) {
    const { id } = this;
    this.root = h('div', 'cb');
    this.labelEl = h('span', 'cb-label', this.o.label);
    this.labelEl.id = `${id}-label`;
    this.trigger = h('button', 'cb-trigger');
    this.trigger.type = 'button';
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-labelledby', `${id}-label ${id}-trigger-value`);
    this.valueEl = h('span', 'cb-value');
    this.valueEl.id = `${id}-trigger-value`;
    this.trigger.append(this.valueEl, h('span', 'cb-caret'));
    this.trigger.lastChild.setAttribute('aria-hidden', 'true');

    this.popover = h('div', 'cb-popover');
    this.popover.hidden = true;
    this.search = h('input', 'cb-search');
    this.search.type = 'text';
    this.search.placeholder = this.o.searchPlaceholder;
    this.search.autocomplete = 'off';
    this.search.spellcheck = false;
    this.search.setAttribute('role', 'combobox');
    this.search.setAttribute('aria-expanded', 'true');
    this.search.setAttribute('aria-controls', `${id}-list`);
    this.search.setAttribute('aria-autocomplete', 'list');
    this.search.setAttribute('aria-label', `Search ${String(this.o.label).toLowerCase()}`);
    this.list = h('ul', 'cb-list');
    this.list.id = `${id}-list`;
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-labelledby', `${id}-label`);
    this.statusEl = h('div', 'cb-status');
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.hidden = true;
    this.popover.append(this.search, this.list, this.statusEl);
    if (this.o.footer) {
      this.footer = h('div', 'cb-footer');
      this.footer.append(this.o.footer);
      this.popover.append(this.footer);
    }
    // The anchor (trigger + popover) is the positioning context, so the popover opens relative to the trigger.
    this.anchor = h("div", "cb-anchor");
    this.anchor.append(this.trigger, this.popover);
    this.root.append(this.labelEl, this.anchor);
    mount.replaceChildren(this.root);

    this.trigger.addEventListener('click', () => (this.isOpen ? this.close(true) : this.open()));
    this.trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); this.open(); }
    });
    this.search.addEventListener('input', () => this.schedule(this.search.value));
    this.search.addEventListener('keydown', event => this.onKeydown(event));
    this.list.addEventListener('pointerdown', event => event.preventDefault());
    this.list.addEventListener('click', event => {
      const row = event.target.closest('[role=option]');
      if (row) this.select(this.items[Number(row.dataset.index)]);
    });
    this.list.addEventListener('pointermove', event => {
      const row = event.target.closest('[role=option]');
      if (row && Number(row.dataset.index) !== this.active) this.setActive(Number(row.dataset.index), false);
    });
    this.onDocumentDown = event => { if (!this.root.contains(event.target)) this.close(false); };
    this.onReposition = () => this.position();
  }

  // ---- public API -------------------------------------------------------
  getValue() { return this.value; }

  setValue(item) {
    this.value = item || null;
    this.renderTrigger();
    if (this.isOpen) this.renderList();
  }

  setDisabled(disabled) {
    this.trigger.disabled = Boolean(disabled);
    if (disabled) this.close(false);
  }

  setLabel(label) { this.labelEl.textContent = label; }

  open() {
    if (this.isOpen || this.trigger.disabled) return;
    this.isOpen = true;
    this.popover.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.root.classList.add('cb-open');
    this.search.value = '';
    this.query = '';
    this.position();
    document.addEventListener('pointerdown', this.onDocumentDown, true);
    window.addEventListener('resize', this.onReposition);
    window.addEventListener('scroll', this.onReposition, true);
    this.search.focus({ preventScroll: true });
    this.load('');
  }

  close(returnFocus) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.requestId += 1; // ignore anything still in flight
    clearTimeout(this.timer);
    clearTimeout(this.slowTimer);
    this.abort?.abort();
    this.popover.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.root.classList.remove('cb-open', 'cb-busy');
    document.removeEventListener('pointerdown', this.onDocumentDown, true);
    window.removeEventListener('resize', this.onReposition);
    window.removeEventListener('scroll', this.onReposition, true);
    if (returnFocus) this.trigger.focus({ preventScroll: true });
  }

  select(item) {
    if (!item) return;
    this.value = item;
    this.renderTrigger();
    this.close(true);
    this.o.onChange?.(item);
  }

  // ---- loading ----------------------------------------------------------
  schedule(query) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(query), this.o.debounceMs);
  }

  async load(query) {
    this.query = query.trim();
    this.abort?.abort();
    clearTimeout(this.slowTimer);
    const id = ++this.requestId;
    const controller = this.abort = new AbortController();
    // Only show the spinner when a request is slow, so instant (static) sources never flash it.
    this.slowTimer = setTimeout(() => { if (id === this.requestId) this.setStatus('loading'); }, 150);
    try {
      const items = await this.o.loadItems(this.query, controller.signal);
      if (id !== this.requestId) return;
      clearTimeout(this.slowTimer);
      this.items = items;
      this.renderList();
      this.setStatus(items.length ? 'ready' : 'empty');
      this.active = -1;
      const selectedIndex = this.value ? items.findIndex(item => this.o.getKey(item) === this.o.getKey(this.value)) : -1;
      if (items.length) this.setActive(selectedIndex >= 0 ? selectedIndex : 0, true);
    } catch (error) {
      if (id !== this.requestId || error?.name === 'AbortError') return;
      clearTimeout(this.slowTimer);
      this.items = [];
      this.renderList();
      this.setStatus('error', error?.message || 'Something went wrong.');
    }
  }

  setStatus(state, message) {
    this.root.classList.toggle('cb-busy', state === 'loading' && this.items.length > 0);
    this.list.setAttribute('aria-busy', String(state === 'loading'));
    this.statusEl.replaceChildren();
    this.statusEl.className = `cb-status cb-status-${state}`;
    if (state === 'loading') {
      if (this.items.length) { this.statusEl.hidden = true; return; }
      this.statusEl.hidden = false;
      this.statusEl.append(h('span', 'cb-spinner'), h('span', null, 'Loading…'));
    } else if (state === 'empty') {
      this.statusEl.hidden = false;
      this.statusEl.textContent = this.o.emptyText(this.query);
    } else if (state === 'error') {
      this.statusEl.hidden = false;
      const retry = h('button', 'cb-retry', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', () => this.load(this.query));
      this.statusEl.append(h('span', 'cb-error', message), retry);
    } else {
      // Announce result count to assistive tech without showing it.
      this.statusEl.hidden = false;
      this.statusEl.className = 'cb-status cb-status-ready sr-only';
      this.statusEl.textContent = `${this.items.length} result${this.items.length === 1 ? '' : 's'} available`;
    }
  }

  // ---- rendering / keyboard --------------------------------------------
  renderTrigger() {
    this.valueEl.replaceChildren();
    if (this.value && this.o.renderValue) {
      this.valueEl.append(this.o.renderValue(this.value));
      this.valueEl.classList.remove('cb-placeholder');
    } else {
      this.valueEl.textContent = this.o.placeholder || 'Select';
      this.valueEl.classList.add('cb-placeholder');
    }
  }

  renderList() {
    const selectedKey = this.value ? this.o.getKey(this.value) : null;
    this.list.replaceChildren(...this.items.map((item, index) => {
      const row = h('li', 'cb-option');
      row.id = `${this.id}-o${index}`;
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selectedKey !== null && this.o.getKey(item) === selectedKey));
      row.append(this.o.renderOption(item));
      return row;
    }));
    this.search.removeAttribute('aria-activedescendant');
  }

  setActive(index, scroll) {
    const rows = this.list.children;
    if (!rows.length) return;
    const next = (index + rows.length) % rows.length;
    rows[this.active]?.classList.remove('cb-active');
    this.active = next;
    rows[next].classList.add('cb-active');
    this.search.setAttribute('aria-activedescendant', rows[next].id);
    if (scroll) rows[next].scrollIntoView({ block: 'nearest' });
  }

  onKeydown(event) {
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); this.setActive(this.active + 1, true); break;
      case 'ArrowUp': event.preventDefault(); this.setActive(this.active - 1, true); break;
      case 'Home': if (this.items.length) { event.preventDefault(); this.setActive(0, true); } break;
      case 'End': if (this.items.length) { event.preventDefault(); this.setActive(this.items.length - 1, true); } break;
      case 'Enter': event.preventDefault(); if (this.active >= 0) this.select(this.items[this.active]); break;
      case 'Escape': event.preventDefault(); event.stopPropagation(); this.close(true); break;
      case 'Tab': this.close(false); break;
      default:
    }
  }

  // Opens upward when there is more room above, and sizes the list to the space available.
  position() {
    const rect = this.trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const up = below < 280 && above > below;
    this.root.classList.toggle('cb-up', up);
    this.list.style.maxHeight = `${Math.max(150, Math.min(360, (up ? above : below) - 100))}px`;
  }
}
