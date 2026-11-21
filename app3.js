'use strict';
/* ============================================================
   Kitchen display (KDS) + Admin area
   ============================================================ */

// ================= KITCHEN =================
function renderKitchen(app) {
  var orders = (S.data.orders || []).map(function(o) {
    if (!S.kitchenStation) return o;
    var copy = Object.assign({}, o);
    copy.lines = (o.lines || []).filter(function(l){return l.kitchen_station === S.kitchenStation;});
    var active = copy.lines.filter(function(l){return l.status !== 'cancelled';});
    if (!active.length) return null;
    copy.status = active.every(function(l){return l.status === 'ready' || l.status === 'served';}) ? 'ready' :
      (active.some(function(l){return l.status === 'preparing';}) ? 'preparing' : 'sent');
    return copy;
  }).filter(Boolean);
  var cols = [
    { cls: 'c-new',  title: '🆕 ' + tr('new'),     st: 'sent' },
    { cls: 'c-prep', title: '🔥 ' + tr('cooking'), st: 'preparing' },
    { cls: 'c-ready', title: '✅ ' + tr('ready'),  st: 'ready' }
  ];
  var html = cols.map(function (c) {
    var list = orders.filter(function (o) { return o.status === c.st; })
      .sort(function (a, b) { return a.created_at - b.created_at; });
    return '<div class="kcol ' + c.cls + '"><h2><span>' + c.title + '</span><span class="tag">' +
      list.length + '</span></h2>' +
      (list.map(kCard).join('') || '<div class="empty">' + tr('nothingHere') + '</div>') + '</div>';
  }).join('');
  app.innerHTML =
    '<div class="topbar"><div class="tb-left"><span class="tb-title">👨‍🍳 ' + tr('kitchenRole') + '</span>' +
      '<span class="tb-sub">' + esc(localizedLabel(S.data.restaurant)) + '</span></div>' +
      '<div class="tb-right">' + branchControl() + langControl() + '<button class="btn small" onclick="goHome()">⌂ ' + tr('home') + '</button>' + connDot() + '</div></div>' +
    '<div class="kds">' + html + '</div>';
}
function leaveRole() { goHome(); }

function kCard(o) {
  var lines = o.lines.map(function (l) {
    var modifiers = lineModifiers(l.modifiers);
    if (!modifiers.length && l.modifiers_json) modifiers = lineModifiers(l.modifiers_json);
    var tap = l.status === 'sent' || l.status === 'preparing';
    var cls = 'kline' + (l.status === 'cancelled' ? ' cancelled' : ' l-' + l.status);
    return '<div class="' + cls + '"' + (tap ? ' onclick="lineNext(' + o.id + ',' + l.id + ')"' : '') + '>' +
      '<span class="kq">' + l.qty + '×</span><span>' + esc(localizedLabel(l.name)) +
      (l.variant_name ? ' (' + esc(l.variant_name) + ')' : '') + '</span>' +
      (modifiers.length ? '<span class="lnote">+ ' + esc(modifiers.map(function (m) { return m.name; }).join(', ')) + '</span>' : '') +
      (l.note ? '<span class="lnote">· ' + esc(l.note) + '</span>' : '') +
      '<span class="chip ' + l.status + '">' + (l.status === 'cancelled' ? '86' : tStatus(l.status)) + '</span>' +
      (l.status !== 'cancelled' && o.status !== 'served'
        ? '<button class="lx" title="' + tr('outOfStock') + '" onclick="event.stopPropagation();cancelLineDlg(' + o.id + ',' + l.id + ')">✕</button>'
        : '') +
      '</div>';
  }).join('');
  var btns = '<div class="kbtns">';
  if (!S.kitchenStation && o.status === 'sent') btns += '<button class="btn small violet" onclick="startOrder(' + o.id + ')">▶ ' + tr('startCooking') + '</button>';
  if (!S.kitchenStation && (o.status === 'sent' || o.status === 'preparing')) btns += '<button class="btn small green" onclick="allReady(' + o.id + ')">✓ ' + tr('allReady') + '</button>';
  btns += '<button class="btn small" onclick="printTicket(' + o.id + ')">🖨️ ' + tr('print') + '</button>';
  if (o.status !== 'served') btns += '<button class="btn small danger" onclick="cancelOrderDlg(' + o.id + ')">✕ ' + tr('cancel') + '</button>';
  btns += '</div>';
  return '<div class="kcard st-' + o.status + '">' +
    '<div class="khead"><span class="ktable">' + tr('table') + ' ' + o.table_no + '</span>' +
    '<span class="dim">' + esc(o.staff_name || '') + '</span>' +
    '<span class="kage ' + ageClass(o.created_at) + '">' + ageLabel(o.created_at) + '</span></div>' +
    lines +
    (o.note ? '<div class="knote">' + tr('notePrefix') + esc(o.note) + '</div>' : '') +
    btns + '</div>';
}
function startOrder(id) { actOrQueue('/api/orders/' + id + '/status', { status: 'preparing' }, tr('cookingStarted')); }
function allReady(id) { actOrQueue('/api/orders/' + id + '/status', { status: 'ready' }, tr('orderReady')); }
async function lineNext(orderId, lineId) {
  var o = (S.data.orders || []).filter(function (x) { return x.id === orderId; })[0];
  if (!o) return;
  var l = o.lines.filter(function (x) { return x.id === lineId; })[0];
  if (!l) return;
  var next = l.status === 'sent' ? 'preparing' : (l.status === 'preparing' ? 'ready' : null);
  if (!next) { toast(tr('alreadyReady')); return; }
  actOrQueue('/api/orders/' + orderId + '/lines/' + lineId + '/status', { status: next },
    next === 'ready' ? tr('itemReady') : tr('itemCooking'));
}

// ================= ADMIN =================
function renderAdmin(app) {
  if (!S.adminPin) { renderAdminGate(app); return; }
  var tabs = [
    ['sections', '🗂 ' + tr('sections')], ['items', '🍽 ' + tr('menuTab')], ['waiters', '🧑‍🤝‍🧑 ' + tr('waiters')],
    ['orders', '🧾 ' + tr('orders')], ['reservations', '🗓 ' + tr('reservations')],
    ['sales', '📈 ' + tr('sales')], ['branches', '🏢 ' + tr('branch')], ['settings', '⚙️ ' + tr('settings')]
  ];
  var tabBtns = tabs.map(function (t) {
    return '<button class="btn small ' + (S.adminTab === t[0] ? 'on' : '') +
      '" onclick="setTab(\'' + t[0] + '\')">' + t[1] + '</button>';
  }).join('');
  var body = '';
  if (S.adminTab === 'sections') body = adminSections();
  else if (S.adminTab === 'items') body = adminItems();
  else if (S.adminTab === 'waiters') body = adminWaiters();
  else if (S.adminTab === 'orders') body = adminOrders();
  else if (S.adminTab === 'reservations') body = adminReservations();
  else if (S.adminTab === 'sales') body = adminAnalytics();
  else if (S.adminTab === 'branches') body = adminBranches();
  else body = adminSettings();
  app.innerHTML =
    '<div class="topbar"><div class="tb-left"><span class="tb-title">⚙️ ' + tr('admin') + '</span>' +
      '<span class="tb-sub">' + esc(localizedLabel(S.data.restaurant)) + '</span></div>' +
      '<div class="tb-right">' + branchControl() + langControl() + '<button class="btn small" onclick="goHome()">⌂ ' + tr('home') + '</button>' + connDot() + '</div></div>' +
    '<div class="tabs">' + tabBtns + '</div>' +
    '<div class="pad">' + body + '</div>';
}
function setTab(t) {
  S.adminTab = t; S.adminSearch = ''; render();
  if (t === 'items') loadCatalogEditor();
  if (t === 'sales') loadSales('7d');
}

// ---- PIN gate ----
var pinBuf = '';
function renderAdminGate(app) {
  app.innerHTML =
    '<div class="topbar"><div class="tb-left"><span class="tb-title">⚙️ ' + tr('admin') + '</span></div>' +
      '<div class="tb-right">' + langControl() + '<button class="btn small" onclick="leaveRole()">' + tr('roles') + '</button>' + connDot() + '</div></div>' +
    '<div class="role-wrap"><div class="brand">' + tr('restricted') + '</div><h1>' + tr('enterPin') + '</h1>' +
    '<div class="pindots" id="pindots"></div>' +
    '<div class="pinpad">' +
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (n) { return '<button onclick="pinKey(' + n + ')">' + n + '</button>'; }).join('') +
      '<button onclick="pinClear()">' + tr('clear') + '</button><button onclick="pinKey(0)">0</button><button onclick="pinBack()">⌫</button>' +
    '</div>' +
    '<button class="btn primary" style="margin-top:16px;min-width:220px" onclick="tryPin()">' + tr('unlock') + ' ✓</button>' +
    '<div class="hint">' + tr('defaultPin') + '</div></div>';
  drawPinDots();
}
function drawPinDots() {
  var el = document.getElementById('pindots');
  if (!el) return;
  el.innerHTML = [0, 1, 2, 3].map(function (i) {
    return '<span class="' + (i < pinBuf.length ? 'f' : '') + '"></span>';
  }).join('');
}
function pinKey(n) { if (pinBuf.length < 8) { pinBuf += n; drawPinDots(); } }
function pinBack() { pinBuf = pinBuf.slice(0, -1); drawPinDots(); }
function pinClear() { pinBuf = ''; drawPinDots(); }
async function tryPin() {
  if (!pinBuf) { toast(tr('enterPinToast')); return; }
  S.adminPin = pinBuf;
  try {
    await api('/api/export');           // harmless request that validates the PIN
    sessionStorage.setItem('ro_adminpin', pinBuf);
    pinBuf = ''; toast(tr('adminUnlocked')); render();
  } catch (e) {
    S.adminPin = null; pinBuf = '';
    toast(e.code === 403 ? tr('wrongPin') : (tr('serverUnavailable') + e.message));
    drawPinDots();
  }
}

// ---- form helpers ----
function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }
function chk(id) { var e = document.getElementById(id); return !!(e && e.checked); }

// ---- sections tab ----
function adminSections() {
  var secs = (S.data.sections || []).slice().sort(function (a, b) { return a.position - b.position || a.id - b.id; });
  var rows = secs.map(function (s) {
    var sectionItems = (S.data.items || []).filter(function (i) { return i.section_id === s.id; });
    var n = sectionItems.length;
    var cover = sectionItems.filter(function (i) { return i.image_url; })[0];
    return '<article class="admin-menu-tile">' +
      '<button class="admin-menu-photo" onclick="showSectionItems(' + s.id + ')" aria-label="Open ' + esc(localizedLabel(s.name)) + ' items">' +
        (cover ? '<img src="' + esc(cover.image_url) + '" alt="' + esc(localizedLabel(s.name)) + '">' : '<span aria-hidden="true">🗂️</span>') +
        '<span class="admin-open-label">' + tr('viewSectionItems') + ' →</span>' +
      '</button>' +
      '<div class="admin-menu-info" onclick="showSectionItems(' + s.id + ')"><div class="admin-menu-name">' + esc(localizedLabel(s.name)) + '</div>' +
        '<div class="admin-menu-meta"><span>' + n + ' ' + (n === 1 ? tr('itemSingular') : tr('itemsPlural')) + '</span>' +
          '<span class="tag ' + (s.active ? 'on' : 'off') + '">' + (s.active ? tr('active') : tr('hidden')) + '</span></div>' +
        '<div class="admin-menu-meta"><span>' + (s.kitchen_station ? '🍳 ' + esc(s.kitchen_station) : 'Unassigned') + '</span></div>' +
      '</div><div class="admin-menu-actions">' +
        '<button class="btn small" aria-label="Move up" onclick="moveSection(' + s.id + ',-1)">↑</button>' +
        '<button class="btn small" aria-label="Move down" onclick="moveSection(' + s.id + ',1)">↓</button>' +
        '<button class="btn small" onclick="event.stopPropagation();sectionDlg(' + s.id + ')">✎ ' + tr('editSection') + '</button>' +
        '<button class="btn small danger" onclick="event.stopPropagation();deleteSection(' + s.id + ')">🗑</button>' +
      '</div></article>';
  }).join('');
  return '<div class="fabrow"><button class="btn primary" onclick="sectionDlg(0,0)">＋ ' + tr('newSection') + '</button></div>' +
    '<div class="admin-menu-grid">' + (rows || '<div class="empty">' + tr('noSections') + '</div>') + '</div>';
}
function showSectionItems(id) {
  S.adminItemFilter = id;
  S.adminSearch = '';
  S.adminTab = 'items';
  render();
}
async function sectionDlg(id) {
  var s = id ? (S.data.sections || []).filter(function (x) { return x.id === id; })[0] : { name: '' };
  dlg('<h2>' + (id ? tr('renameSection') : tr('newSection')) + '</h2>' +
    '<input id="f-s-name" class="in" value="' + esc(localizedLabel(s.name)) + '" placeholder="' + tr('sectionPlaceholder') + '">' +
    '<label class="f">Kitchen station</label><input id="f-s-station" class="in" value="' + esc(s.kitchen_station || '') + '" placeholder="Pizza, Chicken, Grill…">' +
    '<label class="f"><input type="checkbox" id="f-s-active"' + (s.active !== 0 ? ' checked' : '') + '> ' + tr('activeOnWaiter') + '</label>' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') + '</button>' +
    '<button class="btn primary" onclick="saveSection(' + (id || 0) + ')">' + tr('save') + '</button></div>');
  var el = document.getElementById('f-s-name'); if (el) el.focus();
}
async function saveSection(id) {
  var name = sourceLabel(val('f-s-name'));
  if (!name) { toast(tr('nameRequired')); return; }
  try {
    var body = { name: name, kitchen_station: val('f-s-station'), active: chk('f-s-active') ? 1 : 0 };
    if (id) await api('/api/sections/' + id, 'PUT', body);
    else await api('/api/sections', 'POST', body);
    closeDlg(); toast(tr('saved')); poll();
  } catch (e) { toast(e.code ? e.message : tr('needConnection')); }
}
async function moveSection(id, dir) {
  var secs = (S.data.sections || []).slice().sort(function (a, b) { return a.position - b.position || a.id - b.id; });
  var idx = -1;
  secs.forEach(function (s, i) { if (s.id === id) idx = i; });
  var j = idx + dir;
  if (idx < 0 || j < 0 || j >= secs.length) return;
  try {
    await api('/api/sections/' + secs[idx].id, 'PUT', { position: secs[j].position });
    await api('/api/sections/' + secs[j].id, 'PUT', { position: secs[idx].position });
    poll();
  } catch (e) { toast(e.code ? e.message : tr('needConnection')); }
}
function toggleSection(id, v) {
  api('/api/sections/' + id, 'PUT', { active: v })
    .then(function () { poll(); })
    .catch(function (e) { toast(e.code ? e.message : tr('needConnection')); });
}
function deleteSection(id) {
  var s = (S.data.sections || []).filter(function (x) { return x.id === id; })[0];
  var n = (S.data.items || []).filter(function (i) { return i.section_id === id; }).length;
  dlg('<h2>' + tr('deleteQuestion') + esc(s ? localizedLabel(s.name) : '') + tr('deleteSuffix') + '</h2>' +
    (n ? '<p class="dim">' + tr('hasItems') + n + tr('moveOrDelete') + '</p>' : '<p class="dim">' + tr('cannotUndo') + '</p>') +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('keep') + '</button>' +
    '<button class="btn danger" onclick="doDeleteSection(' + id + ')">' + tr('delete') + '</button></div>');
}
async function doDeleteSection(id) {
  try { await api('/api/sections/' + id, 'DELETE'); closeDlg(); toast(tr('deleted')); poll(); }
  catch (e) { closeDlg(); toast(e.message); }
}

// ---- catalog items tab ----
async function loadCatalogEditor() {
  var key = S.branchId;
  if (S.catalogLoadedFor === key) return;
  try {
    var products = await api('/api/products');
    var groups = await api('/api/modifier-groups');
    S.catalogProducts = products.products || [];
    S.catalogGroups = groups.modifier_groups || [];
    S.catalogLoadedFor = key;
    render();
  } catch (e) {
    toast(e.message || tr('needConnection'));
  }
}

function sectionName(id) {
  var s = (S.data.sections || []).filter(function (x) { return x.id === id; })[0];
  return s ? localizedLabel(s.name) : '?';
}

function adminItems() {
  if (S.catalogLoadedFor !== S.branchId) {
    loadCatalogEditor();
    return '<div class="loading">' + tr('loading') + '</div>';
  }
  var q = S.adminSearch.trim().toLowerCase();
  var sections = (S.data.sections || []).slice().sort(function (a, b) {
    return (a.position || 0) - (b.position || 0) || a.id - b.id;
  });
  var filtered = S.catalogProducts.filter(function (p) {
    if (S.adminItemFilter && p.section_id !== S.adminItemFilter) return false;
    return !q || (localizedLabel(p.name) + ' ' + p.name).toLowerCase().indexOf(q) >= 0;
  });
  if (S.adminProductId && !S.catalogProducts.some(function (p) { return p.id === S.adminProductId; })) {
    S.adminProductId = null;
  }
  var sectionHtml = sections.map(function (s) {
    var count = S.catalogProducts.filter(function (p) {
      return p.section_id === s.id && p.deleted_at == null;
    }).length;
    return '<button class="catalog-pane-item ' + (S.adminItemFilter === s.id ? 'on' : '') +
      '" onclick="setCatalogSection(' + s.id + ')"><span>' + esc(localizedLabel(s.name)) + '</span><span class="tag">' + count + '</span></button>';
  }).join('');
  var productHtml = filtered.map(function (p) {
    var defaultVariant = (p.variants || []).filter(function (v) { return v.is_default; })[0] ||
      (p.variants || [])[0];
    return '<button class="catalog-pane-item ' + (S.adminProductId === p.id ? 'on' : '') +
      '" onclick="selectCatalogProduct(' + p.id + ')"><span>' +
      esc(localizedLabel(p.name)) + '</span><span class="dim">' +
      (defaultVariant ? money(defaultVariant.price_cents / 100) : '') + '</span></button>';
  }).join('');
  var product = S.catalogProducts.filter(function (p) { return p.id === S.adminProductId; })[0] || null;
  var editor = catalogProductEditor(product);
  return '<div class="searchrow"><input id="f-catalog-search" class="in" placeholder="' +
    tr('searchItems') + '" value="' + esc(S.adminSearch) +
    '" oninput="setAdminSearch(this.value)">' +
    '<button class="btn primary" onclick="selectCatalogProduct(0)">＋ ' + tr('newItem') + '</button></div>' +
    '<div class="catalog-editor"><aside class="catalog-pane catalog-sections"><h3>' +
    tr('sections') + '</h3><button class="catalog-pane-item ' + (!S.adminItemFilter ? 'on' : '') +
    '" onclick="setCatalogSection(0)"><span>' + tr('allSections') + '</span></button>' +
    sectionHtml + '</aside><aside class="catalog-pane catalog-products"><h3>' +
    tr('menuTab') + '</h3><div>' + (productHtml || '<div class="empty">' + tr('noItemsMatch') + '</div>') +
    '</div></aside><section class="catalog-pane catalog-product-editor">' +
    editor + '</section></div>';
}

function setCatalogSection(id) {
  S.adminItemFilter = parseInt(id) || 0;
  S.adminProductId = null;
  render();
}

function selectCatalogProduct(id) {
  S.adminProductId = id ? parseInt(id) : 0;
  render();
}

function setAdminSearch(v) { S.adminSearch = v; render(); }

function catalogVariantRows(product) {
  var variants = product ? (product.variants || []) : [{
    id: null, name: 'Regular', price_cents: 0, stock_qty: null,
    is_default: 1, sort_order: 0, active: 1
  }];
  return variants.map(function (v, index) {
    return '<div class="catalog-variant-row" data-variant-id="' + (v.id || '') + '">' +
      '<input class="in catalog-v-name" value="' + esc(v.name || '') + '" placeholder="Name">' +
      '<input class="in catalog-v-price" type="number" min="0" step="0.01" inputmode="decimal" value="' +
      ((v.price_cents || 0) / 100).toFixed(2) + '" placeholder="Price">' +
      '<input class="in catalog-v-stock" type="number" min="0" step="1" value="' +
      (v.stock_qty == null ? '' : v.stock_qty) + '" placeholder="Stock">' +
      '<label title="Default"><input class="catalog-v-default" type="radio" name="catalog-default"' +
      (v.is_default ? ' checked' : '') + '></label>' +
      '<button type="button" class="btn small danger" onclick="removeCatalogVariant(this)">×</button>' +
      '</div>';
  }).join('');
}

function catalogProductEditor(product) {
  if (S.adminProductId === 0 || (!S.adminProductId && !product)) {
    product = {
      id: null, section_id: S.adminItemFilter || (S.data.sections[0] || {}).id || 0,
      name: '', description: '', image_path: '', active: 1,
      variants: [{ id: null, name: 'Regular', price_cents: 0, stock_qty: null,
        is_default: 1, sort_order: 0, active: 1 }],
      modifier_groups: []
    };
  }
  if (!product) {
    return '<div class="empty">Select a product or create a new one.</div>';
  }
  var sectionOptions = (S.data.sections || []).map(function (s) {
    return '<option value="' + s.id + '"' + (product.section_id === s.id ? ' selected' : '') +
      '>' + esc(localizedLabel(s.name)) + '</option>';
  }).join('');
  var attached = {};
  (product.modifier_groups || []).forEach(function (g) {
    attached[g.modifier_group_id] = g;
  });
  var groupOptions = S.catalogGroups.map(function (g) {
    var attachment = attached[g.id];
    return '<label class="catalog-group-option"><input type="checkbox" value="' + g.id + '"' +
      (attachment ? ' checked' : '') + '> ' + esc(g.name) +
      '<span class="dim">' + (g.selection_type === 'single' ? 'choose 1' : 'up to ' + g.max_select) +
      '</span><input class="in catalog-group-min" data-group-id="' + g.id +
      '" type="number" min="0" value="' + (attachment && attachment.override_min != null ?
        attachment.override_min : g.min_select) + '" title="Min">' +
      '<input class="in catalog-group-max" data-group-id="' + g.id +
      '" type="number" min="0" value="' + (attachment && attachment.override_max != null ?
        attachment.override_max : g.max_select) + '" title="Max"></label>';
  }).join('');
  return '<h3>' + (product.id ? 'Edit product' : 'New product') + '</h3>' +
    '<div id="catalog-product-error" class="error-text"></div>' +
    '<label class="f">Name</label><input id="catalog-p-name" class="in" value="' +
    esc(localizedLabel(product.name || '')) + '">' +
    '<label class="f">Section</label><select id="catalog-p-section" class="in">' + sectionOptions + '</select>' +
    '<label class="f">Description</label><textarea id="catalog-p-description" class="in" rows="3">' +
    esc(product.description || '') + '</textarea>' +
    '<label class="f">Image</label>' + (product.image_path ?
      '<img class="admin-image" src="' + esc(product.image_path) + '" alt="">' : '') +
    '<input id="catalog-p-image" class="in" type="file" accept="image/png,image/jpeg,image/webp">' +
    '<label class="f"><input id="catalog-p-active" type="checkbox"' +
    (product.active ? ' checked' : '') + '> Active</label>' +
    '<h3 class="catalog-subhead">Variants</h3><div id="catalog-variants">' +
    catalogVariantRows(product) + '</div>' +
    '<button type="button" class="btn small" onclick="addCatalogVariant()">＋ Add variant</button>' +
    '<h3 class="catalog-subhead">Modifier groups</h3><div class="catalog-groups">' +
    (groupOptions || '<div class="dim">No modifier groups.</div>') + '</div>' +
    '<div class="dlg-foot">' +
    (product.id ? '<button class="btn danger" onclick="deleteCatalogProduct(' + product.id + ')">Delete</button>' : '') +
    '<button class="btn primary" onclick="saveCatalogProduct(' + (product.id || 0) + ')">Save</button></div>';
}

function addCatalogVariant() {
  var container = document.getElementById('catalog-variants');
  if (!container) return;
  container.insertAdjacentHTML('beforeend',
    '<div class="catalog-variant-row" data-variant-id=""><input class="in catalog-v-name" value="" placeholder="Name">' +
    '<input class="in catalog-v-price" type="number" min="0" step="0.01" value="0" placeholder="Price">' +
    '<input class="in catalog-v-stock" type="number" min="0" step="1" value="" placeholder="Stock">' +
    '<label title="Default"><input class="catalog-v-default" type="radio" name="catalog-default"></label>' +
    '<button type="button" class="btn small danger" onclick="removeCatalogVariant(this)">×</button></div>');
}

function removeCatalogVariant(button) {
  var row = button.closest('.catalog-variant-row');
  if (row) row.remove();
}

function catalogInlineError(message) {
  var el = document.getElementById('catalog-product-error');
  if (el) el.textContent = message;
  toast(message);
}

async function saveCatalogProduct(id) {
  var name = val('catalog-p-name');
  if (!name) { catalogInlineError(tr('nameRequired')); return; }
  var rows = Array.prototype.slice.call(document.querySelectorAll('.catalog-variant-row'));
  if (!rows.length) { catalogInlineError('Product requires at least one variant'); return; }
  var defaults = 0;
  var names = {};
  var variants = rows.map(function (row) {
    var variantName = row.querySelector('.catalog-v-name').value.trim();
    var price = parseFloat(row.querySelector('.catalog-v-price').value);
    var stockText = row.querySelector('.catalog-v-stock').value;
    var isDefault = row.querySelector('.catalog-v-default').checked ? 1 : 0;
    defaults += isDefault;
    names[variantName] = (names[variantName] || 0) + 1;
    return {
      id: row.getAttribute('data-variant-id') ? parseInt(row.getAttribute('data-variant-id')) : null,
      name: variantName,
      price_cents: isFinite(price) ? Math.round(price * 100) : -1,
      stock_qty: stockText === '' ? null : parseInt(stockText, 10),
      is_default: isDefault,
      sort_order: rows.indexOf(row),
      active: 1
    };
  });
  if (defaults !== 1) { catalogInlineError('Exactly one default variant is required'); return; }
  if (variants.some(function (v) { return !v.name || v.price_cents < 0; })) {
    catalogInlineError('Variant names and non-negative prices are required');
    return;
  }
  if (Object.keys(names).some(function (n) { return !n || names[n] > 1; })) {
    catalogInlineError('Variant names must be unique');
    return;
  }
  var modifierGroups = [];
  document.querySelectorAll('.catalog-group-option input[type="checkbox"]:checked').forEach(function (box) {
    var groupId = parseInt(box.value, 10);
    var minInput = document.querySelector('.catalog-group-min[data-group-id="' + groupId + '"]');
    var maxInput = document.querySelector('.catalog-group-max[data-group-id="' + groupId + '"]');
    modifierGroups.push({
      modifier_group_id: groupId,
      override_min: minInput && minInput.value !== '' ? parseInt(minInput.value, 10) : null,
      override_max: maxInput && maxInput.value !== '' ? parseInt(maxInput.value, 10) : null,
      sort_order: modifierGroups.length
    });
  });
  var body = {
    name: sourceLabel(name),
    section_id: parseInt(val('catalog-p-section'), 10),
    description: val('catalog-p-description'),
    active: chk('catalog-p-active') ? 1 : 0,
    variants: variants,
    modifier_groups: modifierGroups
  };
  try {
    var productId = id;
    if (id) await api('/api/products/' + id, 'PATCH', body);
    else productId = (await api('/api/products', 'POST', body)).product_id;
    var file = document.getElementById('catalog-p-image').files[0];
    if (file) {
      if (file.size > 2000000) throw new Error('Image size must be at most 2 MB');
      var dataUrl = await new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(new Error('Could not read image')); };
        reader.readAsDataURL(file);
      });
      await api('/api/products/' + productId + '/image', 'PUT', {
        mime: file.type, data: String(dataUrl).split(',')[1]
      });
    }
    S.catalogLoadedFor = null;
    S.adminProductId = productId;
    await loadCatalogEditor();
    toast(tr('saved'));
  } catch (e) {
    catalogInlineError(e.code ? e.message : (e.message || tr('needConnection')));
  }
}

function deleteCatalogProduct(id) {
  dlg('<h2>' + tr('deleteQuestion') + '</h2><p class="dim">' + tr('pastTicketsKept') + '</p>' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('keep') +
    '</button><button class="btn danger" onclick="doDeleteCatalogProduct(' + id + ')">' +
    tr('delete') + '</button></div>');
}

async function doDeleteCatalogProduct(id) {
  try {
    await api('/api/products/' + id, 'DELETE');
    closeDlg();
    S.catalogLoadedFor = null;
    S.adminProductId = null;
    await loadCatalogEditor();
    toast(tr('deleted'));
  } catch (e) {
    closeDlg();
    toast(e.message);
  }
}

// ---- waiters tab ----
function adminWaiters() {
  var rows = (S.data.staff || []).map(function (s) {
    var chips = parseTables(s.tables).map(function (t) { return '<span class="tag">' + t + '</span>'; }).join(' ');
    return '<div class="row">' +
      '<span class="rname grow">' + esc(s.name) + '</span>' +
      '<span class="tag">' + (s.role === 'kitchen' ? '🍳 ' + esc(s.kitchen_station || 'Kitchen') : '🧑‍🍽️ Waiter') + '</span>' +
      '<span class="tag">' + (s.has_pin ? '🔒 Password set' : '⚠ No password') + '</span>' +
      '<span>' + (chips || '<span class="tag">' + tr('noTablesShort') + '</span>') + '</span>' +
      '<span class="tag ' + (s.active ? 'on' : 'off') + '">' + (s.active ? tr('active') : tr('offDuty')) + '</span>' +
      '<button class="btn small" onclick="toggleStaff(' + s.id + ',' + (s.active ? 0 : 1) + ')">' + (s.active ? tr('offDuty') : tr('onDuty')) + '</button>' +
      '<button class="btn small" onclick="waiterDlg(' + s.id + ')">✎</button>' +
      '<button class="btn small danger" onclick="deleteStaff(' + s.id + ')">🗑</button>' +
      '</div>';
  }).join('');
  return '<div class="fabrow"><button class="btn primary" onclick="waiterDlg(0)">＋ ' + tr('newWaiter') + '</button></div>' +
    '<p class="dim" style="margin-top:0">' + tr('tableRanges') + '</p>' +
    '<div class="rows">' + (rows || '<div class="empty">' + tr('noWaitersYet') + '</div>') + '</div>';
}
function waiterDlg(id) {
  var s = id ? (S.data.staff || []).filter(function (x) { return x.id === id; })[0]
             : { name: '', tables: '[]', active: 1, role:'waiter', kitchen_station:'' };
  var tstr = parseTables(s.tables).join(', ');
  dlg('<h2>' + (id ? tr('editWaiter') : tr('newWaiter')) + '</h2>' +
    '<label class="f">' + tr('name') + '</label><input id="f-w-name" class="in" value="' + esc(s.name) + '" placeholder="' + tr('waiterNamePlaceholder') + '">' +
    '<label class="f">Role</label><select id="f-w-role" class="in" onchange="toggleKitchenFields()"><option value="waiter"' + (s.role !== 'kitchen' ? ' selected' : '') + '>Waiter</option><option value="kitchen"' + (s.role === 'kitchen' ? ' selected' : '') + '>Kitchen staff</option></select>' +
    '<div id="f-w-kitchen-fields"' + (s.role === 'kitchen' ? '' : ' style="display:none"') + '><label class="f">Specialty / station</label><input id="f-w-station" class="in" value="' + esc(s.kitchen_station || '') + '" placeholder="Pizza, Chicken, Grill…"></div>' +
    '<label class="f">' + (id ? 'New PIN (leave blank to keep current)' : 'PIN (4–8 digits)') + '</label><input id="f-w-pin" class="in" type="password" inputmode="numeric" autocomplete="new-password" placeholder="••••">' +
    '<label class="f">' + tr('tablesLabel') + '</label>' +
    '<input id="f-w-tables" class="in" value="' + esc(tstr) + '" oninput="tablesPrev()" placeholder="' + tr('tablesPlaceholder') + '" title="Use 1-8 for a range, or 17-18-19-20 or 17, 18, 19, 20 for selected tables.">' +
    '<p class="dim" id="f-t-prev" style="margin:6px 0 0"></p>' +
    '<label class="f"><input type="checkbox" id="f-w-active"' + (s.active ? ' checked' : '') + '> ' + tr('onDutyLabel') + '</label>' +
    '<p id="f-w-error" class="error-text" role="alert"></p>' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') + '</button>' +
    '<button class="btn primary" onclick="saveWaiter(' + (id || 0) + ')">' + tr('save') + '</button></div>');
  tablesPrev();
}
function toggleKitchenFields() { var e=document.getElementById('f-w-kitchen-fields'); if(e)e.style.display=val('f-w-role')==='kitchen'?'':'none'; }
function tablesPrev() {
  var arr = parseTablesText(val('f-w-tables'));
  var el = document.getElementById('f-t-prev');
  if (el) el.textContent = arr.length ? (tr('willSeeTables') + ' ' + arr.join(', ')) : tr('noTablesAssignedYet');
}
function waiterSaveError(message, fieldId) {
  var e = document.getElementById('f-w-error');
  if (e) e.textContent = message;
  var field = fieldId && document.getElementById(fieldId);
  if (field) field.focus();
}
function parseTablesText(str) {
  var out = [];
  String(str || '').split(',').forEach(function (part) {
    part = part.trim();
    if (!part) return;
    var chain = part.split(/\s*-\s*/);
    if (chain.length === 2 && chain.every(function (n) { return /^\d+$/.test(n); })) {
      var a = +chain[0], b = +chain[1], tmp;
      if (a > b) { tmp = a; a = b; b = tmp; }
      if (b - a <= 500) for (var i = a; i <= b; i++) out.push(i);
    } else if (chain.length > 2 && chain.every(function (n) { return /^\d+$/.test(n); })) {
      chain.forEach(function (n) { out.push(+n); });
    } else if (/^\d+$/.test(part)) out.push(+part);
  });
  var uniq = [];
  out.forEach(function (n) { if (uniq.indexOf(n) < 0) uniq.push(n); });
  return uniq.sort(function (x, y) { return x - y; });
}
function validTablesText(str) {
  if (!String(str || '').trim()) return true;
  return String(str).split(',').every(function(part) {
    part = part.trim();
    return /^(\d+)(\s*-\s*\d+)*$/.test(part);
  });
}
async function saveWaiter(id) {
  var name = val('f-w-name');
  if (!name) { waiterSaveError(tr('nameRequired'), 'f-w-name'); return; }
  var tableText = val('f-w-tables');
  if (!validTablesText(tableText)) { waiterSaveError('Use table numbers and ranges like 1-8, 12, 15-17.', 'f-w-tables'); return; }
  var pin = val('f-w-pin');
  if (!id && !/^\d{4,8}$/.test(pin)) { waiterSaveError('Set a 4–8 digit PIN for this new staff member.', 'f-w-pin'); return; }
  if (pin && !/^\d{4,8}$/.test(pin)) { waiterSaveError('PIN must be 4–8 digits.', 'f-w-pin'); return; }
  var role = val('f-w-role');
  var body = { name: name, tables: parseTablesText(val('f-w-tables')), active: chk('f-w-active') ? 1 : 0,
    role: role, kitchen_station: role === 'kitchen' ? val('f-w-station') : '' };
  if (pin) body.pin = pin;
  if (role === 'kitchen' && !body.kitchen_station) { waiterSaveError('Enter a kitchen specialty.', 'f-w-station'); return; }
  try {
    if (id) await api('/api/staff/' + id, 'PUT', body);
    else await api('/api/staff', 'POST', body);
    closeDlg(); toast(tr('saved')); poll();
  } catch (e) { waiterSaveError(e.code ? e.message : tr('needConnection')); }
}
function toggleStaff(id, v) {
  api('/api/staff/' + id, 'PUT', { active: v })
    .then(function () { poll(); })
    .catch(function (e) { toast(e.code ? e.message : tr('needConnection')); });
}
function deleteStaff(id) {
  var s = (S.data.staff || []).filter(function (x) { return x.id === id; })[0];
  dlg('<h2>' + tr('deleteQuestion') + esc(s ? s.name : '') + tr('deleteSuffix') + '</h2>' +
    '<p class="dim">' + tr('pastTicketsStaffKept') + '</p>' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('keep') + '</button>' +
    '<button class="btn danger" onclick="doDeleteStaff(' + id + ')">' + tr('delete') + '</button></div>');
}
async function doDeleteStaff(id) {
  try { await api('/api/staff/' + id, 'DELETE'); closeDlg(); toast(tr('deleted')); poll(); }
  catch (e) { closeDlg(); toast(e.message); }
}

// ---- reservations, payments, reporting, and branches ----
function adminReservations() {
  var rows = (S.data.reservations || []).map(function (r) {
    return '<div class="row"><span class="grow"><b>' + esc(r.guest_name) + '</b> · ' +
      hhmm(r.starts_at) + ' · ' + r.party_size + '</span><span class="tag">' +
      (r.table_no ? tr('table') + ' ' + r.table_no : '—') + '</span><span>' + esc(r.contact || '') +
      '</span><select class="in" style="width:auto" onchange="reservationStatus(' + r.id + ',this.value)">' +
      ['booked','seated','cancelled','no_show'].map(function (st) {
        return '<option value="' + st + '"' + (r.status === st ? ' selected' : '') + '>' +
          esc(tr(st === 'no_show' ? 'noShow' : st)) + '</option>';
      }).join('') + '</select></div>';
  }).join('');
  return '<div class="fabrow"><button class="btn primary" onclick="reservationDlg()">＋ ' +
    tr('newReservation') + '</button></div><div class="rows">' +
    (rows || '<div class="empty">' + tr('noReservations') + '</div>') + '</div>';
}
function reservationDlg() {
  var date = new Date(Date.now() + 3600000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  dlg('<h2>' + tr('newReservation') + '</h2>' +
    '<label class="f">' + tr('guestName') + '</label><input id="f-r-name" class="in">' +
    '<label class="f">' + tr('contact') + '</label><input id="f-r-contact" class="in">' +
    '<label class="f">' + tr('reservationTime') + '</label><input id="f-r-time" class="in" type="datetime-local" value="' + date.toISOString().slice(0,16) + '">' +
    '<label class="f">' + tr('partySize') + '</label><input id="f-r-size" class="in" type="number" min="1" max="50" value="2">' +
    '<label class="f">' + tr('table') + '</label><input id="f-r-table" class="in" type="number" min="1">' +
    '<label class="f">' + tr('reservationNote') + '</label><input id="f-r-note" class="in">' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') + '</button>' +
    '<button class="btn primary" onclick="saveReservation()">' + tr('save') + '</button></div>');
}
async function saveReservation() {
  var date = new Date(val('f-r-time'));
  var body = {
    guest_name: val('f-r-name'), contact: val('f-r-contact'), starts_at: date.getTime() / 1000,
    party_size: parseInt(val('f-r-size'), 10), table_no: val('f-r-table') || null,
    note: val('f-r-note')
  };
  try {
    await api('/api/reservations', 'POST', body);
    closeDlg(); poll(); toast(tr('saved'));
  } catch (e) { toast(e.code ? e.message : tr('needConnection')); }
}
async function reservationStatus(id, status) {
  try { await api('/api/reservations/' + id, 'PUT', { status: status }); poll(); }
  catch (e) { toast(e.code ? e.message : tr('needConnection')); }
}
function adminBranches() {
  var rows = (S.data.branches || []).map(function (b) {
    return '<div class="row"><span class="grow">' + esc(b.name) + '</span>' +
      '<span class="tag">' + (b.id === S.branchId ? tr('branch') : '') + '</span></div>';
  }).join('');
  return '<div class="fabrow"><button class="btn primary" onclick="branchDlg()">＋ ' +
    tr('newBranch') + '</button></div><div class="rows">' + rows + '</div>';
}
function branchDlg() {
  dlg('<h2>' + tr('newBranch') + '</h2><input id="f-b-name" class="in" placeholder="' +
    tr('branch') + '">' +
    '<label class="f"><input id="f-b-copy" type="checkbox" checked> ' + tr('copyMenu') + '</label>' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') + '</button>' +
    '<button class="btn primary" onclick="saveBranch()">' + tr('save') + '</button></div>');
}
async function saveBranch() {
  try {
    await api('/api/branches', 'POST', { name: val('f-b-name'), copy_menu: chk('f-b-copy') });
    closeDlg(); poll(); toast(tr('branchCreated'));
  } catch (e) { toast(e.code ? e.message : tr('needConnection')); }
}
async function loadSales(period) {
  S.salesPeriod = period;
  try {
    S.salesData = await api('/api/sales?period=' + encodeURIComponent(period));
    if (S.adminTab === 'sales') render();
  } catch (e) { toast(e.code ? e.message : tr('needConnection')); }
}
function adminAnalytics() {
  var data = S.salesData;
  var daily = data && data.daily || [];
  var max = daily.reduce(function (n, d) { return Math.max(n, d.revenue); }, 0) || 1;
  var rows = daily.map(function (d) {
    return '<div class="row"><span class="grow">' + esc(d.day) + '</span><span class="chartbar" style="width:' +
      Math.max(2, Math.round(d.revenue / max * 100)) + '%"></span><b>' + money(d.revenue) + '</b></div>';
  }).join('');
  var top = data && data.top_items || [];
  return '<div class="searchrow"><label class="f">' + tr('analyticsPeriod') +
    '</label><select class="in" style="width:auto" onchange="loadSales(this.value)">' +
    ['7d','30d','90d'].map(function (p) { return '<option value="' + p + '"' +
      ((S.salesPeriod || '7d') === p ? ' selected' : '') + '>' + p + '</option>'; }).join('') +
    '</select></div><h3>' + tr('revenue') + '</h3><div class="rows">' +
    (rows || '<div class="empty">' + tr('noSales') + '</div>') + '</div><h3>' +
    tr('topItems') + '</h3><div class="rows">' + (top.map(function (i) {
      return '<div class="row"><span class="grow">' + esc(i.name) + '</span><b>' +
        i.quantity + ' × ' + money(i.value) + '</b></div>';
    }).join('') || '<div class="empty">' + tr('noSales') + '</div>') + '</div>';
}
function paymentDlg(orderId) {
  var order = (S.data.orders || []).filter(function (o) { return o.id === orderId; })[0];
  if (!order || order.balance <= 0) return;
  var lines = order.lines.filter(function (l) { return l.status !== 'cancelled'; }).map(function (l) {
    var unpaidQty = Math.max(0, l.qty - Number(l.paid_qty || 0));
    return '<div class="row"><span class="grow">' + l.qty + '× ' + esc(localizedLabel(l.name)) +
      '</span><span>' + money(l.price) + '</span><input class="in pay-split-qty" type="number" min="0" max="' +
      unpaidQty + '" step="1" value="0" data-id="' + l.id + '" data-price="' + l.price +
      '" style="width:82px" aria-label="' + tr('splitItems') + '" onchange="paymentSplitAmount()"' +
      (unpaidQty === 0 ? ' disabled' : '') + '></div>';
  }).join('');
  dlg('<h2>' + tr('recordPayment') + ' · ' + tr('ticket') + ' #' + orderId + '</h2>' +
    '<p class="dim">' + tr('balance') + ': ' + money(order.balance) + '</p><label class="f">' +
    tr('amount') + '</label><input id="f-p-amount" class="in" type="number" min="0.01" max="' +
    order.balance + '" step="0.01" value="' + order.balance + '">' +
    '<label class="f">' + tr('method') + '</label><select id="f-p-method" class="in">' +
    ['cash','card','other'].map(function (m) { return '<option value="' + m + '">' + tr(m) + '</option>'; }).join('') +
    '</select><h3>' + tr('splitItems') + '</h3><div class="rows">' + lines + '</div>' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') + '</button>' +
    '<button class="btn primary" onclick="savePayment(' + orderId + ')">' + tr('save') + '</button></div>');
}
function paymentSplitAmount() {
  var inputs = Array.prototype.slice.call(document.querySelectorAll('.pay-split-qty'));
  var selected = inputs.filter(function (el) { return Number(el.value) > 0; });
  if (!selected.length) return;
  var amount = selected.reduce(function (n, el) { return n + Number(el.dataset.price) * Number(el.value); }, 0);
  document.getElementById('f-p-amount').value = amount.toFixed(2);
}
function refundDlg(paymentId, remaining) {
  dlg('<h2>' + tr('refund') + '</h2><label class="f">' + tr('refundAmount') +
    '</label><input id="f-refund-amount" class="in" type="number" min="0.01" max="' +
    remaining + '" step="0.01" value="' + remaining.toFixed(2) + '">' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') + '</button>' +
    '<button class="btn danger" onclick="saveRefund(' + paymentId + ')">' + tr('refund') + '</button></div>');
}
async function saveRefund(paymentId) {
  try {
    await api('/api/payments/' + paymentId + '/refund', 'POST', {
      amount: Number(val('f-refund-amount'))
    });
    closeDlg(); poll(); toast(tr('paymentRefunded'));
  } catch (e) { toast(e.code ? e.message : tr('needConnection')); }
}
async function savePayment(orderId) {
  var inputs = Array.prototype.slice.call(document.querySelectorAll('.pay-split-qty'));
  var allocations = inputs.filter(function (el) { return Number(el.value) > 0; }).map(function (el) {
    return { line_id: Number(el.dataset.id), qty: Number(el.value) };
  });
  try {
    await api('/api/orders/' + orderId + '/payments', 'POST', {
      amount: Number(val('f-p-amount')), method: val('f-p-method'), allocations: allocations
    });
    closeDlg(); poll(); toast(tr('saved'));
  } catch (e) { toast(e.code ? e.message : tr('needConnection')); }
}

// ---- orders tab ----
function adminOrders() {
  var orders = (S.data.orders || []).slice().sort(function (a, b) { return b.created_at - a.created_at; });
  var rows = orders.map(function (o) {
    var n = o.lines.filter(function (l) { return l.status !== 'cancelled'; }).length;
    var payments = (o.payments || []).map(function (p) {
      var remaining = Number((p.amount - p.refunded_amount).toFixed(2));
      return '<div class="row"><span class="grow">' + tr(p.method) + ' · ' +
        money(p.amount - p.refunded_amount) + '</span>' +
        (remaining > 0 ? '<button class="btn small danger" onclick="refundDlg(' + p.id + ',' +
          remaining + ')">' + tr('refund') + '</button>' : '') + '</div>';
    }).join('');
    return '<div class="row">' +
      '<span>' + tr('ticket') + ' <b>#' + o.id + '</b> ' + hhmm(o.created_at) + '</span>' +
      '<span class="tag">' + tr('table') + ' ' + o.table_no + '</span>' +
      '<span class="grow">' + esc(o.staff_name || '') + ' · ' + n + ' ' + (n === 1 ? tr('itemSingular') : tr('itemsPlural')) +
        (o.cancel_reason ? ' · <span style="color:#fca5a5">' + esc(o.cancel_reason) + '</span>' : '') + '</span>' +
      '<span class="bigprice">' + money(o.total) + '</span>' +
      '<span class="tag">' + tr('paid') + ': ' + money(o.paid || 0) + ' · ' + tr('balance') + ': ' + money(o.balance || 0) + '</span>' +
      '</div>' + payments + '<div class="row">' +
      (o.bill_requested ? '<span class="tag on">' + tr('requestBill') + '</span>' : '') +
      '<span class="chip ' + o.status + '">' + tStatus(o.status) + '</span>' +
      (o.balance > 0 && o.status !== 'cancelled'
        ? '<button class="btn small primary" onclick="paymentDlg(' + o.id + ')">' + tr('recordPayment') + '</button>' : '') +
      '<button class="btn small" onclick="printTicket(' + o.id + ')">🖨️ ' + tr('print') + '</button>' +
      (o.status !== 'served' && o.status !== 'cancelled'
        ? '<button class="btn small danger" onclick="cancelOrderDlg(' + o.id + ')">✕</button>' : '') +
      '</div>';
  }).join('');
  return '<p class="dim" style="margin-top:0">' + tr('orderHistory') + '</p>' +
    '<div class="rows">' + (rows || '<div class="empty">' + tr('noOrders') + '</div>') + '</div>';
}

// ---- settings tab ----
function adminSettings() {
  var st = S.data.settings || {};
  return '<div style="max-width:560px">' +
    '<h3>' + tr('restaurant') + '</h3>' +
    '<label class="f">' + tr('printedName') + '</label><input id="f-s-name" class="in" value="' + esc(st.restaurant_name || '') + '">' +
    '<label class="f">' + tr('currency') + '</label><input id="f-s-cur" class="in" value="' + esc(st.currency || 'MAD') + '" maxlength="4">' +
    '<h3 style="margin-top:26px">' + tr('ticketPrinter') + '</h3>' +
    '<p class="dim">' + tr('printerHelp') + '</p>' +
    '<label class="f">' + tr('printerIp') + '</label><input id="f-s-ip" class="in" value="' + esc(st.printer_ip || '') + '" placeholder="' + tr('printerIpPlaceholder') + '">' +
    '<label class="f">' + tr('printerPort') + '</label><input id="f-s-port" class="in" type="number" value="' + esc(st.printer_port || 9100) + '">' +
    '<label class="f"><input type="checkbox" id="f-s-auto"' + (st.autoprint ? ' checked' : '') + '> ' + tr('autoPrint') + '</label>' +
    '<div class="dlg-foot" style="justify-content:flex-start"><button class="btn primary" onclick="saveSettings()">' + tr('saveSettings') + '</button></div>' +
    '<h3 style="margin-top:26px">' + tr('security') + '</h3>' +
    '<label class="f">' + tr('newAdminPin') + '</label>' +
    '<div class="searchrow"><input id="f-s-pin" class="in" type="password" inputmode="numeric" placeholder="' + tr('newPinPlaceholder') + '">' +
    '<button class="btn" style="flex:0 0 auto" onclick="changePin()">' + tr('changePin') + '</button></div>' +
    '<h3 style="margin-top:26px">' + tr('data') + '</h3>' +
    '<p class="dim">' + tr('localDataHelp') + ' ' +
    tr('serverAddressLabel') + ' <b>' + esc(window.location.host) + '</b></p>' +
    '<button class="btn" onclick="exportData()">' + tr('exportData') + '</button>' +
    '</div>';
}
async function saveSettings() {
  var body = {
    restaurant_name: val('f-s-name') || 'My Restaurant',
    currency: val('f-s-cur') || 'MAD',
    printer_ip: val('f-s-ip'),
    printer_port: parseInt(val('f-s-port') || '9100') || 9100,
    autoprint: chk('f-s-auto')
  };
  try { await api('/api/settings', 'PUT', body); toast(tr('settingsSaved')); poll(); }
  catch (e) { toast(e.code ? e.message : tr('needConnection')); }
}
async function changePin() {
  var p = val('f-s-pin');
  if (!/^\d{4,}$/.test(p)) { toast(tr('pinMin')); return; }
  try {
    await api('/api/settings', 'PUT', { admin_pin: p });
    S.adminPin = p; sessionStorage.setItem('ro_adminpin', p);
    toast(tr('pinChanged')); render();
  } catch (e) { toast(e.code ? e.message : tr('needConnection')); }
}
function exportData() {
  api('/api/export').then(function (j) {
    var blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'restaurant-export.json';
    document.body.appendChild(a); a.click(); a.remove();
    toast(tr('exportDownloaded'));
  }).catch(function (e) { toast(tr('exportFailed') + e.message); });
}

// ================= BOOT =================
function boot() {
  loadLS();
  window.addEventListener('online', function () { S.online = true; renderConn(); poll(); });
  window.addEventListener('offline', function () { S.online = false; renderConn(); });
  setInterval(function () { if (S.role === 'kitchen' && S.data) render(); }, 20000); // refresh ticket timers
  if (S.role) startPoll();
  render();
}
document.addEventListener('DOMContentLoaded', boot);
