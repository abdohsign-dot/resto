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
    return n + catalogLinePrice(l) * l.qty;
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

async function loadWaiterCatalog() {
  if (S.waiterCatalogLoadedFor === S.branchId) return;
  var products = await api('/api/products');
  var groups = await api('/api/modifier-groups');
  S.waiterProducts = products.products || [];
  S.waiterGroups = {};
  (groups.modifier_groups || []).forEach(function (g) { S.waiterGroups[g.id] = g; });
  S.waiterCatalogLoadedFor = S.branchId;
}

function findCatalogProduct(id) {
  return (S.waiterProducts || []).filter(function (p) { return p.id === id; })[0] || null;
}

function catalogLineVariant(line) {
  var product = findCatalogProduct(line.product_id);
  if (!product) return null;
  return (product.variants || []).filter(function (v) { return v.id === line.variant_id; })[0] || null;
}

function catalogLinePrice(line) {
  var variant = catalogLineVariant(line);
  if (!variant) return 0;
  var cents = variant.price_cents || 0;
  (line.modifier_option_ids || []).forEach(function (optionId) {
    Object.keys(S.waiterGroups || {}).forEach(function (groupId) {
      var option = ((S.waiterGroups[groupId].options) || []).filter(function (o) {
        return o.id === optionId;
      })[0];
      if (option) cents += option.price_delta_cents || 0;
    });
  });
  return cents / 100;
}

function renderTableScreen(app, me, isAdminPos) {
  if (S.waiterCatalogLoadedFor !== S.branchId) {
    loadWaiterCatalog().then(function () { render(); }).catch(function (e) {
      toast(e.message || tr('needConnection'));
    });
  }
  var tableNo = S.tableNo;
  var orders = isAdminPos ? [] : (S.data.orders || []).filter(function (o) { return o.table_no === tableNo; });
  var open = openOrders(orders);
  var recent = orders.filter(function (o) { return openOrders([o]).length === 0; }).slice(0, 3);

  var tickets = open.map(function (o) { return ticketCard(o, true); }).join('') ||
    '<div class="empty">' + tr('noOpen') + '</div>';
  var history = recent.map(function (o) { return ticketCard(o, false); }).join('');

  var q = S.search.trim().toLowerCase();
  var sections = (S.data.sections || []).filter(function (s) { return s.active; });
  var selectedSection = sections.filter(function (s) { return s.id === S.sectionFilter; })[0] || null;
  var path = (S.menuPath || []).map(findCatalogProduct).filter(Boolean);
  if (!selectedSection) { S.sectionFilter = 0; S.menuPath = []; path = []; }
  var cart = cartFor(tableNo);
  var qtyOf = {}; cart.forEach(function (l) { qtyOf[l.product_id] = (qtyOf[l.product_id] || 0) + l.qty; });
  function isAvailable(product) {
    if (!product || !product.active || product.deleted_at) return false;
    var parent = product.parent_id == null ? null : findCatalogProduct(product.parent_id);
    return !parent || (parent.kind === 'group' && isAvailable(parent));
  }
  function productPath(product) {
    var section = (S.data.sections || []).filter(function (s) {
      return s.id === product.section_id;
    })[0];
    var labels = [section ? localizedLabel(section.name) : ''];
    var chain = [], current = product, guard = 0;
    while (current && guard++ < 100) {
      chain.unshift(localizedLabel(current.name));
      current = current.parent_id == null ? null : findCatalogProduct(current.parent_id);
    }
    return labels.concat(chain).filter(Boolean).join(' › ');
  }
  var grid;
  if (q) {
    var matches = (S.waiterProducts || []).filter(function (p) {
      return p.kind === 'item' && isAvailable(p) &&
        (localizedLabel(p.name) + ' ' + p.name + ' ' + (p.description || '') + ' ' +
          productPath(p)).toLowerCase().indexOf(q) >= 0;
    });
    grid = matches.map(function (p) {
      var variants = (p.variants || []).filter(function (v) { return v.active; });
      var prices = variants.map(function (v) { return v.price_cents || 0; });
      var minPrice = prices.length ? Math.min.apply(Math, prices) : 0;
      return '<button class="menu-tile" onclick="chooseCatalogProduct(' + p.id + ')">' +
        (p.image_path ? '<img class="menu-tile-image" src="' + esc(p.image_path) + '" alt="">' :
          '<span class="menu-tile-placeholder" aria-hidden="true">🍽️</span>') +
        '<span class="menu-tile-copy"><span class="mname">' + esc(localizedLabel(p.name)) + '</span>' +
        '<span class="menu-tile-path">' + esc(productPath(p)) + '</span>' +
        '<span class="mprice">' + (prices.length ? (I18N[S.lang].from || tr('price')) + ' ' + money(minPrice / 100) : '') +
        '</span></span></button>';
    }).join('');
  } else if (!selectedSection) {
    grid = sections.map(function (section) {
      var count = (S.waiterProducts || []).filter(function (p) {
        return p.section_id === section.id && p.parent_id == null && isAvailable(p);
      }).length;
      return '<button class="menu-tile" onclick="setSectionFilter(' + section.id + ')">' +
        (section.image_path ? '<img class="menu-tile-image" src="' + esc(section.image_path) + '" alt="">' :
          '<span class="menu-tile-placeholder" aria-hidden="true">🗂️</span>') +
        '<span class="menu-tile-copy"><span class="mname">' + esc(localizedLabel(section.name)) + '</span>' +
        '<span class="tag">' + count + ' ' + tr('itemsPlural') + '</span></span></button>';
    }).join('');
  } else {
    var currentParent = path.length ? path[path.length - 1] : null;
    var nodes = (S.waiterProducts || []).filter(function (p) {
      return p.section_id === selectedSection.id && p.parent_id === (currentParent ? currentParent.id : null) &&
        isAvailable(p);
    });
    grid = nodes.map(function (p) {
      if (p.kind === 'group') {
        var count = (S.waiterProducts || []).filter(function (child) {
          return child.parent_id === p.id && isAvailable(child);
        }).length;
        return '<button class="menu-tile" onclick="openMenuGroup(' + p.id + ')">' +
          (p.image_path ? '<img class="menu-tile-image" src="' + esc(p.image_path) + '" alt="">' :
            '<span class="menu-tile-placeholder" aria-hidden="true">📁</span>') +
          '<span class="menu-tile-copy"><span class="mname">' + esc(localizedLabel(p.name)) + '</span>' +
          '<span class="tag">' + count + ' ' + tr('childCount') + '</span></span></button>';
      }
    var variants = (p.variants || []).filter(function (v) { return v.active; });
      var allSoldOut = variants.length === 0 || variants.every(function (v) { return v.stock_qty === 0; });
    var prices = variants.map(function (v) { return v.price_cents || 0; });
    var minPrice = prices.length ? Math.min.apply(Math, prices) : 0;
    var maxPrice = prices.length ? Math.max.apply(Math, prices) : 0;
    var priceLabel = minPrice === maxPrice ? money(minPrice / 100) :
        (I18N[S.lang].from || 'From') + ' ' + money(minPrice / 100);
      return '<button class="menu-tile" ' + (allSoldOut ? 'disabled' : '') +
        ' onclick="chooseCatalogProduct(' + p.id + ')">' +
        (qtyOf[p.id] ? '<span class="mqty">' + qtyOf[p.id] + '</span>' : '') +
        (p.image_path ? '<img class="menu-tile-image" src="' + esc(p.image_path) + '" alt="">' :
          '<span class="menu-tile-placeholder" aria-hidden="true">🍽️</span>') +
        '<span class="menu-tile-copy"><span class="mname">' + esc(localizedLabel(p.name)) + '</span>' +
        (p.description ? '<span class="mdesc">' + esc(p.description) + '</span>' : '') +
        (allSoldOut ? '<span class="tag off">' + tr('outOfStock') + '</span>' :
          '<span class="mprice">' + priceLabel + '</span>') + '</span></button>';
    }).join('');
  }
  var crumbs = '<button class="btn small" onclick="menuHome()">' + tr('menuHome') + '</button>';
  if (selectedSection) {
    crumbs += '<span class="crumb-sep">›</span><button class="btn small" onclick="menuRoot()">' +
      esc(localizedLabel(selectedSection.name)) + '</button>';
    path.forEach(function (node, index) {
      crumbs += '<span class="crumb-sep">›</span><button class="btn small" onclick="menuDepth(' +
        (index + 1) + ')">' + esc(localizedLabel(node.name)) + '</button>';
    });
  }

  var cnt = cartCount(tableNo), tot = cartTotal(tableNo);
  var cartbar = cnt
    ? '<div class="cartbar"><span>🛒 ' + cnt + ' ' + tr(cnt === 1 ? 'itemSingular' : 'itemsPlural') + ' · ' + money(tot) +
      '</span><div class="cartbar-actions"><button class="cart-cancel" onclick="cancelOrderDraft()">' + tr('cancelDraft') + '</button>' +
      '<button onclick="openReview()">' + tr('review') + ' ▸</button></div></div>'
    : '';

  var targetPicker = isAdminPos ? '<div class="pos-target"><button class="btn ' + (S.adminOrderType === 'dine_in' ? 'on' : '') + '" onclick="setAdminOrderType(\'dine_in\')">🪑 Dine-in</button><button class="btn ' + (S.adminOrderType === 'imported' ? 'on' : '') + '" onclick="setAdminOrderType(\'imported\')">📦 Imported Order</button>' +
    (S.adminOrderType === 'dine_in' ? '<label>Table <input class="in pos-table" type="number" min="1" value="' + esc(S.adminDineInTable) + '" onchange="setAdminDineInTable(this.value)"></label>' : '') + '</div>' : '';
  var page = (isAdminPos ? '' : waiterHeader(me, true)) +
    '<div class="twocol' + (isAdminPos ? ' admin-pos' : '') + '">' +
      (isAdminPos ? '' : '<div class="panel"><h3>' + tr('tickets') + '</h3>' + tickets + history + '</div>') +
      '<div><div class="panel">' +
        (isAdminPos ? '' : '<h3>' + tr('menu') + '</h3>') +
        targetPicker +
        '<div class="searchrow"><input id="f-wsearch" class="in" placeholder="' + tr('searchMenu') + '" ' +
          'value="' + esc(S.search) + '" oninput="setSearch(this.value)"></div>' +
        '<div class="menu-breadcrumb">' + crumbs + '</div>' +
        '<div class="menu-grid">' + (grid || '<div class="empty">' + tr('noDishes') + '</div>') + '</div>' +
      '</div></div>' +
    '</div>' + cartbar;
  if (app) app.innerHTML = page;
  return page;
}
function setAdminOrderType(type) {
  S.adminOrderType = type === 'dine_in' ? 'dine_in' : 'imported';
  S.tableNo = S.adminOrderType === 'imported' ? 0 : Math.max(1, parseInt(S.adminDineInTable, 10) || 1);
  S.sectionFilter = 0; S.menuPath = []; render();
}
function setAdminDineInTable(value) {
  S.adminDineInTable = Math.max(1, parseInt(value, 10) || 1);
  S.tableNo = S.adminDineInTable; render();
}
function setSearch(v) { S.search = v; render(); }
function setSectionFilter(id) { S.sectionFilter = id; S.menuPath = []; render(); }
function menuHome() { S.sectionFilter = 0; S.menuPath = []; S.search = ''; render(); }
function menuRoot() { S.menuPath = []; S.search = ''; render(); }
function menuDepth(depth) { S.menuPath = S.menuPath.slice(0, depth); S.search = ''; render(); }
function openMenuGroup(id) { S.menuPath.push(parseInt(id, 10)); S.search = ''; render(); }

function chooseCatalogProduct(productId) {
  var product = findCatalogProduct(productId);
  if (!product || product.kind === 'group') return;
  var variants = (product.variants || []).filter(function (v) { return v.active; });
  var defaultVariant = variants.filter(function (v) { return v.is_default; })[0] || variants[0];
  if (!variants.length) return;
  var attachments = product.modifier_groups || [];
  var html = '<h2>' + esc(localizedLabel(product.name)) + '</h2>';
  if (product.description) html += '<p class="dim">' + esc(product.description) + '</p>';
  html += '<h3>Size / variant</h3><div class="catalog-variant-picker">';
  html += variants.map(function (v) {
    var soldOut = v.stock_qty === 0;
    return '<label class="catalog-choice catalog-variant-tile' + (soldOut ? ' disabled' : '') + '">' +
      '<input type="radio" name="catalog-variant" value="' + v.id + '"' +
      (soldOut ? ' disabled' : '') + (v.id === defaultVariant.id ? ' checked' : '') + '>' +
      (v.image_path || product.image_path ? '<img src="' + esc(v.image_path || product.image_path) + '" alt="">' :
        '<span class="variant-placeholder" aria-hidden="true">🍽️</span>') +
      '<span class="catalog-choice-copy"><b>' + esc(v.name) + '</b>' +
      (soldOut ? '<span class="tag off">' + tr('soldOutShort') + '</span>' : '') +
      '<span class="catalog-price-badge">' + money(v.price_cents / 100) + '</span></span></label>';
  }).join('');
  html += '</div>';
  attachments.forEach(function (attachment) {
    var group = S.waiterGroups[attachment.modifier_group_id];
    if (!group) return;
    var minimum = attachment.override_min != null ? attachment.override_min : group.min_select;
    var maximum = attachment.override_max != null ? attachment.override_max : group.max_select;
    var groupLabel = group.product_id ? tr('choices') : group.name;
    html += '<h3>' + esc(groupLabel) +
      (minimum > 0 ? ' * (choose ' + minimum + ')' : '') + '</h3><div class="catalog-option-picker">';
    (group.options || []).filter(function (o) { return o.active; }).forEach(function (o) {
      html += '<label class="catalog-choice catalog-option-tile"><input type="' +
        (group.selection_type === 'single' ? 'radio' : 'checkbox') +
        '" name="catalog-group-' + group.id + '" value="' + o.id +
        '" data-group="' + group.id + '" data-max="' + maximum +
        '" onchange="catalogSheetChanged(' + productId + ')"><span class="catalog-option-name">' +
        esc(o.name) + '</span>' +
        ((o.price_delta_cents || 0) !== 0 ? '<b class="catalog-price-badge">' +
        ((o.price_delta_cents || 0) > 0 ? '+' : '') +
        money((o.price_delta_cents || 0) / 100) + '</b>' : '') + '</label>';
    });
    html += '</div>';
  });
  html += '<label class="f">Note</label><input id="catalog-sheet-note" class="in" maxlength="200">' +
    '<div class="catalog-qty"><button class="btn small" onclick="catalogQty(-1)">−</button>' +
    '<b id="catalog-sheet-qty">1</b><button class="btn small" onclick="catalogQty(1)">＋</button>' +
    '<span id="catalog-sheet-price" class="catalog-sheet-price"></span></div>' +
    '<div id="catalog-sheet-error" class="error-text"></div>' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') +
    '</button><button id="catalog-sheet-add" class="btn primary" onclick="confirmCatalogProduct(' +
    productId + ')">' + tr('addItem') + '</button></div>';
  dlg(html);
  catalogSheetChanged(productId);
}

function catalogQty(delta) {
  var el = document.getElementById('catalog-sheet-qty');
  if (!el) return;
  var qty = Math.max(1, Math.min(50, (parseInt(el.textContent, 10) || 1) + delta));
  el.textContent = qty;
  var productId = Array.prototype.map.call(document.querySelectorAll('[onclick^="confirmCatalogProduct"]'), function (b) {
    return null;
  });
  var addButton = document.getElementById('catalog-sheet-add');
  var match = addButton && addButton.getAttribute('onclick').match(/confirmCatalogProduct\((\d+)\)/);
  if (match) catalogSheetChanged(parseInt(match[1], 10));
}

function catalogSheetChanged(productId) {
  var product = findCatalogProduct(productId);
  if (!product) return;
  var selectedVariant = document.querySelector('input[name="catalog-variant"]:checked');
  var variant = selectedVariant ? (product.variants || []).filter(function (v) {
    return v.id === parseInt(selectedVariant.value, 10);
  })[0] : null;
  var cents = variant ? variant.price_cents || 0 : 0;
  var selectedIds = [];
  Array.prototype.forEach.call(document.querySelectorAll('.catalog-option-picker input:checked'), function (input) {
    selectedIds.push(parseInt(input.value, 10));
  });
  (product.modifier_groups || []).forEach(function (attachment) {
    var group = S.waiterGroups[attachment.modifier_group_id];
    if (!group) return;
    var maximum = attachment.override_max != null ? attachment.override_max : group.max_select;
    var checked = document.querySelectorAll('.catalog-option-picker input[data-group="' +
      group.id + '"]:checked');
    if (group.selection_type === 'multi' && checked.length >= maximum) {
      document.querySelectorAll('.catalog-option-picker input[data-group="' +
        group.id + '"]:not(:checked)').forEach(function (input) { input.disabled = true; });
    } else {
      document.querySelectorAll('.catalog-option-picker input[data-group="' +
        group.id + '"]').forEach(function (input) { input.disabled = false; });
    }
  });
  Object.keys(S.waiterGroups).forEach(function (groupId) {
    var group = S.waiterGroups[groupId];
    (group.options || []).forEach(function (option) {
      if (selectedIds.indexOf(option.id) >= 0) cents += option.price_delta_cents || 0;
    });
  });
  var qty = parseInt(document.getElementById('catalog-sheet-qty').textContent, 10) || 1;
  var priceEl = document.getElementById('catalog-sheet-price');
  if (priceEl) priceEl.textContent = money(Math.max(0, cents) / 100) + ' × ' + qty;
  var error = '';
  (product.modifier_groups || []).forEach(function (attachment) {
    var group = S.waiterGroups[attachment.modifier_group_id];
    if (!group) return;
    var minimum = attachment.override_min != null ? attachment.override_min : group.min_select;
    var selectedCount = document.querySelectorAll('.catalog-option-picker input[data-group="' +
      group.id + '"]:checked').length;
    if (minimum > 0 && selectedCount < minimum) error = 'Choose ' + minimum + ' option(s) from ' + (group.product_id ? tr('choices') : group.name);
  });
  var errorEl = document.getElementById('catalog-sheet-error');
  if (errorEl) errorEl.textContent = error;
  var add = document.getElementById('catalog-sheet-add');
  if (add) add.disabled = !!error;
}

function confirmCatalogProduct(productId) {
  var product = findCatalogProduct(productId);
  if (!product) return;
  var selectedVariant = document.querySelector('input[name="catalog-variant"]:checked');
  if (!selectedVariant) { catalogInlineError('Select a variant'); return; }
  var optionIds = Array.prototype.map.call(
    document.querySelectorAll('.catalog-option-picker input:checked'),
    function (input) { return parseInt(input.value, 10); });
  var qty = parseInt(document.getElementById('catalog-sheet-qty').textContent, 10) || 1;
  var note = val('catalog-sheet-note');
  var cart = cartFor(S.tableNo);
  var key = JSON.stringify({
    product_id: productId,
    variant_id: parseInt(selectedVariant.value, 10),
    modifier_option_ids: optionIds.slice().sort(function (a, b) { return a - b; }),
    note: note
  });
  var line = cart.filter(function (l) {
    return JSON.stringify({
      product_id: l.product_id,
      variant_id: l.variant_id,
      modifier_option_ids: (l.modifier_option_ids || []).slice().sort(function (a, b) { return a - b; }),
      note: l.note || ''
    }) === key;
  })[0];
  if (line) line.qty += qty;
  else cart.push({
    product_id: productId,
    variant_id: parseInt(selectedVariant.value, 10),
    modifier_option_ids: optionIds,
    qty: qty,
    note: note
  });
  cartSave();
  closeDlg();
  render();
}

function ticketCard(o, actions) {
  var lines = o.lines.map(function (l) {
    var modifiers = lineModifiers(l.modifiers);
    if (!modifiers.length && l.modifiers_json) modifiers = lineModifiers(l.modifiers_json);
    var modifierNames = modifiers.map(function (m) { return m.name; }).join(', ');
    return '<div class="tline' + (l.status === 'cancelled' ? ' cancelled' : '') + '">' +
      '<span>' + l.qty + '× ' + esc(localizedLabel(l.name)) +
      (l.variant_name ? ' <span class="lnote">(' + esc(l.variant_name) + ')</span>' : '') +
      (modifiers.length ? '<span class="lnote"> · ' + esc(modifierNames) + '</span>' : '') +
      (l.note ? ' <span class="lnote">— ' + esc(l.note) + '</span>' : '') + '</span>' +
      '<span class="tline-meta"><span class="chip ' + l.status + ' tline-state">' + tStatus(l.status) + '</span>' +
      (l.status === 'cancelled' ? '' : '<span class="dim">' + money(l.price * l.qty) + '</span>') + '</span></div>';
  }).join('');
  var acts = '';
  if (actions) {
    acts = '<div class="tacts">' +
      (o.status === 'ready' ? '<button class="btn small green" onclick="serveOrder(' + o.id + ')">✓ ' + tr('served') + '</button>' : '') +
      '<button class="btn small danger" onclick="cancelOrderDlg(' + o.id + ')">✕ ' + tr('cancel') + '</button>';
    acts += '</div>';
  }
  return '<div class="ticket st-' + o.status + '">' +
    '<div class="thead"><span class="tid">' + tr('ticket') + ' #' + o.id + ' · ' + hhmm(o.created_at) + '</span>' +
    '<span class="chip ' + o.status + '">' + tStatus(o.status) + '</span></div>' +
    '<div class="tlines">' + lines + '</div>' +
    (o.note ? '<div class="tnote">' + tr('notePrefix') + esc(o.note) + '</div>' : '') +
    '<div class="thead"><span class="bigprice">' + money(o.total) + '</span></div>' +
    acts + '</div>';
}
// ---------- review + send ----------
function openReview() {
  var t = S.tableNo, cart = cartFor(t);
  if (!cart.length) return;
  var rows = cart.map(function (l, idx) {
    var product = findCatalogProduct(l.product_id);
    if (!product) return '';
    var variant = catalogLineVariant(l);
    var modifierNames = [];
    (l.modifier_option_ids || []).forEach(function (optionId) {
      Object.keys(S.waiterGroups || {}).forEach(function (groupId) {
        var option = ((S.waiterGroups[groupId].options) || []).filter(function (o) {
          return o.id === optionId;
        })[0];
        if (option) modifierNames.push(option.name);
      });
    });
    return '<div class="row">' +
      '<span class="grow"><span class="rname">' + esc(localizedLabel(product.name)) +
      (variant ? ' (' + esc(variant.name) + ')' : '') + '</span>' +
      '<span class="rsub">' + money(catalogLinePrice(l)) +
      (modifierNames.length ? ' · ' + esc(modifierNames.join(', ')) : '') +
      (l.note ? ' · <b style="color:#dc2626">' + esc(l.note) + '</b>' : '') + '</span></span>' +
      '<button class="btn small" onclick="cartQty(' + idx + ',-1)">−</button>' +
      '<b>' + l.qty + '</b>' +
      '<button class="btn small" onclick="cartQty(' + idx + ',1)">＋</button>' +
      '<button class="btn small" onclick="cartNote(' + idx + ')">✎ ' + tr('noteLabel') + '</button>' +
      '<button class="btn small danger" aria-label="' + tr('removeDraftItem') + '" title="' + tr('removeDraftItem') + '" onclick="removeDraftLine(' + idx + ')">× ' + tr('removeDraftItem') + '</button>' +
      '</div>';
  }).join('');
  dlg('<h2>' + (S.role === 'admin' ? (S.adminOrderType === 'imported' ? '📦 Imported Order' : '🪑 Table ' + t) : tr('table') + ' ' + t) + ' — ' + tr('reviewOrder') + '</h2>' +
    '<div class="rows">' + rows + '</div>' +
    '<label class="f">' + tr('noteKitchen') + '</label>' +
    '<textarea id="f-onote" class="in" rows="2" placeholder="' + tr('optional') + '"></textarea>' +
    '<div class="dlg-foot">' +
    '<button class="btn danger" onclick="cancelOrderDraft()">' + tr('cancelDraft') + '</button>' +
    '<button class="btn" onclick="closeDlg()">' + tr('keepEditing') + '</button>' +
    '<button class="btn primary" onclick="sendOrder()">' + tr('send') + ' ▸</button></div>');
}
function cancelOrderDraft() {
  dlg('<h2>' + tr('cancelDraft') + '?</h2><p>' + tr('discardDraftPrompt') + '</p>' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('keepEditing') + '</button>' +
    '<button class="btn danger" onclick="confirmCancelOrderDraft()">' + tr('cancelDraft') + '</button></div>');
}
function confirmCancelOrderDraft() {
  S.cart[S.tableNo] = [];
  cartSave(); closeDlg(); render(); toast(tr('draftCancelled'));
}
function removeDraftLine(idx) {
  var cart = cartFor(S.tableNo);
  if (idx < 0 || idx >= cart.length) return;
  cart.splice(idx, 1);
  cartSave(); closeDlg();
  if (cart.length) openReview();
  render();
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
    table_no: t, staff_id: S.role === 'admin' ? null : S.waiterId,
    order_type: S.role === 'admin' && S.adminOrderType === 'imported' ? 'imported' : 'dine_in',
    note: note, client_uuid: uuid(), lang: S.lang,
    lines: cart.map(function (l) {
      return {
        product_id: l.product_id,
        variant_id: l.variant_id,
        modifier_option_ids: l.modifier_option_ids || [],
        qty: l.qty,
        note: l.note || ''
      };
    })
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
