// Selection card: chain -> token -> (liquidity pool, only when several are compatible) -> Proceed.
// Pool resolution is always automatic; there is intentionally no manual pool-address input.
import { Combobox, h } from './combobox.js';
import { createNotice } from './notice.js';
import * as api from './discovery-client.js';

const DEFAULT_CHAIN = { id: 'celo', label: 'Celo' };
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export const shortAddress = address => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function usd(value) {
  if (!Number.isFinite(value)) return null;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(value >= 1e5 ? 0 : 1)}K`;
  return `$${Math.round(value)}`;
}

function logo(token) {
  const wrap = h('span', 'tk-logo');
  const letter = (token.symbol || token.name || '?').trim().charAt(0).toUpperCase() || '?';
  wrap.textContent = letter;
  if (token.logoUrl) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('load', () => wrap.replaceChildren(img), { once: true });
    img.src = token.logoUrl; // on error the letter stays
  }
  return wrap;
}

function option(lead, title, subtitle, trailing) {
  const row = h('span', 'opt');
  const text = h('span', 'opt-text');
  text.append(h('span', 'opt-title', title), h('span', 'opt-sub', subtitle));
  row.append(...(lead ? [lead] : []), text);
  if (trailing?.length) {
    const side = h('span', 'opt-side');
    trailing.filter(Boolean).forEach((line, index) => side.append(h('span', index ? 'opt-sub' : 'opt-meta', line)));
    row.append(side);
  }
  return row;
}

const poolTitle = pool => pool.fee ? `${pool.pair} · ${pool.fee}` : pool.pair;

export function createSelector({ form, onProceed }) {
  const $ = id => form.querySelector(`#${id}`);
  const els = {
    token: $('fieldToken'), pool: $('fieldPool'), chain: $('fieldChain'), manual: $('manualPanel'), poolStatus: $('poolStatus'),
    proceed: $('proceed'), error: $('scanError'), progress: $('scanProgress'), fee: $('feeNote')
  };
  const state = { chain: DEFAULT_CHAIN, token: null, pools: { status: 'idle', list: [] }, pool: null, busy: false };
  let poolAbort;
  let manualAbort;

  // ---- reusable dropdowns ----------------------------------------------
  const chainBox = new Combobox(els.chain, {
    label: 'Select Chain',
    placeholder: 'Select chain',
    searchPlaceholder: 'Search chains',
    debounceMs: 0,
    getKey: chain => chain.id,
    renderValue: chain => h('span', 'val-text', chain.label),
    renderOption: chain => option(null, chain.label, `Chain ID ${chain.chainId}`),
    emptyText: query => `No supported chain matches “${query}”.`,
    loadItems: async (query, signal) => {
      const { chains } = await api.fetchChains({ signal });
      const needle = query.toLowerCase();
      return chains.filter(chain => !needle || chain.label.toLowerCase().includes(needle) || chain.id.includes(needle));
    },
    onChange: chain => { if (chain.id !== state.chain.id) changeChain(chain); }
  });
  chainBox.setValue(DEFAULT_CHAIN);

  const manualLink = h('button', 'link-button', 'Can’t find your token? Enter contract address.');
  manualLink.type = 'button';
  manualLink.addEventListener('click', () => { tokenBox.close(false); openManual(); });

  const tokenBox = new Combobox(els.token, {
    label: 'Select Token',
    placeholder: 'Select a token',
    searchPlaceholder: 'Search name, symbol or contract address',
    footer: manualLink,
    getKey: token => `${token.chain}:${token.address.toLowerCase()}`,
    renderValue: token => option(logo(token), token.symbol || shortAddress(token.address), token.name || shortAddress(token.address)),
    renderOption: token => option(logo(token), token.symbol || shortAddress(token.address), `${token.name || 'Unnamed token'} · ${shortAddress(token.address)}`, [usd(token.liquidityUsd) && `${usd(token.liquidityUsd)} liquidity`]),
    emptyText: query => query ? `No tokens matching “${query}” on ${state.chain.label}.` : `No trending tokens found on ${state.chain.label}.`,
    loadItems: async (query, signal) => {
      const chain = state.chain.id;
      const result = query ? await api.searchTokens(chain, query, { signal }) : await api.fetchTrending(chain, { signal });
      return result.chain === chain ? result.tokens : [];
    },
    onChange: token => { closeManual(); selectToken(token); }
  });

  const poolBox = new Combobox(els.pool, {
    label: 'Select Liquidity Pool',
    placeholder: 'Choose a liquidity pool',
    searchPlaceholder: 'Search DEX, pair or address',
    debounceMs: 0,
    getKey: pool => pool.address.toLowerCase(),
    renderValue: pool => option(null, poolTitle(pool), `${pool.dex.name || 'Unknown DEX'} · ${shortAddress(pool.address)}`),
    renderOption: pool => option(null, poolTitle(pool), `${pool.dex.name || 'Unknown DEX'} · ${shortAddress(pool.address)}`, [
      usd(pool.liquidityUsd) && `${usd(pool.liquidityUsd)} liquidity`,
      usd(pool.volume24hUsd) && `${usd(pool.volume24hUsd)} 24h vol`
    ]),
    emptyText: query => `No pool matches “${query}”.`,
    loadItems: async query => {
      const needle = query.toLowerCase();
      return state.pools.list.filter(pool => !needle || [pool.pair, pool.dex.name, pool.address].some(value => String(value || '').toLowerCase().includes(needle)));
    },
    onChange: pool => { state.pool = pool; refresh(); }
  });

  // ---- manual token entry ------------------------------------------------
  const manual = {
    input: h('input', 'manual-input'),
    lookup: h('button', 'btn-secondary', 'Look up'),
    cancel: h('button', 'btn-text', 'Cancel'),
    message: h('p', 'manual-message')
  };
  manual.input.type = 'text';
  manual.input.id = 'manualAddress';
  manual.input.placeholder = '0x…';
  manual.input.autocomplete = 'off';
  manual.input.spellcheck = false;
  manual.input.setAttribute('aria-describedby', 'manualMessage');
  manual.message.id = 'manualMessage';
  manual.message.setAttribute('role', 'status');
  manual.lookup.type = 'button';
  manual.cancel.type = 'button';
  const manualLabel = h('label', 'cb-label', 'Token contract address');
  manualLabel.htmlFor = 'manualAddress';
  const manualRow = h('div', 'manual-row');
  manualRow.append(manual.input, manual.lookup, manual.cancel);
  els.manual.append(manualLabel, manualRow, manual.message);
  els.manual.hidden = true;

  function openManual() {
    manualLabel.textContent = `Token contract address on ${state.chain.label}`;
    els.manual.hidden = false;
    manual.input.focus();
  }
  function closeManual() {
    manualAbort?.abort();
    els.manual.hidden = true;
    manual.input.value = '';
    setManualMessage('');
    manual.lookup.disabled = false;
  }
  function setManualMessage(text, tone) {
    manual.message.textContent = text;
    manual.message.className = `manual-message${tone ? ` is-${tone}` : ''}`;
  }
  async function lookupManual() {
    const address = manual.input.value.trim();
    if (!ADDRESS.test(address)) { setManualMessage('Enter a valid 0x contract address (0x followed by 40 hexadecimal characters).', 'error'); return; }
    manualAbort?.abort();
    const controller = manualAbort = new AbortController();
    const chain = state.chain;
    manual.lookup.disabled = true;
    setManualMessage(`Checking the contract on ${chain.label}…`);
    try {
      const token = await api.lookupToken(chain.id, address, { signal: controller.signal });
      if (controller.signal.aborted || chain.id !== state.chain.id) return;
      tokenBox.setValue(token);
      closeManual();
      selectToken(token);
    } catch (error) {
      if (controller.signal.aborted) return;
      setManualMessage(error.message, 'error');
      manual.lookup.disabled = false;
    }
  }
  manual.lookup.addEventListener('click', lookupManual);
  manual.cancel.addEventListener('click', () => { closeManual(); tokenBox.trigger.focus(); });
  manual.input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); lookupManual(); }
    if (event.key === 'Escape') { event.preventDefault(); closeManual(); tokenBox.trigger.focus(); }
  });

  // ---- selection flow --------------------------------------------------
  function changeChain(chain) {
    state.chain = chain;
    clearToken();
    closeManual();
  }

  function clearToken() {
    poolAbort?.abort();
    state.token = null;
    state.pool = null;
    state.pools = { status: 'idle', list: [] };
    tokenBox.setValue(null);
    renderPools();
    refresh();
  }

  async function selectToken(token) {
    poolAbort?.abort();
    const controller = poolAbort = new AbortController();
    const chain = state.chain;
    state.token = token;
    state.pool = null;
    state.pools = { status: 'loading', list: [] };
    renderPools();
    refresh();
    try {
      const result = await api.discoverPools(chain.id, token.address, { signal: controller.signal });
      if (controller.signal.aborted || chain.id !== state.chain.id || result.chain !== chain.id) return;
      state.pools = { status: result.pools.length ? 'ready' : 'none', list: result.pools };
      if (result.pools.length === 1) state.pool = result.pools[0]; // single compatible pool: resolved silently
      poolBox.setValue(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      state.pools = { status: 'error', list: [], message: error.message };
      // Rate-limited by the market-data provider: retry once automatically when the wait is over.
      if (error.code === 'RATE_LIMITED' && error.retryAfter) {
        setTimeout(() => { if (state.token === token && state.pools.status === 'error' && !state.busy) selectToken(token); }, (error.retryAfter + 1) * 1000);
      }
    }
    renderPools();
    refresh();
  }

  function renderPools() {
    const { status, list, message } = state.pools;
    els.pool.hidden = !(status === 'ready' && list.length > 1);
    els.poolStatus.hidden = status === 'idle' || (status === 'ready' && list.length < 2);
    els.poolStatus.className = `pool-status is-${status}`;
    els.poolStatus.replaceChildren();
    const symbol = state.token?.symbol || 'this token';
    if (status === 'loading') els.poolStatus.append(h('span', 'cb-spinner'), h('span', null, 'Discovering liquidity pools…'));
    else if (status === 'none') {
      els.poolStatus.append(createNotice({
        tone: 'warning',
        title: 'No compatible liquidity pool',
        message: `No compatible liquidity pool was found for ${symbol} on ${state.chain.label}, so it can’t be scanned yet.`,
        actions: [{ label: 'Choose another token', onClick: () => tokenBox.open() }]
      }));
    } else if (status === 'error') {
      els.poolStatus.append(createNotice({
        tone: 'error',
        title: 'Couldn’t look up liquidity pools',
        message,
        actions: [{ label: 'Try again', primary: true, onClick: () => state.token && selectToken(state.token) }]
      }));
    } else if (status === 'ready' && list.length > 1) {
      els.poolStatus.append(h('span', null, `${list.length} compatible pools found for ${symbol}. Choose the one to scan.`));
    }
    if (status === 'ready' && list.length > 1) poolBox.setValue(state.pool);
  }

  function canProceed() { return Boolean(state.token && state.pool && !state.busy); }
  function refresh() {
    els.proceed.disabled = !canProceed();
    const lock = state.busy;
    tokenBox.setDisabled(lock);
    chainBox.setDisabled(lock);
    poolBox.setDisabled(lock);
    manual.input.disabled = lock;
    manual.lookup.disabled = lock;
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!canProceed()) return;
    onProceed({
      chain: state.chain.id,
      poolAddress: state.pool.address,
      tokenAddress: state.token.address,
      stablecoin: 'USDC', // fixed reference currency; not a user-facing field
      poolName: `${state.pool.dex.name || 'Pool'} ${poolTitle(state.pool)}`.slice(0, 100)
    });
  });

  renderPools();
  refresh();

  return {
    summary: () => ({ chain: state.chain, token: state.token, pool: state.pool }),
    setBusy(busy) { state.busy = busy; refresh(); },
    setProgress(text) { els.progress.hidden = !text; els.progress.replaceChildren(...(text ? [h('span', 'cb-spinner'), h('span', null, text)] : [])); },
    // A scan failure: what happened, why, and (optionally) what is known about payment. Never offers an automatic retry,
    // because a retry can start a second paid scan; the person presses Proceed again on purpose.
    setError(error) {
      els.error.hidden = !error;
      els.error.replaceChildren(...(error ? [createNotice({ tone: 'error', title: error.title, message: error.message, details: error.details })] : []));
    },
    setFeeNote(text) { els.fee.textContent = text || ''; els.fee.hidden = !text; },
    // Back to a clean initial selection (used by "New scan"); the chosen chain is kept.
    reset() { closeManual(); clearToken(); this.setError(null); this.setProgress(''); }
  };
}
