/**
 * <mt-app-launcher>: switch between an organization's applications, from any
 * application's header (docs/hub/HUB_GAPS.md G5; docs/PRODUCT_INTEGRATION.md,
 * "The application launcher"). Served at /embed/v1/launcher.js
 * (routes/embed.ts) for applications to load from their own pages.
 *
 *   <script type="module" src="https://<platform>/api/embed/v1/launcher.js"></script>
 *   <mt-app-launcher src="/platform/launcher"></mt-app-launcher>
 *
 * `src` is an address on the application's own server that answers with
 * GET .../members/{subject}/applications for the signed-in person (fetched
 * with the page's own cookies); or set the element's `data` property to that
 * answer. It never talks to the platform itself and holds no token.
 *
 * Plain JavaScript, no dependencies: a button and a list in a shadow root,
 * built with DOM calls only (nothing from the data is parsed as HTML), only
 * http(s) links, closed with Escape or a click outside. Themed by the
 * branding's custom properties (--mt-color-primary, --mt-color-on-primary,
 * --mt-radius, --mt-font-family), with fallbacks, light and dark.
 */
export const LAUNCHER_VERSION = '1';

export const LAUNCHER_JS = String.raw`/* <mt-app-launcher> v1 */
(function () {
  if (typeof customElements === 'undefined' || customElements.get('mt-app-launcher')) return;
  var CSS = [
    ':host{display:inline-block;position:relative;font-family:var(--mt-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);',
    '--_bg:#ffffff;--_fg:#111827;--_muted:#6b7280;--_line:#e5e7eb;--_hover:#f3f4f6;--_accent:var(--mt-color-primary,#3b82f6);--_on:var(--mt-color-on-primary,#ffffff)}',
    '@media (prefers-color-scheme:dark){:host{--_bg:#1f2937;--_fg:#f9fafb;--_muted:#9ca3af;--_line:#374151;--_hover:#374151}}',
    'button{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border:0;border-radius:var(--mt-radius,8px);background:transparent;color:inherit;cursor:pointer}',
    'button:hover,button[aria-expanded="true"]{background:var(--_hover)}',
    'button:focus-visible,a:focus-visible{outline:2px solid var(--_accent);outline-offset:2px}',
    'svg{width:20px;height:20px}',
    '.panel{position:absolute;right:0;top:calc(100% + 6px);z-index:2147483000;width:min(320px,calc(100vw - 32px));max-height:min(480px,calc(100vh - 80px));overflow:auto;',
    'background:var(--_bg);color:var(--_fg);border:1px solid var(--_line);border-radius:var(--mt-radius,8px);box-shadow:0 10px 30px rgba(0,0,0,.18);padding:8px}',
    '.panel[hidden]{display:none}',
    '.head{font-size:12px;color:var(--_muted);padding:6px 8px 4px;text-transform:uppercase;letter-spacing:.04em}',
    'ul{list-style:none;margin:0;padding:0}',
    'a{display:flex;align-items:center;gap:10px;padding:8px;border-radius:calc(var(--mt-radius,8px) - 2px);color:inherit;text-decoration:none;font-size:14px}',
    'a:hover{background:var(--_hover)}',
    '.mark{flex:none;width:28px;height:28px;border-radius:calc(var(--mt-radius,8px) - 2px);display:grid;place-items:center;font-weight:600;font-size:13px;background:var(--_hover);color:var(--_fg)}',
    'a[aria-current="page"] .mark{background:var(--_accent);color:var(--_on)}',
    '.name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.here{font-size:12px;color:var(--_muted)}',
    '.sub{padding-left:46px}.sub a{padding:4px 8px;font-size:13px;color:var(--_muted)}',
    '.portal{border-top:1px solid var(--_line);margin-top:6px;padding-top:6px}',
    '.empty{padding:12px 8px;font-size:14px;color:var(--_muted)}'
  ].join('');
  var GRID = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></svg>';
  function safeUrl(u) {
    try { var x = new URL(String(u), location.href); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch (e) { return null; }
  }
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }
  var count = 0;
  class Launcher extends HTMLElement {
    static get observedAttributes() { return ['src', 'label']; }
    constructor() {
      super();
      var id = 'mt-launcher-' + (++count);
      var root = this.attachShadow({ mode: 'open' });
      var style = el('style'); style.textContent = CSS; root.appendChild(style);
      this._button = el('button', { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': 'Applications', title: 'Applications' });
      this._button.innerHTML = GRID;
      this._panel = el('div', { id: id, class: 'panel', role: 'region', 'aria-label': 'Applications', hidden: '' });
      root.appendChild(this._button); root.appendChild(this._panel);
      var self = this;
      this._button.addEventListener('click', function () { self.open = !self.open; });
      this._onKey = function (e) { if (e.key === 'Escape' && self.open) { self.open = false; self._button.focus(); } };
      this._onDoc = function (e) { if (self.open && e.composedPath().indexOf(self) === -1) self.open = false; };
      this._data = null;
      this._render();
    }
    connectedCallback() {
      document.addEventListener('keydown', this._onKey);
      document.addEventListener('click', this._onDoc, true);
      if (this.getAttribute('src') && !this._data) this._load();
    }
    disconnectedCallback() {
      document.removeEventListener('keydown', this._onKey);
      document.removeEventListener('click', this._onDoc, true);
    }
    attributeChangedCallback(name) {
      if (name === 'label') this._button.setAttribute('aria-label', this.getAttribute('label') || 'Applications');
      if (name === 'src' && this.isConnected) this._load();
    }
    get open() { return this._button.getAttribute('aria-expanded') === 'true'; }
    set open(v) {
      this._button.setAttribute('aria-expanded', v ? 'true' : 'false');
      if (v) this._panel.removeAttribute('hidden'); else this._panel.setAttribute('hidden', '');
      if (v && this.getAttribute('src') && !this._data) this._load();
    }
    get data() { return this._data; }
    set data(v) { this._data = v; this._error = null; this._render(); }
    _load() {
      var self = this, src = safeUrl(this.getAttribute('src'));
      if (!src) return;
      fetch(src, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
        .then(function (d) { self.data = d; self.dispatchEvent(new CustomEvent('mt-launcher-loaded', { detail: d })); })
        .catch(function () { self._error = true; self._render(); });
    }
    _render() {
      var p = this._panel, d = this._data;
      p.textContent = '';
      if (!d) { p.appendChild(el('div', { class: 'empty' }, this._error ? 'Couldn’t load your applications' : 'Loading…')); return; }
      var apps = Array.isArray(d.applications) ? d.applications : [];
      if (d.organization && d.organization.name) p.appendChild(el('div', { class: 'head' }, d.organization.name));
      var list = el('ul');
      apps.forEach(function (a) {
        var url = safeUrl(a.url); if (!url) return;
        var li = el('li');
        var link = el('a', { href: url, 'aria-current': a.current ? 'page' : null });
        link.appendChild(el('span', { class: 'mark', 'aria-hidden': 'true' }, String(a.name || '?').trim().charAt(0).toUpperCase()));
        link.appendChild(el('span', { class: 'name' }, a.name));
        if (a.current) link.appendChild(el('span', { class: 'here' }, 'You’re here'));
        li.appendChild(link);
        var entries = Array.isArray(a.entries) ? a.entries : [];
        if (entries.length > 1) {
          var sub = el('ul', { class: 'sub' });
          entries.forEach(function (e) { var u = safeUrl(e.url); if (!u) return; var i = el('li'); i.appendChild(el('a', { href: u }, e.label)); sub.appendChild(i); });
          li.appendChild(sub);
        }
        list.appendChild(li);
      });
      if (!list.childNodes.length) p.appendChild(el('div', { class: 'empty' }, 'No applications to switch to'));
      else p.appendChild(list);
      var portal = d.portal && safeUrl(d.portal.url);
      if (portal) {
        var w = el('div', { class: 'portal' });
        var a2 = el('a', { href: portal });
        a2.appendChild(el('span', { class: 'mark', 'aria-hidden': 'true' }, '⌂'));
        a2.appendChild(el('span', { class: 'name' }, (d.portal.label || 'Portal') + ' portal'));
        w.appendChild(a2); p.appendChild(w);
      }
    }
  }
  customElements.define('mt-app-launcher', Launcher);
})();
`;
