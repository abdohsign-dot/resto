'use strict';
/* ============================================================
   Kitchen display (KDS) + Admin area
   ============================================================ */

// ================= KITCHEN =================
function renderKitchen(app) {
  var orders = (S.data.orders || []).map(function(o) {
    if (!S.kitchenStation) return o;
    var copy = Object.assign({}, o);
    copy.lines = (o.lines || []).filter(function(l){
      return (l.kitchen_station || '').trim().toLowerCase() === (S.kitchenStation || '').trim().toLowerCase();
    });
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
    ['sections', '🗂 ' + tr('sections')], ['items', '🍽 ' + tr('menuTab')],
    ['kitchen', '👨‍🍳 ' + tr('kitchenConfig')],
    ['waiters', '🧑‍🤝‍🧑 ' + tr('waiters')],
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
  else if (S.adminTab === 'kitchen') body = adminKitchen();
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
  if (S.catalogLoadedFor !== S.branchId) {
    loadCatalogEditor();
    return '<div class="loading">' + tr('loading') + '</div>';
  }
  var secs = (S.data.sections || []).slice().sort(function (a, b) { return a.position - b.position || a.id - b.id; });
  var rows = secs.map(function (s) {
    var sectionItems = S.catalogProducts.filter(function (i) {
      return i.section_id === s.id && i.deleted_at == null;
    });
    var n = sectionItems.length;
    return '<article class="admin-menu-tile">' +
      '<button class="admin-menu-photo" onclick="showSectionItems(' + s.id + ')" aria-label="Open ' + esc(localizedLabel(s.name)) + ' items">' +
        (s.image_path ? '<img src="' + esc(s.image_path) + '" alt="' + esc(localizedLabel(s.name)) + '">' : '<span aria-hidden="true">🗂️</span>') +
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
    '<label class="f">' + tr('image') + '</label>' +
    (s.image_path ? '<img class="admin-image" src="' + esc(s.image_path) + '" alt="">' : '') +
    '<input id="f-s-image" class="in" type="file" accept="image/png,image/jpeg,image/webp">' +
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
    var sectionId = id;
    if (id) await api('/api/sections/' + id, 'PUT', body);
    else sectionId = (await api('/api/sections', 'POST', body)).section_id;
    var file = document.getElementById('f-s-image').files[0];
    if (file) await uploadCatalogImage(file, '/api/sections/' + sectionId + '/image');
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

async function uploadCatalogImage(file, endpoint) {
  if (file.size > 2000000) throw new Error('Image size must be at most 2 MB');
  var dataUrl = await new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = function () { reject(new Error('Could not read image')); };
    reader.readAsDataURL(file);
  });
  return api(endpoint, 'PUT', {
    mime: file.type, data: String(dataUrl).split(',')[1]
  });
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

function adminCatalogPath(product) {
  var names = [], current = product, guard = 0;
  while (current && guard++ < 100) {
    names.unshift(localizedLabel(current.name));
    current = current.parent_id == null ? null : S.catalogProducts.filter(function (p) {
      return p.id === current.parent_id;
    })[0];
  }
  return names.join(' › ');
}

function adminItems() {
  if (S.catalogLoadedFor !== S.branchId) {
    loadCatalogEditor();
    return '<div class="loading">' + tr('loading') + '</div>';
  }
  var sections = (S.data.sections || []).slice().sort(function (a, b) {
    return (a.position || 0) - (b.position || 0) || a.id - b.id;
  });
  var allProducts = S.catalogProducts.filter(function (p) { return p.deleted_at == null; });
  if (S.adminProductId && !allProducts.some(function (p) { return p.id === S.adminProductId; })) {
    S.adminProductId = null;
  }
  var sectionHtml = sections.map(function (s) {
    var count = allProducts.filter(function (p) {
      return p.section_id === s.id && p.deleted_at == null;
    }).length;
    return '<button class="catalog-root-item ' + (S.adminItemFilter === s.id ? 'on' : '') +
      '" onclick="setCatalogSection(' + s.id + ')">' +
      (s.image_path ? '<img src="' + esc(s.image_path) + '" alt="">' : '<span>🗂️</span>') +
      '<span>' + esc(localizedLabel(s.name)) + '</span><span class="tag">' + count + '</span></button>';
  }).join('');
  var section = sections.filter(function (s) { return s.id === S.adminItemFilter; })[0] || null;
  var path = (S.adminNodePath || []).map(function (id) {
    return allProducts.filter(function (p) { return p.id === id; })[0];
  }).filter(Boolean);
  if (!section || path.some(function (p) { return p.section_id !== section.id; })) {
    path = [];
    S.adminNodePath = [];
  }
  var query = S.adminSearch.trim().toLowerCase();
  var currentParent = path.length ? path[path.length - 1] : null;
  var nodes = allProducts.filter(function (p) {
    if (query) return (localizedLabel(p.name) + ' ' + p.name + ' ' + adminCatalogPath(p))
      .toLowerCase().indexOf(query) >= 0;
    return section && p.section_id === section.id &&
      p.parent_id === (currentParent ? currentParent.id : null);
  });
  var nodeHtml = nodes.map(function (p) {
    var children = allProducts.filter(function (child) { return child.parent_id === p.id; }).length;
    var variants = (p.variants || []).filter(function (v) { return v.active; });
    var prices = variants.map(function (v) { return v.price_cents || 0; });
    var price = prices.length ? money(Math.min.apply(Math, prices) / 100) : '';
    var open = p.kind === 'group' ? 'openAdminGroup(' + p.id + ')' : 'selectCatalogProduct(' + p.id + ')';
    return '<article class="admin-tree-card ' + (S.adminProductId === p.id ? 'on' : '') + '">' +
      '<button class="admin-tree-photo" onclick="' + open + '">' +
      (p.image_path ? '<img src="' + esc(p.image_path) + '" alt="">' :
        '<span aria-hidden="true">' + (p.kind === 'group' ? '📁' : '🍽️') + '</span>') +
      '</button><div class="admin-tree-info"><b>' + esc(localizedLabel(p.name)) + '</b>' +
      '<span class="dim">' + (p.kind === 'group' ? children + ' ' + tr('childCount') : price) + '</span>' +
      '<button class="btn small" onclick="selectCatalogProduct(' + p.id + ')">' + tr('editItem') + '</button>' +
      '</div></article>';
  }).join('');
  var breadcrumbs = '<button class="btn small" onclick="adminNodeDepth(0)">' +
    (section ? esc(localizedLabel(section.name)) : tr('allSections')) + '</button>';
  path.forEach(function (node, index) {
    breadcrumbs += '<span class="crumb-sep">›</span><button class="btn small" onclick="adminNodeDepth(' +
      (index + 1) + ')">' + esc(localizedLabel(node.name)) + '</button>';
  });
  var product = allProducts.filter(function (p) { return p.id === S.adminProductId; })[0] || null;
  var editor = catalogProductEditor(product);
  return '<div class="searchrow"><input id="f-catalog-search" class="in" placeholder="' +
    tr('searchItems') + '" value="' + esc(S.adminSearch) +
    '" oninput="setAdminSearch(this.value)"></div>' +
    '<div class="catalog-editor"><aside class="catalog-pane catalog-sections"><h3>' +
    tr('sections') + '</h3><button class="catalog-pane-item ' + (!S.adminItemFilter ? 'on' : '') +
    '" onclick="setCatalogSection(0)"><span>' + tr('allSections') + '</span></button>' +
    sectionHtml + '</aside><section class="catalog-pane catalog-products"><div class="catalog-tree-head">' +
    '<h3>' + tr('menuTab') + '</h3><div class="menu-breadcrumb">' + breadcrumbs + '</div>' +
    (section ? '<div class="catalog-tree-actions"><button class="btn small" onclick="newCatalogNode(\'group\')">' +
      tr('addSubSection') + '</button><button class="btn small primary" onclick="newCatalogNode(\'item\')">' +
      tr('addDish') + '</button></div>' : '') + '</div>' +
    '<div class="admin-tree-grid">' + (nodeHtml || '<div class="empty">' +
      (query ? tr('noItemsMatch') : (section ? tr('noChildren') : tr('allSections'))) + '</div>') +
    '</div></section><section class="catalog-pane catalog-product-editor">' +
    editor + '</section></div>';
}

function setCatalogSection(id) {
  S.adminItemFilter = parseInt(id) || 0;
  S.adminNodePath = [];
  S.adminProductId = null;
  render();
}

function selectCatalogProduct(id) {
  S.adminProductId = id ? parseInt(id) : 0;
  if (!id) S.adminCreatingKind = 'item';
  render();
}

function setAdminSearch(v) { S.adminSearch = v; render(); }
function openAdminGroup(id) {
  S.adminNodePath.push(parseInt(id, 10));
  S.adminProductId = null;
  S.adminSearch = '';
  render();
}
function adminNodeDepth(depth) {
  S.adminNodePath = (S.adminNodePath || []).slice(0, depth);
  S.adminProductId = null;
  S.adminSearch = '';
  render();
}
function newCatalogNode(kind) {
  S.adminCreatingKind = kind;
  S.adminProductId = 0;
  render();
}

function catalogVariantRows(product) {
  var variants = product ? (product.variants || []) : [{
    id: null, name: 'Regular', price_cents: 0, stock_qty: null,
    is_default: 1, sort_order: 0, active: 1
  }];
  return variants.map(function (v) {
    return '<div class="catalog-variant-row" data-variant-id="' + (v.id || '') + '">' +
      '<input class="in catalog-v-name" value="' + esc(v.name || '') + '" placeholder="Name">' +
      '<input class="in catalog-v-price" type="number" min="0" step="0.01" inputmode="decimal" value="' +
      ((v.price_cents || 0) / 100).toFixed(2) + '" placeholder="Price">' +
      '<input class="in catalog-v-stock" type="number" min="0" step="1" value="' +
      (v.stock_qty == null ? '' : v.stock_qty) + '" placeholder="Stock">' +
      '<label title="Default"><input class="catalog-v-default" type="radio" name="catalog-default"' +
      (v.is_default ? ' checked' : '') + '></label>' +
      '<label class="catalog-v-active"><input class="catalog-v-enabled" type="checkbox"' +
      (v.active ? ' checked' : '') + '> ' + tr('active') + '</label>' +
      '<div class="catalog-v-image">' + (v.image_path ?
        '<img class="admin-image" src="' + esc(v.image_path) + '" alt="">' : '') +
        '<input class="in catalog-v-file" type="file" accept="image/png,image/jpeg,image/webp"></div>' +
      '<button type="button" class="btn small danger" onclick="removeCatalogVariant(this)">×</button>' +
      '</div>';
  }).join('');
}

function catalogProductEditor(product) {
  if (S.adminProductId === 0 || (!S.adminProductId && !product)) {
    var parent = (S.adminNodePath || []).length ?
      S.catalogProducts.filter(function (p) {
        return p.id === S.adminNodePath[S.adminNodePath.length - 1];
      })[0] : null;
    product = {
      id: null, kind: S.adminCreatingKind || 'item', parent_id: parent ? parent.id : null,
      section_id: parent ? parent.section_id : (S.adminItemFilter || (S.data.sections[0] || {}).id || 0),
      name: '', description: '', image_path: '', active: 1, sort_order: 0,
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
  var folder = product.kind === 'group';
  return '<h3>' + (product.id ? tr('editItem') : (folder ? tr('subSection') : tr('newItem'))) + '</h3>' +
    '<div id="catalog-product-error" class="error-text"></div>' +
    '<label class="f">Name</label><input id="catalog-p-name" class="in" value="' +
    esc(localizedLabel(product.name || '')) + '">' +
    (product.parent_id == null ? '<label class="f">' + tr('section') +
      '</label><select id="catalog-p-section" class="in">' + sectionOptions + '</select>' :
      '<p class="dim">' + esc(adminCatalogPath(product)) + '</p>') +
    (!folder ? '<label class="f">' + tr('description') + '</label><textarea id="catalog-p-description" class="in" rows="3">' +
    esc(product.description || '') + '</textarea>' : '') +
    '<label class="f">' + tr('image') + '</label>' + (product.image_path ?
      '<img class="admin-image" src="' + esc(product.image_path) + '" alt="">' : '') +
    '<input id="catalog-p-image" class="in" type="file" accept="image/png,image/jpeg,image/webp">' +
    '<label class="f"><input id="catalog-p-active" type="checkbox"' +
    (product.active ? ' checked' : '') + '> ' + tr('activeOnWaiter') + '</label>' +
    '<label class="f">' + tr('order') + '</label><input id="catalog-p-order" class="in" type="number" value="' +
      (product.sort_order || 0) + '">' +
    (!folder ? '<h3 class="catalog-subhead">' + tr('sizes') + '</h3><div id="catalog-variants">' +
    catalogVariantRows(product) + '</div>' +
    '<button type="button" class="btn small" onclick="addCatalogVariant()">＋ ' + tr('addSize') + '</button>' +
    '<h3 class="catalog-subhead">' + tr('choices') + '</h3><div id="catalog-choices">' +
    catalogChoiceRows(product) + '</div>' +
    '<button type="button" class="btn small" onclick="addCatalogChoice()">＋ ' + tr('addChoice') + '</button>' : '') +
    '<div class="dlg-foot">' +
    (product.id ? '<button class="btn danger" onclick="deleteCatalogProduct(' + product.id + ')">Delete</button>' : '') +
    '<button class="btn primary" onclick="saveCatalogProduct(' + (product.id || 0) + ')">' + tr('save') + '</button></div>';
}

function catalogOwnedGroup(product) {
  if (!product || !product.id) return null;
  var attachment = (product.modifier_groups || []).filter(function (a) {
    var g = S.catalogGroups.filter(function (x) { return x.id === a.modifier_group_id; })[0];
    return g && g.product_id === product.id;
  })[0];
  if (!attachment) return null;
  return S.catalogGroups.filter(function (g) {
    return g.id === attachment.modifier_group_id;
  })[0] || null;
}

function catalogChoiceRowHtml(index, option) {
  option = option || {};
  return '<div class="catalog-choice-row">' +
    '<span class="catalog-choice-num">' + (index + 1) + '</span>' +
    '<input class="in catalog-c-name" value="' + esc(option.name || '') +
    '" placeholder="' + tr('choiceNamePlaceholder') + '">' +
    '<input class="in catalog-c-price" type="number" min="0" step="0.01" inputmode="decimal" value="' +
    ((option.price_delta_cents || 0) / 100).toFixed(2) + '" placeholder="0.00">' +
    '<button type="button" class="btn small danger" onclick="removeCatalogChoice(this)">×</button>' +
    '</div>';
}

function catalogChoiceRows(product) {
  var group = catalogOwnedGroup(product);
  if (!group) return '';
  return (group.options || []).filter(function (o) { return o.active; }).map(function (o, i) {
    return catalogChoiceRowHtml(i, o);
  }).join('');
}

function addCatalogChoice() {
  var container = document.getElementById('catalog-choices');
  if (!container) return;
  container.insertAdjacentHTML('beforeend', catalogChoiceRowHtml(container.children.length));
}

function removeCatalogChoice(button) {
  var row = button.closest('.catalog-choice-row');
  if (row) row.remove();
  renumberCatalogChoices();
}

function renumberCatalogChoices() {
  var container = document.getElementById('catalog-choices');
  if (!container) return;
  Array.prototype.forEach.call(container.querySelectorAll('.catalog-choice-num'), function (el, i) {
    el.textContent = i + 1;
  });
}

function addCatalogVariant() {
  var container = document.getElementById('catalog-variants');
  if (!container) return;
  container.insertAdjacentHTML('beforeend',
    '<div class="catalog-variant-row" data-variant-id=""><input class="in catalog-v-name" value="" placeholder="Name">' +
    '<input class="in catalog-v-price" type="number" min="0" step="0.01" value="0" placeholder="Price">' +
    '<input class="in catalog-v-stock" type="number" min="0" step="1" value="" placeholder="Stock">' +
    '<label title="Default"><input class="catalog-v-default" type="radio" name="catalog-default"></label>' +
    '<label class="catalog-v-active"><input class="catalog-v-enabled" type="checkbox" checked> ' + tr('active') + '</label>' +
    '<div class="catalog-v-image"><input class="in catalog-v-file" type="file" accept="image/png,image/jpeg,image/webp"></div>' +
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
  var editing = id ? S.catalogProducts.filter(function (p) { return p.id === id; })[0] : null;
  var kind = editing ? editing.kind : (S.adminCreatingKind || 'item');
  var rows = kind === 'group' ? [] :
    Array.prototype.slice.call(document.querySelectorAll('.catalog-variant-row'));
  if (kind === 'item' && !rows.length) { catalogInlineError('Product requires at least one variant'); return; }
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
      active: row.querySelector('.catalog-v-enabled').checked ? 1 : 0
    };
  });
  if (kind === 'item' && defaults !== 1) { catalogInlineError('Exactly one default variant is required'); return; }
  if (kind === 'item' && variants.some(function (v) { return !v.name || v.price_cents < 0; })) {
    catalogInlineError('Variant names and non-negative prices are required');
    return;
  }
  if (kind === 'item' && Object.keys(names).some(function (n) { return !n || names[n] > 1; })) {
    catalogInlineError('Variant names must be unique');
    return;
  }
  var choices = [];
  if (kind === 'item') {
    document.querySelectorAll('.catalog-choice-row').forEach(function (row) {
      var choiceName = row.querySelector('.catalog-c-name').value.trim();
      if (!choiceName) return;
      var choicePrice = parseFloat(row.querySelector('.catalog-c-price').value);
      choices.push({
        name: sourceLabel(choiceName),
        price_cents: isFinite(choicePrice) ? Math.round(choicePrice * 100) : 0
      });
    });
  }
  var modifierGroups = [];
  if (kind === 'item' && editing) {
    (editing.modifier_groups || []).forEach(function (attachment) {
      var group = S.catalogGroups.filter(function (g) {
        return g.id === attachment.modifier_group_id;
      })[0];
      if (group && group.product_id === editing.id) return;
      modifierGroups.push({
        modifier_group_id: attachment.modifier_group_id,
        override_min: attachment.override_min != null ? attachment.override_min : null,
        override_max: attachment.override_max != null ? attachment.override_max : null,
        sort_order: modifierGroups.length
      });
    });
  }
  var body = {
    name: sourceLabel(name),
    kind: kind,
    parent_id: editing ? editing.parent_id : ((S.adminNodePath || []).length ?
      S.adminNodePath[S.adminNodePath.length - 1] : null),
    section_id: parseInt(val('catalog-p-section'), 10) ||
      (editing ? editing.section_id : S.adminItemFilter),
    description: kind === 'item' ? val('catalog-p-description') : '',
    active: chk('catalog-p-active') ? 1 : 0,
    sort_order: parseInt(val('catalog-p-order'), 10) || 0
  };
  if (kind === 'item') {
    body.variants = variants;
    body.modifier_groups = modifierGroups;
    body.choices = choices;
  }
  try {
    var productId = id;
    var saved;
    if (id) saved = await api('/api/products/' + id, 'PATCH', body);
    else saved = await api('/api/products', 'POST', body);
    if (!id) productId = saved.product_id;
    var file = document.getElementById('catalog-p-image').files[0];
    if (file) await uploadCatalogImage(file, '/api/products/' + productId + '/image');
    if (kind === 'item') {
      for (var index = 0; index < (saved.variants || []).length; index++) {
        var variant = saved.variants[index];
        var imageFile = rows[index] && rows[index].querySelector('.catalog-v-file').files[0];
        if (imageFile) await uploadCatalogImage(imageFile, '/api/variants/' + variant.id + '/image');
      }
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

// ================= KITCHEN CONFIG =================
function getKnownKitchenStations() {
  var stations = {};
  (S.data.sections || []).forEach(function (s) {
    var st = (s.kitchen_station || s.name || '').trim();
    if (st) stations[st] = true;
  });
  return Object.keys(stations).sort(function (a, b) { return a.localeCompare(b); });
}

function setKitchenFilter(f) {
  S.adminKitchenStationFilter = f;
  render();
}

function adminKitchen() {
  var stations = getKnownKitchenStations();
  var allStaff = S.data.staff || [];
  var kitchenStaff = allStaff.filter(function (s) {
    return s.role === 'kitchen';
  });
  var sections = S.data.sections || [];

  // Group staff & sections by station for Station Cards
  var staffByStation = {};
  var sectionsByStation = {};
  stations.forEach(function (st) {
    staffByStation[st] = [];
    sectionsByStation[st] = [];
  });
  var unassignedStaff = [];
  var unassignedSections = [];

  kitchenStaff.forEach(function (s) {
    var st = (s.kitchen_station || '').trim().toLowerCase();
    var found = false;
    stations.forEach(function (stationName) {
      if (!found && st === stationName.toLowerCase()) {
        staffByStation[stationName].push(s);
        found = true;
      }
    });
    if (!found) unassignedStaff.push(s);
  });

  sections.forEach(function (sec) {
    var st = (sec.kitchen_station || sec.name || '').trim().toLowerCase();
    var found = false;
    stations.forEach(function (stationName) {
      if (!found && st === stationName.toLowerCase()) {
        sectionsByStation[stationName].push(sec);
        found = true;
      }
    });
    if (!found) unassignedSections.push(sec);
  });

  // Station Cards HTML
  var stationCardsHtml = '';
  if (stations.length === 0) {
    stationCardsHtml = '<div class="empty" style="grid-column:1/-1;">' + tr('noKitchenStationsYet') + '</div>';
  } else {
    stationCardsHtml = stations.map(function (st) {
      var stStaff = staffByStation[st] || [];
      var stSecs = sectionsByStation[st] || [];
      var staffChips = stStaff.length ? stStaff.map(function (s) {
        return '<span class="tag ' + (s.active ? 'on' : 'off') + '" title="' + (s.active ? tr('active') : tr('offDuty')) + '">' +
          '👨‍🍳 ' + esc(s.name) + (s.has_pin ? ' 🔒' : '') + '</span>';
      }).join(' ') : '<span class="dim" style="font-size:12px;">' + tr('noStaffAssigned') + '</span>';

      var secChips = stSecs.length ? stSecs.map(function (sec) {
        return '<span class="tag">🗂 ' + esc(localizedLabel(sec.name)) + '</span>';
      }).join(' ') : '<span class="dim" style="font-size:12px;">' + tr('noSectionsRouted') + '</span>';

      return '<div class="station-card">' +
        '<div class="station-card-head">' +
          '<div class="station-card-title">🍳 ' + esc(st) + '</div>' +
          '<button class="btn small" onclick="assignStaffDlg(\'' + esc(st).replace(/'/g, "\\'") + '\')">＋ ' + tr('assignStaff') + '</button>' +
        '</div>' +
        '<div class="station-card-meta">' +
          '<b>' + tr('assignedStaff') + ' (' + stStaff.length + '):</b>' +
          '<div class="station-card-tags">' + staffChips + '</div>' +
        '</div>' +
        '<div class="station-card-meta">' +
          '<b>' + tr('assignedSections') + ' (' + stSecs.length + '):</b>' +
          '<div class="station-card-tags">' + secChips + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // Filter staff if a station filter is chosen
  var activeFilter = S.adminKitchenStationFilter || '';
  var filteredStaff = kitchenStaff;
  if (activeFilter) {
    if (activeFilter === '__unassigned__') {
      filteredStaff = unassignedStaff;
    } else {
      filteredStaff = kitchenStaff.filter(function (s) { return (s.kitchen_station || '').trim() === activeFilter; });
    }
  }

  // Staff rows
  var staffRows = filteredStaff.map(function (s) {
    var st = (s.kitchen_station || '').trim();
    return '<div class="row">' +
      '<span class="rname grow">👨‍🍳 ' + esc(s.name) + '</span>' +
      '<span class="tag" style="font-weight:700;">' + (st ? '🍳 ' + esc(st) : '<span style="color:#dc2626;">⚠ ' + tr('unassigned') + '</span>') + '</span>' +
      '<button class="btn small" onclick="quickStationDlg(' + s.id + ')" title="' + tr('assignStation') + '">🔄 ' + tr('assignStation') + '</button>' +
      '<span class="tag">' + (s.has_pin ? '🔒 ' + tr('passwordSet') : '⚠ ' + tr('noPassword')) + '</span>' +
      '<span class="tag ' + (s.active ? 'on' : 'off') + '">' + (s.active ? tr('active') : tr('offDuty')) + '</span>' +
      '<button class="btn small" onclick="toggleStaff(' + s.id + ',' + (s.active ? 0 : 1) + ')">' + (s.active ? tr('offDuty') : tr('onDuty')) + '</button>' +
      '<button class="btn small" onclick="kitchenStaffDlg(' + s.id + ')" title="' + tr('edit') + '">✎</button>' +
      '<button class="btn small danger" onclick="deleteStaff(' + s.id + ')" title="' + tr('delete') + '">🗑</button>' +
      '</div>';
  }).join('');

  // Station filter chips
  var filterChips = '<div class="chips searchrow" style="overflow-x:auto;padding-bottom:4px;margin-bottom:12px;">' +
    '<button class="btn small ' + (!activeFilter ? 'on' : '') + '" onclick="setKitchenFilter(\'\')">' + tr('allKitchenStaff') + ' (' + kitchenStaff.length + ')</button>' +
    stations.map(function (st) {
      var count = (staffByStation[st] || []).length;
      return '<button class="btn small ' + (activeFilter === st ? 'on' : '') + '" onclick="setKitchenFilter(\'' + esc(st).replace(/'/g, "\\'") + '\')">' +
        '🍳 ' + esc(st) + ' (' + count + ')</button>';
    }).join('') +
    (unassignedStaff.length ? '<button class="btn small ' + (activeFilter === '__unassigned__' ? 'on' : '') + '" onclick="setKitchenFilter(\'__unassigned__\')">⚠ ' + tr('unassigned') + ' (' + unassignedStaff.length + ')</button>' : '') +
  '</div>';

  // Section Routing Rows
  var sectionRows = sections.map(function (sec) {
    var curStation = (sec.kitchen_station || '').trim();
    var options = '<option value="">-- ' + tr('unassigned') + ' --</option>' +
      stations.map(function (st) {
        return '<option value="' + esc(st) + '"' + (curStation === st ? ' selected' : '') + '>🍳 ' + esc(st) + '</option>';
      }).join('') +
      '<option value="__new__">＋ ' + tr('stationPick') + '...</option>';

    return '<div class="kitchen-routing-row">' +
      '<div style="display:flex;align-items:center;gap:10px;">' +
        (sec.image_path ? '<img src="' + esc(sec.image_path) + '" style="width:36px;height:36px;border-radius:8px;object-fit:cover;">' : '<span style="font-size:24px;">🗂</span>') +
        '<div><b>' + esc(localizedLabel(sec.name)) + '</b></div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<label class="dim" style="font-size:13px;">' + tr('kitchenStation') + ':</label>' +
        '<select class="in small" style="min-width:160px;padding:6px 8px;" onchange="changeSectionStation(' + sec.id + ', this.value)">' +
          options +
        '</select>' +
      '</div>' +
    '</div>';
  }).join('');

  return '<div class="fabrow" style="gap:8px;flex-wrap:wrap;justify-content:space-between;align-items:center;">' +
      '<div><h2 style="margin:0;font-size:20px;">👨‍🍳 ' + tr('kitchenConfig') + '</h2>' +
      '<p class="dim" style="margin:4px 0 0;font-size:13.5px;">' + tr('routingHelp') + '</p></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button class="btn primary" onclick="kitchenStaffDlg(0)">＋ ' + tr('newKitchenStaff') + '</button>' +
        '<button class="btn" onclick="assignStaffDlg()">👤 ' + tr('assignStaff') + '</button>' +
      '</div>' +
    '</div>' +

    '<div class="kitchen-section-title">' +
      '<span>🍳 ' + tr('kitchenStations') + '</span>' +
    '</div>' +
    '<div class="station-grid">' + stationCardsHtml + '</div>' +

    '<div class="kitchen-section-title">' +
      '<span>👨‍🍳 ' + tr('kitchenStaff') + ' (' + filteredStaff.length + ')</span>' +
      '<button class="btn small primary" onclick="kitchenStaffDlg(0)">＋ ' + tr('newKitchenStaff') + '</button>' +
    '</div>' +
    filterChips +
    '<div class="rows" style="margin-bottom:24px;">' + (staffRows || '<div class="empty">' + tr('noKitchenStaffYet') + '</div>') + '</div>' +

    '<div class="kitchen-section-title">' +
      '<span>🗂 ' + tr('menuSectionRouting') + '</span>' +
    '</div>' +
    '<p class="dim" style="margin:-4px 0 10px;font-size:13px;">' + tr('routingHelp') + '</p>' +
    '<div class="rows">' + (sectionRows || '<div class="empty">' + tr('noSections') + '</div>') + '</div>';
}

function kitchenStaffDlg(id) {
  var s = id ? (S.data.staff || []).filter(function (x) { return x.id === id; })[0]
             : { name: '', role: 'kitchen', kitchen_station: '', active: 1, tables: '[]' };
  var sections = S.data.sections || [];
  var curStation = (s.kitchen_station || '').trim().toLowerCase();
  var sectionOptions = '';
  if (!sections.length) {
    sectionOptions = '<option value="">-- No sections available (create sections first) --</option>';
  } else {
    sectionOptions = '<option value="">-- ' + tr('selectStation') + ' --</option>' +
      sections.map(function (sec) {
        var secName = (sec.name || '').trim();
        var secVal = (sec.kitchen_station || secName).trim();
        var isSelected = curStation && (curStation === secVal.toLowerCase() || curStation === secName.toLowerCase());
        return '<option value="' + esc(secVal) + '"' + (isSelected ? ' selected' : '') + '>' +
          '🗂 ' + esc(localizedLabel(sec.name)) +
          '</option>';
      }).join('');
  }

  dlg('<h2>' + (id ? tr('editKitchenStaff') : tr('newKitchenStaff')) + '</h2>' +
    '<label class="f">' + tr('name') + '</label>' +
    '<input id="f-ks-name" class="in" value="' + esc(s.name) + '" placeholder="e.g. Chef Mario">' +
    '<label class="f">' + tr('stationSpecialty') + '</label>' +
    '<select id="f-ks-station" class="in">' + sectionOptions + '</select>' +
    '<label class="f">' + (id ? 'New PIN (leave blank to keep current)' : 'PIN (4–8 digits)') + '</label>' +
    '<input id="f-ks-pin" class="in" type="password" inputmode="numeric" autocomplete="new-password" placeholder="••••">' +
    '<label class="f"><input type="checkbox" id="f-ks-active"' + (s.active ? ' checked' : '') + '> ' + tr('onDutyLabel') + '</label>' +
    '<p id="f-ks-error" class="error-text" role="alert"></p>' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') + '</button>' +
    '<button class="btn primary" onclick="saveKitchenStaff(' + (id || 0) + ')">' + tr('save') + '</button></div>');
  var el = document.getElementById('f-ks-name'); if (el) el.focus();
}

async function saveKitchenStaff(id) {
  var name = val('f-ks-name').trim();
  if (!name) { var e = document.getElementById('f-ks-error'); if (e) e.textContent = tr('nameRequired'); return; }
  var station = val('f-ks-station').trim();
  if (!station) { var e = document.getElementById('f-ks-error'); if (e) e.textContent = 'Please choose a section from the scroll menu.'; return; }
  var pin = val('f-ks-pin').trim();
  if (!id && !/^\d{4,8}$/.test(pin)) {
    var e = document.getElementById('f-ks-error');
    if (e) e.textContent = 'Set a 4–8 digit PIN so this staff member can unlock their station tablet.';
    return;
  }
  if (pin && !/^\d{4,8}$/.test(pin)) {
    var e = document.getElementById('f-ks-error');
    if (e) e.textContent = 'PIN must be 4–8 digits.';
    return;
  }
  var body = {
    name: name,
    role: 'kitchen',
    kitchen_station: station,
    active: chk('f-ks-active') ? 1 : 0
  };
  if (!id) body.tables = [];
  if (pin) body.pin = pin;

  try {
    if (id) await api('/api/staff/' + id, 'PUT', body);
    else await api('/api/staff', 'POST', body);
    closeDlg();
    toast(tr('saved'));
    poll();
  } catch (err) {
    var e = document.getElementById('f-ks-error');
    if (e) e.textContent = err.message || tr('needConnection');
  }
}

function assignStaffDlg(defaultStation) {
  var staff = S.data.staff || [];
  var sections = S.data.sections || [];
  var curStation = (defaultStation || '').trim().toLowerCase();

  var staffOptions = staff.map(function(s) {
    var roleLabel = s.role === 'kitchen' ? ('🍳 ' + (s.kitchen_station || tr('unassigned'))) : '🧑‍🍽️ Waiter';
    return '<option value="' + s.id + '">' + esc(s.name) + ' (' + roleLabel + ')</option>';
  }).join('');

  var sectionOptions = '';
  if (!sections.length) {
    sectionOptions = '<option value="">-- No sections available --</option>';
  } else {
    sectionOptions = '<option value="">-- ' + tr('selectStation') + ' --</option>' +
      sections.map(function (sec) {
        var secName = (sec.name || '').trim();
        var secVal = (sec.kitchen_station || secName).trim();
        var isSelected = curStation && (curStation === secVal.toLowerCase() || curStation === secName.toLowerCase());
        return '<option value="' + esc(secVal) + '"' + (isSelected ? ' selected' : '') + '>' +
          '🗂 ' + esc(localizedLabel(sec.name)) +
          '</option>';
      }).join('');
  }

  dlg('<h2>' + tr('assignStaff') + '</h2>' +
    '<label class="f">' + tr('selectStaffMember') + '</label>' +
    '<select id="f-as-staff" class="in">' + (staffOptions || '<option value="">-- No staff members --</option>') + '</select>' +
    '<label class="f">' + tr('stationSpecialty') + '</label>' +
    '<select id="f-as-station" class="in">' + sectionOptions + '</select>' +
    '<label class="f">PIN (required if not set yet, 4–8 digits)</label>' +
    '<input id="f-as-pin" class="in" type="password" inputmode="numeric" placeholder="••••">' +
    '<p id="f-as-error" class="error-text" role="alert"></p>' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') + '</button>' +
    '<button class="btn primary" onclick="saveAssignStaff()">' + tr('assignStaff') + '</button></div>');
}

async function saveAssignStaff() {
  var staffId = parseInt(val('f-as-staff'), 10);
  if (!staffId) {
    var e = document.getElementById('f-as-error');
    if (e) e.textContent = 'Please select a staff member.';
    return;
  }
  var station = val('f-as-station').trim();
  if (!station) {
    var e = document.getElementById('f-as-error');
    if (e) e.textContent = 'Please choose a section from the scroll menu.';
    return;
  }
  var pin = val('f-as-pin').trim();
  var staffMember = (S.data.staff || []).filter(function(s){ return s.id === staffId; })[0];
  if (staffMember && !staffMember.has_pin && !pin) {
    var e = document.getElementById('f-as-error');
    if (e) e.textContent = 'This staff member needs a 4–8 digit PIN to unlock kitchen tablets.';
    return;
  }
  if (pin && !/^\d{4,8}$/.test(pin)) {
    var e = document.getElementById('f-as-error');
    if (e) e.textContent = 'PIN must be 4–8 digits.';
    return;
  }

  var body = {
    role: 'kitchen',
    kitchen_station: station
  };
  if (pin) body.pin = pin;

  try {
    await api('/api/staff/' + staffId, 'PUT', body);
    closeDlg();
    toast(tr('stationStaffAssigned'));
    poll();
  } catch(err) {
    var e = document.getElementById('f-as-error');
    if (e) e.textContent = err.message || tr('needConnection');
  }
}

function quickStationDlg(staffId) {
  var s = (S.data.staff || []).filter(function(x){ return x.id === staffId; })[0];
  if (!s) return;
  var sections = S.data.sections || [];
  var curStation = (s.kitchen_station || '').trim().toLowerCase();

  var sectionOptions = '';
  if (!sections.length) {
    sectionOptions = '<option value="">-- No sections available --</option>';
  } else {
    sectionOptions = '<option value="">-- ' + tr('selectStation') + ' --</option>' +
      sections.map(function (sec) {
        var secName = (sec.name || '').trim();
        var secVal = (sec.kitchen_station || secName).trim();
        var isSelected = curStation && (curStation === secVal.toLowerCase() || curStation === secName.toLowerCase());
        return '<option value="' + esc(secVal) + '"' + (isSelected ? ' selected' : '') + '>' +
          '🗂 ' + esc(localizedLabel(sec.name)) +
          '</option>';
      }).join('');
  }

  dlg('<h2>' + tr('assignStation') + ' — ' + esc(s.name) + '</h2>' +
    '<label class="f">' + tr('stationSpecialty') + '</label>' +
    '<select id="f-qs-station" class="in">' + sectionOptions + '</select>' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') + '</button>' +
    '<button class="btn primary" onclick="saveQuickStation(' + staffId + ')">' + tr('save') + '</button></div>');
}

async function saveQuickStation(staffId) {
  var station = val('f-qs-station').trim();
  try {
    await api('/api/staff/' + staffId, 'PUT', { role: 'kitchen', kitchen_station: station });
    closeDlg();
    toast(tr('stationStaffAssigned'));
    poll();
  } catch(err) {
    toast(err.message || tr('needConnection'));
  }
}

async function changeSectionStation(sectionId, station) {
  if (station === '__new__') {
    var name = prompt(tr('newStationPrompt'));
    if (!name || !name.trim()) { render(); return; }
    station = name.trim();
  }
  try {
    await api('/api/sections/' + sectionId, 'PUT', { kitchen_station: station });
    toast(tr('sectionStationUpdated'));
    poll();
  } catch(err) {
    toast(err.message || tr('needConnection'));
  }
}

// ---- waiters tab ----
function adminWaiters() {
  var waiters = (S.data.staff || []).filter(function (s) { return s.role !== 'kitchen'; });
  var rows = waiters.map(function (s) {
    var chips = parseTables(s.tables).map(function (t) { return '<span class="tag">' + t + '</span>'; }).join(' ');
    return '<div class="row">' +
      '<span class="rname grow">🧑‍🍽️ ' + esc(s.name) + '</span>' +
      '<span class="tag">' + (s.has_pin ? '🔒 ' + tr('passwordSet') : '⚠ ' + tr('noPassword')) + '</span>' +
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
  var s = id ? (S.data.staff || []).filter(function (x) { return x.id === id && x.role !== 'kitchen'; })[0]
             : { name: '', tables: '[]', active: 1, role:'waiter', kitchen_station:'' };
  var tstr = parseTables(s.tables).join(', ');
  dlg('<h2>' + (id ? tr('editWaiter') : tr('newWaiter')) + '</h2>' +
    '<label class="f">' + tr('name') + '</label><input id="f-w-name" class="in" value="' + esc(s.name) + '" placeholder="' + tr('waiterNamePlaceholder') + '">' +
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
  var body = { name: name, tables: parseTablesText(val('f-w-tables')), active: chk('f-w-active') ? 1 : 0,
    role: 'waiter', kitchen_station: '' };
  if (pin) body.pin = pin;
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
        (o.cancel_reason ? ' · <span style="color:#dc2626">' + esc(o.cancel_reason) + '</span>' : '') + '</span>' +
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
