'use strict';
/* ============================================================
   Waiter: table screen — tickets, menu, cart, sending orders
   ============================================================ */

function cartFor(t) {
  if (!S.cart[t]) S.cart[t] = [];
  return S.cart[t];
}
function cartSave() { saveLS('ro_cart', S.cart); }
function cartCount(t) { return cartFor(t).reduce(function (n, l) { return n + l.qty; }, 0); }
function cartTotal(t) {
  return cartFor(t).reduce(function (n, l) {
    var it = findItem(l.item_id);
    var extras = (l.modifiers || []).reduce(function (sum, m) { return sum + Number(m.price || 0); }, 0);
    return n + (it ? (it.price + extras) * l.qty : 0);
  }, 0);
}
function findItem(id) {
  return (S.data.items || []).filter(function (i) { return i.id === id; })[0] || null;
}
function lineModifiers(raw) {
  if (Array.isArray(raw)) return raw;
  try { var parsed = JSON.parse(raw || '[]'); return Array.isArray(parsed) ? parsed : []; }
  catch (e) { return []; }
}

function renderTableScreen(app, me) {
  var tableNo = S.tableNo;
  var orders = (S.data.orders || []).filter(function (o) { return o.table_no === tableNo; });
  var open = openOrders(orders);
  var recent = orders.filter(function (o) { return openOrders([o]).length === 0; }).slice(0, 3);

  var tickets = open.map(function (o) { return ticketCard(o, true); }).join('') ||
    '<div class="empty">' + tr('noOpen') + '</div>';
  var history = recent.map(function (o) { return ticketCard(o, false); }).join('');

  var sections = (S.data.sections || []).filter(function (s) { return s.active; });
  var chipAll = '<button class="btn small ' + (S.sectionFilter === 0 ? 'on' : '') +
    '" onclick="setSectionFilter(0)">' + tr('all') + '</button>';
  var chips = chipAll + sections.map(function (s) {
    return '<button class="btn small ' + (S.sectionFilter === s.id ? 'on' : '') +
      '" onclick="setSectionFilter(' + s.id + ')">' + esc(localizedLabel(s.name)) + '</button>';
  }).join('');

  var q = S.search.trim().toLowerCase();
  var items = (S.data.items || []).filter(function (i) {
    if (!i.active) return false;
    if (S.sectionFilter && i.section_id !== S.sectionFilter) return false;
    if (q && (localizedLabel(i.name) + ' ' + i.name + ' ' + (i.description || '')).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  var cart = cartFor(tableNo);
  var qtyOf = {}; cart.forEach(function (l) { qtyOf[l.item_id] = (qtyOf[l.item_id] || 0) + l.qty; });
  var grid = items.map(function (i) {
    return '<button class="mitem"' + (i.stock_qty === 0 ? ' disabled' : '') + ' onclick="chooseItem(' + i.id + ')">' +
      (qtyOf[i.id] ? '<span class="mqty">' + qtyOf[i.id] + '</span>' : '') +
      (i.image_url ? '<img class="mimage" src="' + esc(i.image_url) + '" alt="">' : '') +
      '<span class="mname">' + esc(localizedLabel(i.name)) + '</span>' +
      (i.description ? '<span class="mdesc">' + esc(i.description) + '</span>' : '') +
      (i.stock_qty === 0 ? '<span class="tag off">' + tr('outOfStock') + '</span>' : '') +
      '<span class="mprice">' + money(i.price) + '</span></button>';
  }).join('');

  var cnt = cartCount(tableNo), tot = cartTotal(tableNo);
  var cartbar = cnt
    ? '<div class="cartbar"><span>🛒 ' + cnt + ' ' + tr(cnt === 1 ? 'itemSingular' : 'itemsPlural') + ' · ' + money(tot) +
      '</span><button onclick="openReview()">' + tr('review') + ' ▸</button></div>'
    : '';

  app.innerHTML = waiterHeader(me, true) +
    '<div class="twocol">' +
      '<div class="panel"><h3>' + tr('tickets') + '</h3>' + tickets + history + '</div>' +
      '<div><div class="panel">' +
        '<h3>' + tr('menu') + '</h3>' +
        '<div class="searchrow"><input id="f-wsearch" class="in" placeholder="' + tr('searchMenu') + '" ' +
          'value="' + esc(S.search) + '" oninput="setSearch(this.value)"></div>' +
        '<div class="chips">' + chips + '</div>' +
        '<div class="menu-grid">' + (grid || '<div class="empty">' + tr('noDishes') + '</div>') + '</div>' +
      '</div></div>' +
    '</div>' + cartbar;
}
function setSearch(v) { S.search = v; render(); }
function setSectionFilter(id) { S.sectionFilter = id; render(); }

function chooseItem(itemId) {
  var it = findItem(itemId);
  if (!it || it.stock_qty === 0) return;
  var modifiers = [];
  try { modifiers = JSON.parse(it.modifiers || '[]'); } catch (e) {}
  if (!modifiers.length) { addToCart(itemId, []); return; }
  dlg('<h2>' + esc(localizedLabel(it.name)) + '</h2><div class="rows">' +
    modifiers.map(function (m, idx) {
      return '<label class="row"><input type="checkbox" class="item-modifier" data-index="' + idx +
        '"><span class="grow">' + esc(m.name) + '</span><b>+' + money(m.price) + '</b></label>';
    }).join('') + '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') +
    '</button><button class="btn primary" onclick="confirmItemModifiers(' + itemId + ')">' +
    tr('addItem') + '</button></div>');
}
function confirmItemModifiers(itemId) {
  var it = findItem(itemId), available = [];
  try { available = JSON.parse(it.modifiers || '[]'); } catch (e) {}
  var chosen = Array.prototype.slice.call(document.querySelectorAll('.item-modifier:checked')).map(function (el) {
    return available[Number(el.dataset.index)];
  });
  closeDlg(); addToCart(itemId, chosen);
}
function addToCart(itemId, modifiers) {
  var cart = cartFor(S.tableNo);
  modifiers = modifiers || [];
  var key = JSON.stringify(modifiers.map(function (m) { return m.name; }));
  var line = cart.filter(function (l) {
    return l.item_id === itemId && JSON.stringify((l.modifiers || []).map(function (m) { return m.name; })) === key;
  })[0];
  if (line) line.qty += 1;
  else cart.push({ item_id: itemId, qty: 1, note: '', modifiers: modifiers });
  cartSave(); render();
}

function ticketCard(o, actions) {
  var lines = o.lines.map(function (l) {
    var modifiers = lineModifiers(l.modifiers);
    return '<div class="tline' + (l.status === 'cancelled' ? ' cancelled' : '') + '">' +
      '<span>' + l.qty + '× ' + esc(localizedLabel(l.name)) +
      (modifiers.length ? ' <span class="lnote">(' + esc(modifiers.map(function (m) { return m.name; }).join(', ')) + ')</span>' : '') +
      (l.note ? ' <span class="lnote">— ' + esc(l.note) + '</span>' : '') + '</span>' +
      '<span class="dim">' + (l.status === 'cancelled' ? tr('cancelled') : money(l.price * l.qty)) + '</span></div>';
  }).join('');
  var acts = '';
  if (actions) {
    acts = '<div class="tacts">' +
      '<button class="btn small" onclick="printTicket(' + o.id + ')">🖨️ ' + tr('print') + '</button>' +
      (!o.bill_requested && o.status !== 'cancelled'
        ? '<button class="btn small" onclick="requestBill(' + o.id + ')">' + tr('requestBill') + '</button>' : '') +
      (o.status === 'ready' ? '<button class="btn small green" onclick="serveOrder(' + o.id + ')">✓ ' + tr('served') + '</button>' : '') +
      '<button class="btn small danger" onclick="cancelOrderDlg(' + o.id + ')">✕ ' + tr('cancel') + '</button>' +
      '</div>';
  }
  return '<div class="ticket st-' + o.status + '">' +
    '<div class="thead"><span class="tid">' + tr('ticket') + ' #' + o.id + ' · ' + hhmm(o.created_at) + '</span>' +
    '<span class="chip ' + o.status + '">' + tStatus(o.status) + '</span></div>' +
    '<div class="tlines">' + lines + '</div>' +
    (o.note ? '<div class="tnote">' + tr('notePrefix') + esc(o.note) + '</div>' : '') +
    '<div class="thead"><span class="bigprice">' + money(o.total) + '</span></div>' +
    acts + '</div>';
}
async function requestBill(id) {
  try { await api('/api/orders/' + id + '/bill', 'PUT', {}); poll(); }
  catch (e) { toast(e.code ? e.message : tr('needConnection')); }
}

// ---------- review + send ----------
function openReview() {
  var t = S.tableNo, cart = cartFor(t);
  if (!cart.length) return;
  var rows = cart.map(function (l, idx) {
    var it = findItem(l.item_id);
    if (!it) return '';
    return '<div class="row">' +
      '<span class="grow"><span class="rname">' + esc(localizedLabel(it.name)) + '</span>' +
      '<span class="rsub">' + money(it.price + (l.modifiers || []).reduce(function (n, m) { return n + Number(m.price || 0); }, 0)) +
      ((l.modifiers || []).length ? ' · ' + esc(l.modifiers.map(function (m) { return m.name; }).join(', ')) : '') +
      (l.note ? ' · <b style="color:#fca5a5">' + esc(l.note) + '</b>' : '') + '</span></span>' +
      '<button class="btn small" onclick="cartQty(' + idx + ',-1)">−</button>' +
      '<b>' + l.qty + '</b>' +
      '<button class="btn small" onclick="cartQty(' + idx + ',1)">＋</button>' +
      '<button class="btn small" onclick="cartNote(' + idx + ')">✎ ' + tr('noteLabel') + '</button>' +
      '</div>';
  }).join('');
  dlg('<h2>' + tr('table') + ' ' + t + ' — ' + tr('reviewOrder') + '</h2>' +
    '<div class="rows">' + rows + '</div>' +
    '<label class="f">' + tr('noteKitchen') + '</label>' +
    '<textarea id="f-onote" class="in" rows="2" placeholder="' + tr('optional') + '"></textarea>' +
    '<div class="dlg-foot">' +
    '<button class="btn" onclick="closeDlg()">' + tr('keepEditing') + '</button>' +
    '<button class="btn primary" onclick="sendOrder()">' + tr('send') + ' ▸</button></div>');
}
function cartQty(idx, d) {
  var cart = cartFor(S.tableNo);
  cart[idx].qty += d;
  if (cart[idx].qty <= 0) cart.splice(idx, 1);
  cartSave();
  if (!cart.length) { closeDlg(); render(); } else { closeDlg(); openReview(); render(); }
}
function cartNote(idx) {
  var cart = cartFor(S.tableNo);
  dlg('<h2>' + tr('noteItem') + '</h2>' +
    '<input id="f-line-note" class="in" value="' + esc(cart[idx].note) + '" placeholder="' + tr('itemNotePlaceholder') + '">' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('back') + '</button>' +
    '<button class="btn primary" onclick="saveLineNote(' + idx + ')">' + tr('save') + '</button></div>');
}
function saveLineNote(idx) {
  var v = document.getElementById('f-line-note').value.trim().slice(0, 200);
  cartFor(S.tableNo)[idx].note = v;
  closeDlg(); openReview();
}
async function sendOrder() {
  var t = S.tableNo, cart = cartFor(t).slice();
  var noteEl = document.getElementById('f-onote');
  var note = noteEl ? noteEl.value.trim().slice(0, 300) : '';
  if (!cart.length) return;
  var body = {
    table_no: t, staff_id: S.waiterId, note: note, client_uuid: uuid(), lang: S.lang,
    lines: cart.map(function (l) { return { item_id: l.item_id, qty: l.qty, note: l.note, modifiers: l.modifiers || [] }; })
  };
  S.cart[t] = []; cartSave();
  try {
    var r = await api('/api/orders', 'POST', body);
    closeDlg(); poll(); render();
    toast(tr('ticket') + ' #' + r.order_id + ' ' + tr('ticketSent'));
  } catch (e) {
    if (e.code) { // server refused (e.g. empty order) — restore cart
      S.cart[t] = cart; cartSave(); closeDlg(); toast(tr('sendFailed') + e.message);
    } else {
      enqueue('/api/orders', body);
      closeDlg(); poll(); render();
      toast(tr('offlineSavedOrder'));
    }
  }
}

// ---------- ticket actions ----------
function printTicket(id) { window.open('/api/ticket/' + id + '.html?lang=' + encodeURIComponent(S.lang), '_blank'); }
function serveOrder(id) {
  actOrQueue('/api/orders/' + id + '/status', { status: 'served' }, tr('ticket') + ' #' + id + ' ' + tr('ticketServed'));
}
async function cancelOrderDlg(id, isAdmin) {
  dlg('<h2>' + tr('cancelTicketTitle') + id + tr('questionSuffix') + '</h2>' +
    '<label class="f">' + tr('cancelReason') + '</label>' +
    '<input id="f-cancel-reason" class="in" placeholder="' + tr('cancelReasonPlaceholder') + '">' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('keepTicket') + '</button>' +
    '<button class="btn danger" onclick="confirmCancel(' + id + ')">' + tr('cancelTicket') + '</button></div>');
}
async function confirmCancel(id) {
  var el = document.getElementById('f-cancel-reason');
  var reason = el ? el.value.trim().slice(0, 300) : '';
  closeDlg();
  actOrQueue('/api/orders/' + id + '/status', { status: 'cancelled', reason: reason }, tr('ticket') + ' #' + id + ' ' + tr('cancelled'));
}
async function cancelLineDlg(orderId, lineId) {
  var o = (S.data.orders || []).filter(function (x) { return x.id === orderId; })[0];
  var l = o ? o.lines.filter(function (x) { return x.id === lineId; })[0] : null;
  dlg('<h2>' + tr('cancel') + ' «' + esc(l ? l.name : tr('item')) + '»' + tr('questionSuffix') + '</h2>' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('keepItem') + '</button>' +
    '<button class="btn danger" onclick="confirmLineCancel(' + orderId + ',' + lineId + ')">' + tr('cancelItem') + '</button></div>');
}
async function confirmLineCancel(orderId, lineId) {
  closeDlg();
  actOrQueue('/api/orders/' + orderId + '/lines/' + lineId + '/status', { status: 'cancelled' }, tr('item') + ' ' + tr('cancelled'));
}
async function actOrQueue(path, body, okMsg) {
  try {
    await api(path, 'POST', body);
    toast(okMsg); poll();
  } catch (e) {
    if (e.code) toast(tr('actionFailed') + e.message);
    else { enqueue(path, body); toast(tr('offlineSavedAction')); }
  }
}
