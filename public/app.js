// Household Stock Taker - frontend.

const DEFAULT_CATEGORIES = [
  'Pantry', 'Fridge', 'Freezer', 'Drinks', 'Snacks',
  'Cleaning', 'Laundry', 'Bathroom', 'Medicine', 'Baby', 'Pets', 'Other',
];

const api = {
  async list(params = {}) {
    const u = new URL('/api/items', location.origin);
    Object.entries(params).forEach(([k, v]) => v && u.searchParams.set(k, v));
    return (await fetch(u)).json();
  },
  async get(id) { return (await fetch(`/api/items/${id}`)).json(); },
  async create(body) {
    const r = await fetch('/api/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'create failed');
    return r.json();
  },
  async update(id, body) {
    const r = await fetch(`/api/items/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'update failed');
    return r.json();
  },
  async remove(id) {
    const r = await fetch(`/api/items/${id}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 204) throw new Error('delete failed');
  },
  async adjust(id, delta, reason, note) {
    const r = await fetch(`/api/items/${id}/adjust`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delta, reason, note }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'adjust failed');
    return r.json();
  },
  async usage(id) { return (await fetch(`/api/items/${id}/usage`)).json(); },
  async lookup(code) {
    const r = await fetch(`/api/lookup/${encodeURIComponent(code)}`);
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  },
  async stats() { return (await fetch('/api/stats')).json(); },
  async categories() {
    try { return await (await fetch('/api/categories')).json(); }
    catch { return []; }
  },
  async categoriesManage() {
    return (await fetch('/api/categories/manage')).json();
  },
  async createCategory(name) {
    const r = await fetch('/api/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'create failed');
    return r.json();
  },
  async renameCategory(oldName, newName) {
    const r = await fetch(`/api/categories/${encodeURIComponent(oldName)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'rename failed');
    return r.json();
  },
  async deleteCategory(name, opts = {}) {
    const u = new URL(`/api/categories/${encodeURIComponent(name)}`, location.origin);
    if (opts.clearItems) u.searchParams.set('clearItems', 'true');
    if (opts.reassignTo) u.searchParams.set('reassignTo', opts.reassignTo);
    const r = await fetch(u, { method: 'DELETE' });
    if (!r.ok && r.status !== 204) {
      const body = await r.json().catch(() => ({}));
      const err = new Error(body.error || 'delete failed');
      err.status = r.status; err.body = body;
      throw err;
    }
  },
};

// --- element references --------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const els = {
  list: $('#itemList'),
  empty: $('#emptyMsg'),
  search: $('#search'),
  categoryFilter: $('#categoryFilter'),
  lowOnly: $('#lowOnly'),
  stats: $('#stats'),
  addBtn: $('#addBtn'),
  toast: $('#toast'),
  itemModal: $('#itemModal'),
  itemForm: $('#itemForm'),
  itemTitle: $('#itemModalTitle'),
  formScanBtn: $('#formScanBtn'),
  formBarcode: $('#formBarcode'),
  imagePreview: $('#imagePreview'),
  imageClear: $('#imageClear'),
  imageUrlInput: $('#imageUrlInput'),
  categorySelect: $('#categorySelect'),
  packageSizeLabel: $('#packageSizeLabel'),
  manageBtn: $('#manageCategoriesBtn'),
  categoriesModal: $('#categoriesModal'),
  categoriesList: $('#categoriesList'),
  newCategoryInput: $('#newCategoryInput'),
  addCategoryBtn: $('#addCategoryBtn'),
  detailModal: $('#detailModal'),
  detailContent: $('#detailContent'),
  scanModal: $('#scanModal'),
  scanVideo: $('#scanVideo'),
  scanStatus: $('#scanStatus'),
};

const state = { editingId: null, scanControls: null, categories: new Set(DEFAULT_CATEGORIES) };

// --- utilities ----------------------------------------------------------

function toast(msg, type = 'info') {
  els.toast.textContent = msg;
  els.toast.className = 'toast' + (type === 'error' ? ' error' : '');
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.hidden = true; }, 2800);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function cardStatus(item) {
  if (Number(item.quantity) <= 0) return 'out';
  if (Number(item.quantity) <= Number(item.minQuantity)) return 'low';
  return '';
}

// Wire up [data-close] buttons and backdrop clicks for all dialogs.
function setupDialogDismissal() {
  document.querySelectorAll('dialog.modal').forEach((dlg) => {
    dlg.addEventListener('click', (ev) => {
      // Backdrop click: target === dialog itself (click outside the form/article).
      if (ev.target === dlg) dlg.close();
    });
    dlg.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => dlg.close());
    });
  });
}

// --- card rendering -----------------------------------------------------

function renderCard(item) {
  const status = cardStatus(item);
  const badge = status === 'out'
    ? '<span class="badge out">Out</span>'
    : status === 'low' ? '<span class="badge">Low</span>' : '';
  const img = item.imageUrl
    ? `<img src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : '';
  const meta = [item.brand, item.packageSize].filter(Boolean).map(escapeHtml).join(' · ');
  const predict = item.usage && item.usage.perDay
    ? `<div class="predict">~${item.usage.perDay}/day · ${item.usage.daysRemaining} day(s) left</div>`
    : '';

  const el = document.createElement('div');
  el.className = `card ${status}`;
  el.dataset.id = item.id;
  el.innerHTML = `
    ${img}
    <div class="body">
      <span class="name">${escapeHtml(item.name)}${badge}</span>
      <span class="meta">${meta || escapeHtml(item.category || '')}</span>
      <div class="qty"><strong>${item.quantity}</strong>
        <span class="meta"> / min ${item.minQuantity}</span>
      </div>
      ${predict}
    </div>
    <div class="controls">
      <button class="plus"  data-act="plus"  aria-label="Increase">+1</button>
      <button class="minus" data-act="minus" aria-label="Decrease">-1</button>
    </div>
  `;

  el.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (btn) {
      ev.stopPropagation();
      handleAdjust(item.id, btn.dataset.act === 'plus' ? 1 : -1);
    } else {
      openDetail(item.id);
    }
  });
  return el;
}

async function refresh() {
  const items = await api.list({
    q: els.search.value.trim(),
    low: els.lowOnly.checked ? '1' : '',
    category: els.categoryFilter.value,
  });
  els.list.innerHTML = '';
  if (!items.length) {
    els.empty.hidden = false;
  } else {
    els.empty.hidden = true;
    const frag = document.createDocumentFragment();
    items.forEach((it) => frag.appendChild(renderCard(it)));
    els.list.appendChild(frag);
  }

  const s = await api.stats();
  els.stats.innerHTML = `
    <span class="pill">${s.total} tracked</span>
    ${s.low ? `<span class="pill low">${s.low} low</span>` : ''}
    ${s.out ? `<span class="pill out">${s.out} out</span>` : ''}
  `;
}

async function handleAdjust(id, delta) {
  try {
    await api.adjust(id, delta, delta < 0 ? 'consumed' : 'purchased');
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// --- categories ---------------------------------------------------------

async function refreshCategories() {
  const remote = await api.categories();
  remote.forEach((c) => state.categories.add(c));
  const sorted = [...state.categories].sort((a, b) => a.localeCompare(b));

  // Form select: known categories + "— none —" + "➕ Add new…"
  const selectPrev = els.categorySelect.value;
  els.categorySelect.innerHTML =
    '<option value="">— none —</option>' +
    sorted.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('') +
    '<option value="__new__">➕ Add new category…</option>';
  if (selectPrev && sorted.includes(selectPrev)) els.categorySelect.value = selectPrev;

  // Toolbar filter: just the known categories.
  const filterPrev = els.categoryFilter.value;
  els.categoryFilter.innerHTML =
    '<option value="">All categories</option>' +
    sorted.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  if (filterPrev && sorted.includes(filterPrev)) els.categoryFilter.value = filterPrev;
}

// Selecting "Add new…" in the dropdown prompts for a fresh name and
// inserts it into the list. Cancelling reverts to whatever was selected
// before.
let lastCategoryValue = '';
els.categorySelect?.addEventListener('focus', () => {
  lastCategoryValue = els.categorySelect.value;
});
els.categorySelect?.addEventListener('change', async () => {
  if (els.categorySelect.value !== '__new__') {
    lastCategoryValue = els.categorySelect.value;
    return;
  }
  const name = (prompt('New category name:') || '').trim();
  if (!name) {
    els.categorySelect.value = lastCategoryValue;
    return;
  }
  state.categories.add(name);
  await refreshCategories();
  els.categorySelect.value = name;
  lastCategoryValue = name;
});

// --- image handling -----------------------------------------------------

// Resize an image File down to max 640px on the long side and return a
// JPEG data URL. Keeps payloads small enough to stash as text in D1.
async function fileToResizedDataUrl(file) {
  const img = new Image();
  img.src = URL.createObjectURL(file);
  try { await img.decode(); } catch { /* some Safari versions */ }
  const maxDim = 640;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.82);
  URL.revokeObjectURL(img.src);
  return url;
}

function showImage(url) {
  if (url) {
    els.imagePreview.innerHTML = `<img src="${escapeHtml(url)}" alt="">`;
    els.imageClear.hidden = false;
  } else {
    els.imagePreview.innerHTML = '<span class="placeholder">No image</span>';
    els.imageClear.hidden = true;
  }
  els.imageUrlInput.value = url || '';
}

async function handleImageFile(file) {
  if (!file) return;
  try {
    const dataUrl = await fileToResizedDataUrl(file);
    showImage(dataUrl);
  } catch (err) {
    toast('Could not read image: ' + err.message, 'error');
  }
}

// --- add/edit modal -----------------------------------------------------

function openItemForm(prefill = {}, editingId = null) {
  state.editingId = editingId;
  els.itemTitle.textContent = editingId ? 'Edit item' : 'Add item';
  const form = els.itemForm;
  form.reset();

  // Make sure a prefilled category exists as an option before we try to
  // select it - scans can introduce categories we've never seen before.
  if (prefill.category && !state.categories.has(prefill.category)) {
    state.categories.add(prefill.category);
    refreshCategories();
  }

  for (const [k, v] of Object.entries(prefill)) {
    if (form.elements[k] && v != null) form.elements[k].value = v;
  }
  lastCategoryValue = els.categorySelect.value;

  // Barcode is never a typed input; show it as a chip when we have one.
  const barcode = prefill.barcode || '';
  if (barcode) {
    els.formBarcode.hidden = false;
    els.formBarcode.innerHTML = `<span class="label">Barcode</span><span class="value">${escapeHtml(barcode)}</span>`;
    els.formBarcode.dataset.value = barcode;
  } else {
    els.formBarcode.hidden = true;
    els.formBarcode.dataset.value = '';
  }

  // Package size: only show when populated (from OFF lookup).
  if (prefill.packageSize) {
    els.packageSizeLabel.hidden = false;
  } else {
    els.packageSizeLabel.hidden = true;
  }

  showImage(prefill.imageUrl || '');

  els.itemModal.showModal();
}

els.addBtn.addEventListener('click', () => openItemForm());

els.imageClear.addEventListener('click', () => showImage(''));

// Both file inputs (capture=environment and plain) funnel to the same handler.
els.itemForm.querySelectorAll('input[type=file]').forEach((input) => {
  input.addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (file) await handleImageFile(file);
    ev.target.value = ''; // allow re-selecting the same file
  });
});

els.itemForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(els.itemForm);
  const body = {
    name:        fd.get('name'),
    brand:       fd.get('brand'),
    category:    fd.get('category'),
    quantity:    fd.get('quantity'),
    minQuantity: fd.get('minQuantity'),
    imageUrl:    fd.get('imageUrl'),
    packageSize: fd.get('packageSize') || null,
    barcode:     els.formBarcode.dataset.value || null,
  };
  ['quantity', 'minQuantity'].forEach((k) => {
    body[k] = body[k] === '' || body[k] == null ? undefined : Number(body[k]);
  });
  for (const k of Object.keys(body)) if (body[k] === '') body[k] = null;

  try {
    if (state.editingId) {
      await api.update(state.editingId, body);
      toast('Item updated');
    } else {
      await api.create(body);
      toast('Item added');
    }
    els.itemModal.close();
    if (body.category) state.categories.add(body.category);
    await refreshCategories();
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// "Scan barcode" button inside the Add-Item form. Launches the scanner;
// on success we come back to the same form with fields populated.
els.formScanBtn.addEventListener('click', () => startScanner({ fromForm: true }));

// --- detail modal -------------------------------------------------------

async function openDetail(id) {
  const item = await api.get(id);
  const history = await api.usage(id);

  const img = item.imageUrl
    ? `<img src="${escapeHtml(item.imageUrl)}" alt="" onerror="this.style.display='none'">`
    : '';
  const rows = history.map((h) => {
    const sign = h.delta > 0 ? '+' : '';
    const cls = h.delta > 0 ? 'pos' : 'neg';
    const when = new Date(h.createdAt + 'Z').toLocaleString();
    return `<tr>
      <td>${escapeHtml(when)}</td>
      <td class="delta ${cls}">${sign}${h.delta}</td>
      <td>${escapeHtml(h.reason)}</td>
      <td>${escapeHtml(h.note || '')}</td>
    </tr>`;
  }).join('');

  const usage = item.usage
    ? `<div><span>Usage rate</span><strong>${item.usage.perDay}/day</strong></div>
       <div><span>Est. days left</span><strong>${item.usage.daysRemaining}</strong></div>`
    : `<div><span>Usage rate</span><strong>—</strong></div>
       <div><span>Est. days left</span><strong>—</strong></div>`;

  els.detailContent.innerHTML = `
    <div class="detail-hd">
      ${img}
      <div>
        <h2>${escapeHtml(item.name)}</h2>
        <div class="meta">${[item.brand, item.category, item.packageSize].filter(Boolean).map(escapeHtml).join(' · ') || '&nbsp;'}</div>
        ${item.barcode ? `<div class="meta">Barcode: ${escapeHtml(item.barcode)}</div>` : ''}
      </div>
    </div>
    <div class="detail-grid">
      <div><span>On hand</span><strong>${item.quantity}</strong></div>
      <div><span>Reorder at</span><strong>${item.minQuantity}</strong></div>
      ${usage}
    </div>
    <div class="detail-actions">
      <button data-act="buy">Bought 1</button>
      <button data-act="use">Used 1</button>
      <button data-act="adjust">Set quantity…</button>
      <button data-act="edit">Edit</button>
      <button class="danger" data-act="delete">Delete</button>
    </div>
    <div class="history">
      <table>
        <thead><tr><th>When</th><th>Δ</th><th>Reason</th><th>Note</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">No history yet</td></tr>'}</tbody>
      </table>
    </div>
  `;

  els.detailContent.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => handleDetailAction(item, btn.dataset.act));
  });
  els.detailModal.showModal();
}

async function handleDetailAction(item, act) {
  try {
    if (act === 'buy')  { await api.adjust(item.id,  1, 'purchased'); toast('+1 purchased'); }
    if (act === 'use')  { await api.adjust(item.id, -1, 'consumed');  toast('-1 consumed'); }
    if (act === 'adjust') {
      const raw = prompt(`Set new quantity for "${item.name}"`, String(item.quantity));
      if (raw == null) return;
      const target = Number(raw);
      if (!Number.isFinite(target) || target < 0) { toast('Invalid number', 'error'); return; }
      const delta = target - Number(item.quantity);
      if (delta !== 0) await api.adjust(item.id, delta, 'adjustment', 'Manual set');
    }
    if (act === 'edit') {
      els.detailModal.close();
      openItemForm({
        barcode: item.barcode, name: item.name, brand: item.brand,
        category: item.category,
        minQuantity: item.minQuantity, packageSize: item.packageSize,
        imageUrl: item.imageUrl,
      }, item.id);
      return;
    }
    if (act === 'delete') {
      if (!confirm(`Delete "${item.name}"? This also removes its history.`)) return;
      await api.remove(item.id);
      toast('Deleted');
      els.detailModal.close();
      await refresh();
      return;
    }
    await openDetail(item.id);
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// --- search / filter ----------------------------------------------------

let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 180);
});
els.categoryFilter.addEventListener('change', refresh);
els.lowOnly.addEventListener('change', refresh);

// --- barcode scanning ---------------------------------------------------

function stopScanner() {
  if (state.scanControls) { state.scanControls.stop(); state.scanControls = null; }
}

async function startScanner({ fromForm = false } = {}) {
  if (!window.ZXingBrowser) {
    toast('Scanner library not loaded', 'error');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Camera API not available (needs HTTPS or localhost)', 'error');
    return;
  }

  // If we were launched from the Add Item form, hide it while the scanner
  // is visible so iOS doesn't render both dialogs stacked awkwardly.
  const reopenFormAfter = fromForm;
  if (fromForm && els.itemModal.open) {
    els.itemModal.close();
  }

  els.scanModal.showModal();
  els.scanStatus.textContent = 'Starting camera…';

  const reader = new ZXingBrowser.BrowserMultiFormatReader();

  // facingMode: environment lets the OS pick the appropriate rear camera.
  // Avoids the "Invalid constraint" error from passing explicit deviceIds
  // on iOS, and also gives users the system-level camera experience.
  try {
    state.scanControls = await reader.decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' } } },
      els.scanVideo,
      (result, _err, controls) => {
        if (result) {
          controls.stop();
          handleScanned(result.getText(), { reopenFormAfter });
        }
      },
    );
    els.scanStatus.textContent = 'Point the camera at a barcode.';
  } catch (err) {
    els.scanStatus.textContent = 'Camera error: ' + err.message;
  }
}

async function handleScanned(barcode, { reopenFormAfter = false } = {}) {
  els.scanStatus.textContent = `Found ${barcode}. Looking up…`;
  try {
    const { body } = await api.lookup(barcode);
    stopScanner();
    els.scanModal.close();

    if (body.source === 'local' && body.item) {
      // Already tracked: bump it by 1 as a purchase.
      await api.adjust(body.item.id, 1, 'purchased', 'Scanned');
      toast(`${body.item.name}: +1 purchased`);
      await refresh();
      return;
    }

    const suggestion = body.suggestion || { barcode };
    openItemForm({
      barcode: suggestion.barcode || barcode,
      name: suggestion.name || '',
      brand: suggestion.brand || '',
      category: suggestion.category || '',
      packageSize: suggestion.packageSize || '',
      imageUrl: suggestion.imageUrl || '',
      quantity: 1,
      minQuantity: 1,
    });

    if (!suggestion.name) toast('No product data found — fill in the name', 'error');
  } catch (err) {
    els.scanStatus.textContent = 'Lookup error: ' + err.message;
    if (reopenFormAfter) {
      setTimeout(() => {
        els.scanModal.close();
        openItemForm({ barcode });
      }, 1200);
    }
  }
}

els.scanModal.addEventListener('close', stopScanner);

// --- manage categories --------------------------------------------------

async function openManageCategories() {
  els.categoriesModal.showModal();
  els.newCategoryInput.value = '';
  await renderManageList();
}

async function renderManageList() {
  const rows = await api.categoriesManage();
  if (!rows.length) {
    els.categoriesList.innerHTML = '<li class="empty-row">No categories yet.</li>';
    return;
  }
  els.categoriesList.innerHTML = rows.map((r) => `
    <li data-name="${escapeHtml(r.name)}" class="${r.managed ? '' : 'orphan'}">
      <div class="cat-main">
        <span class="cat-name">${escapeHtml(r.name)}</span>
        <span class="cat-count">${r.count} item${r.count === 1 ? '' : 's'}${r.managed ? '' : ' · unmanaged'}</span>
      </div>
      <div class="cat-actions">
        <button type="button" data-act="rename" aria-label="Rename ${escapeHtml(r.name)}">Rename</button>
        <button type="button" data-act="delete" class="danger" aria-label="Delete ${escapeHtml(r.name)}">Delete</button>
      </div>
    </li>
  `).join('');
  els.categoriesList.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const li = btn.closest('li');
      const name = li.dataset.name;
      if (btn.dataset.act === 'rename') handleRenameCategory(name);
      if (btn.dataset.act === 'delete') handleDeleteCategory(name);
    });
  });
}

async function handleAddCategory() {
  const name = (els.newCategoryInput.value || '').trim();
  if (!name) return;
  try {
    await api.createCategory(name);
    els.newCategoryInput.value = '';
    toast(`Added "${name}"`);
    await renderManageList();
    await refreshCategories();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function handleRenameCategory(oldName) {
  const newName = (prompt(`Rename "${oldName}" to:`, oldName) || '').trim();
  if (!newName || newName === oldName) return;
  try {
    await api.renameCategory(oldName, newName);
    toast(`Renamed to "${newName}"`);
    await renderManageList();
    await refreshCategories();
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function handleDeleteCategory(name) {
  try {
    // First try a plain delete. The server returns 409 with a count if
    // items still use it, and we ask the user what to do.
    try {
      await api.deleteCategory(name);
    } catch (err) {
      if (err.status !== 409) throw err;
      const count = err.body?.count || 0;
      const choice = prompt(
        `"${name}" is used by ${count} item${count === 1 ? '' : 's'}. ` +
        `Type a category name to reassign them to, leave blank to uncategorize, or type "cancel" to abort:`,
        '',
      );
      if (choice == null) return;
      const trimmed = choice.trim();
      if (trimmed.toLowerCase() === 'cancel') return;
      if (trimmed) {
        await api.deleteCategory(name, { reassignTo: trimmed });
      } else {
        await api.deleteCategory(name, { clearItems: true });
      }
    }
    toast(`Deleted "${name}"`);
    state.categories.delete(name);
    await renderManageList();
    await refreshCategories();
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

els.manageBtn.addEventListener('click', openManageCategories);
els.addCategoryBtn.addEventListener('click', handleAddCategory);
els.newCategoryInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); handleAddCategory(); }
});

// --- boot ---------------------------------------------------------------

setupDialogDismissal();
refreshCategories();
refresh().catch((err) => toast(err.message, 'error'));
