// Household Stock Taker - frontend
// Uses @zxing/browser (loaded via /vendor/*) for camera barcode scanning.

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
};

// --- UI plumbing --------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const els = {
  list: $('#itemList'),
  empty: $('#emptyMsg'),
  search: $('#search'),
  lowOnly: $('#lowOnly'),
  stats: $('#stats'),
  addBtn: $('#addBtn'),
  scanBtn: $('#scanBtn'),
  toast: $('#toast'),
  itemModal: $('#itemModal'),
  itemForm: $('#itemForm'),
  itemTitle: $('#itemModalTitle'),
  itemCancel: $('#itemCancel'),
  detailModal: $('#detailModal'),
  detailContent: $('#detailContent'),
  detailClose: $('#detailClose'),
  scanModal: $('#scanModal'),
  scanVideo: $('#scanVideo'),
  scanStatus: $('#scanStatus'),
  scanCamera: $('#scanCamera'),
  scanClose: $('#scanClose'),
};

let state = { editingId: null, scanner: null, scanControls: null };

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
      <div class="qty"><strong>${item.quantity}</strong> ${escapeHtml(item.unit || '')}
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

// --- add/edit modal ------------------------------------------------------

function openItemForm(prefill = {}, editingId = null) {
  state.editingId = editingId;
  els.itemTitle.textContent = editingId ? 'Edit item' : 'Add item';
  const form = els.itemForm;
  form.reset();
  for (const [k, v] of Object.entries(prefill)) {
    if (form.elements[k] && v != null) form.elements[k].value = v;
  }
  els.itemModal.showModal();
  form.elements.name.focus();
}

els.addBtn.addEventListener('click', () => openItemForm());
els.itemCancel.addEventListener('click', () => els.itemModal.close());

els.itemForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(els.itemForm);
  const body = Object.fromEntries(fd.entries());
  ['quantity', 'minQuantity'].forEach((k) => {
    if (body[k] === '' || body[k] == null) delete body[k];
    else body[k] = Number(body[k]);
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
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// --- detail modal --------------------------------------------------------

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
      <div><span>On hand</span><strong>${item.quantity} ${escapeHtml(item.unit)}</strong></div>
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
    ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ''}
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

els.detailClose.addEventListener('click', () => els.detailModal.close());

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
        category: item.category, unit: item.unit,
        minQuantity: item.minQuantity, packageSize: item.packageSize,
        imageUrl: item.imageUrl, notes: item.notes,
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

// --- search --------------------------------------------------------------

let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 180);
});
els.lowOnly.addEventListener('change', refresh);

// --- barcode scanning ----------------------------------------------------

async function populateCameras() {
  try {
    const devices = await ZXingBrowser.BrowserCodeReader.listVideoInputDevices();
    const prev = els.scanCamera.value;
    els.scanCamera.innerHTML = '';
    devices.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Camera ${i + 1}`;
      // Prefer rear-facing camera on mobile.
      if (/back|rear|environment/i.test(d.label)) o.selected = true;
      els.scanCamera.appendChild(o);
    });
    if (prev && [...els.scanCamera.options].some((o) => o.value === prev)) {
      els.scanCamera.value = prev;
    }
  } catch (err) {
    els.scanStatus.textContent = 'Camera unavailable: ' + err.message;
  }
}

async function startScanner() {
  if (!window.ZXingBrowser) {
    toast('Scanner library not loaded', 'error');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Camera API not available (needs HTTPS or localhost)', 'error');
    return;
  }

  els.scanModal.showModal();
  els.scanStatus.textContent = 'Starting camera…';

  const reader = new ZXingBrowser.BrowserMultiFormatReader();
  state.scanner = reader;

  const onResult = (result, _err, controls) => {
    if (result) {
      controls.stop();
      handleScanned(result.getText());
    }
  };

  // First start uses facingMode rather than a deviceId. iOS Safari returns
  // placeholder/empty deviceIds before camera permission has been granted,
  // and passing one of those to decodeFromVideoDevice throws "Invalid
  // constraint". facingMode sidesteps that and lets the browser pick the
  // rear camera.
  try {
    state.scanControls = await reader.decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' } } },
      els.scanVideo,
      onResult,
    );
    els.scanStatus.textContent = 'Point the camera at a barcode.';
  } catch (err) {
    els.scanStatus.textContent = 'Camera error: ' + err.message;
    return;
  }

  // Permission is now granted, so device labels are available - refresh
  // the picker and wire up switching between cameras.
  await populateCameras();
  els.scanCamera.onchange = async () => {
    const deviceId = els.scanCamera.value;
    if (!deviceId) return;
    if (state.scanControls) { state.scanControls.stop(); state.scanControls = null; }
    els.scanStatus.textContent = 'Switching camera…';
    try {
      state.scanControls = await reader.decodeFromVideoDevice(deviceId, els.scanVideo, onResult);
      els.scanStatus.textContent = 'Point the camera at a barcode.';
    } catch (err) {
      els.scanStatus.textContent = 'Camera error: ' + err.message;
    }
  };
}

function stopScanner() {
  if (state.scanControls) { state.scanControls.stop(); state.scanControls = null; }
  state.scanner = null;
}

async function handleScanned(barcode) {
  els.scanStatus.textContent = `Found ${barcode}. Looking up…`;
  try {
    const { body } = await api.lookup(barcode);
    els.scanModal.close();
    stopScanner();

    if (body.source === 'local' && body.item) {
      // Already tracked - bump by 1 (purchased)
      await api.adjust(body.item.id, 1, 'purchased', 'Scanned');
      toast(`${body.item.name}: +1 purchased`);
      await refresh();
      return;
    }

    const suggestion = body.suggestion || { barcode };
    if (!suggestion.name) suggestion.name = '';
    openItemForm({
      barcode: suggestion.barcode,
      name: suggestion.name,
      brand: suggestion.brand || '',
      category: suggestion.category || '',
      packageSize: suggestion.packageSize || '',
      imageUrl: suggestion.imageUrl || '',
      quantity: 1,
      minQuantity: 1,
    });

    if (!suggestion.name) toast('No product data found — fill in manually', 'error');
  } catch (err) {
    els.scanStatus.textContent = 'Lookup error: ' + err.message;
  }
}

els.scanBtn.addEventListener('click', startScanner);
els.scanClose.addEventListener('click', () => { stopScanner(); els.scanModal.close(); });
els.scanModal.addEventListener('close', stopScanner);

// --- boot ----------------------------------------------------------------

refresh().catch((err) => toast(err.message, 'error'));
