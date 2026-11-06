// Reusable notice (error / warning / info) used wherever the app must say that something did not work,
// instead of rendering empty cards. Every notice says what happened, why, and what the person can do.
//
// createNotice({ tone: 'error' | 'warning' | 'info', size?: 'lg', title, message, details: [{ label, text }], actions: [{ label, onClick, primary }] })
// All text is set with textContent, so provider or API strings are safe to pass in.
import { h } from './combobox.js';

export function createNotice({ tone = 'error', size, title, message, details = [], actions = [] }) {
  const node = h('div', `notice notice-${tone}${size === 'lg' ? ' notice-lg' : ''}`);
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  node.append(h('p', 'notice-title', title));
  if (message) node.append(h('p', 'notice-message', message));
  if (details.length) {
    const list = h('dl', 'notice-details');
    for (const { label, text } of details) list.append(h('dt', null, label), h('dd', null, text));
    node.append(list);
  }
  if (actions.length) {
    const row = h('div', 'notice-actions');
    for (const action of actions) {
      const button = h('button', action.primary ? 'btn-primary' : 'btn-secondary', action.label);
      button.type = 'button';
      button.addEventListener('click', action.onClick);
      row.append(button);
    }
    node.append(row);
  }
  return node;
}
