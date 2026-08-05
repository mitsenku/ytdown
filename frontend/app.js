/**
 * app.js — YT-DLP Web Interface
 *
 * Features:
 *  - YouTube search or direct URL fetch
 *  - Dynamic Light/Dark Theme Switcher with localStorage persistence
 *  - Per-video format, mode, and quality customization for multi-select downloads
 *  - Single video format/quality selection
 *  - SSE progress tracking with cancellation support
 *  - Download history with auto-delete
 *  - All events bound via addEventListener (no inline onclick)
 */

// ── State ────────────────────────────────────────────────────────────
const API = '';
let currentMode = 'video';
let currentTaskId = null;
let currentVideoUrl = '';
let eventSource = null;

// Map: url -> { url, title, thumbnail, channel, mode, quality, format }
const selectedVideos = new Map();

// ── Format Options ───────────────────────────────────────────────────
const FORMAT_OPTIONS = {
  video: {
    quality: [
      { value: 'best',  label: '🏆 Best Available' },
      { value: '1080',  label: '1080p (Full HD)' },
      { value: '720',   label: '720p (HD)' },
      { value: '480',   label: '480p (SD)' },
      { value: '360',   label: '360p (Low)' },
    ],
    format: [
      { value: 'mp4',  label: 'MP4' },
      { value: 'mkv',  label: 'MKV' },
      { value: 'webm', label: 'WebM' },
    ],
  },
  audio: {
    quality: [
      { value: 'best', label: '🏆 Best Available' },
      { value: '320',  label: '320 kbps' },
      { value: '256',  label: '256 kbps' },
      { value: '192',  label: '192 kbps' },
      { value: '128',  label: '128 kbps' },
    ],
    format: [
      { value: 'mp3',  label: 'MP3' },
      { value: 'aac',  label: 'AAC' },
      { value: 'flac', label: 'FLAC' },
      { value: 'wav',  label: 'WAV' },
      { value: 'opus', label: 'Opus' },
    ],
  },
};

// ── Init — All Event Bindings ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  populateSelects();
  loadHistory();

  // Input
  const urlInput = document.getElementById('urlInput');
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSubmit();
  });

  // Buttons
  document.getElementById('fetchBtn').addEventListener('click', handleSubmit);
  document.getElementById('downloadBtn').addEventListener('click', startDownload);
  document.getElementById('cancelBtn').addEventListener('click', cancelDownload);
  document.getElementById('saveFileBtn').addEventListener('click', saveFile);
  document.getElementById('newDownloadBtn').addEventListener('click', resetUI);
  document.getElementById('tryAgainBtn').addEventListener('click', resetUI);
  document.getElementById('startOverBtn').addEventListener('click', resetUI);

  // Mode toggle
  document.getElementById('modeVideo').addEventListener('click', () => setMode('video'));
  document.getElementById('modeAudio').addEventListener('click', () => setMode('audio'));

  // Batch controls
  document.getElementById('selectAllCheckbox').addEventListener('change', toggleSelectAll);
  document.getElementById('batchDownloadBtn').addEventListener('click', executeBatchDownload);

  // Event delegation for search results (checkboxes, select buttons, per-item options)
  const searchList = document.getElementById('searchList');
  searchList.addEventListener('click', handleSearchListClick);
  searchList.addEventListener('change', handleSearchListChange);

  // Event delegation for history save buttons
  document.getElementById('historyList').addEventListener('click', handleHistoryClick);
});

// ── Theme Switcher ───────────────────────────────────────────────────
function initTheme() {
  const savedTheme = localStorage.getItem('yt_theme') ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  setTheme(savedTheme);

  const themeBtn = document.getElementById('themeToggleBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      setTheme(next);
      localStorage.setItem('yt_theme', next);
    });
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('themeToggleIcon');
  const text = document.getElementById('themeToggleText');
  if (icon && text) {
    if (theme === 'light') {
      icon.textContent = '☀️';
      text.textContent = 'Light';
    } else {
      icon.textContent = '🌙';
      text.textContent = 'Dark';
    }
  }
}

// ── URL vs Search ────────────────────────────────────────────────────
function isUrl(str) {
  return /^(https?:\/\/|www\.)/.test(str) || /youtu\.?be/.test(str);
}

// ── Handle Submit ────────────────────────────────────────────────────
async function handleSubmit() {
  const input = document.getElementById('urlInput').value.trim();
  if (!input) {
    showToast('Please enter a URL or search query', 'error');
    return;
  }
  if (isUrl(input)) {
    await fetchInfo(input);
  } else {
    await searchVideos(input);
  }
}

// ── Search YouTube ───────────────────────────────────────────────────
async function searchVideos(query) {
  const btn = document.getElementById('fetchBtn');
  const btnText = document.getElementById('fetchBtnText');
  btn.disabled = true;
  btnText.innerHTML = '<span class="spinner"></span> Searching...';
  hideAll();
  selectedVideos.clear();
  updateBatchBar();

  try {
    const res = await fetch(`${API}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed');
    renderSearchResults(data.results || []);
    show('searchResults');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btnText.innerHTML = '🔍 Go';
  }
}

// ── Render Search Results with Per-Item Format Options ──────────────
function renderSearchResults(results) {
  const list = document.getElementById('searchList');
  const count = document.getElementById('searchCount');
  count.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;

  if (!results.length) {
    list.innerHTML = `<li class="history-empty"><div class="history-empty__icon"><svg class="svg-icon svg-icon--lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div><div>No results found</div></li>`;
    return;
  }

  list.innerHTML = results.map((item, index) => {
    const itemUrl = escapeAttr(item.url);
    return `
    <li class="search-item" data-url="${itemUrl}" data-title="${escapeAttr(item.title)}"
        data-thumb="${escapeAttr(item.thumbnail || '')}" data-duration="${item.duration || ''}"
        data-channel="${escapeAttr(item.channel || '')}" data-views="${item.view_count || ''}">
      <div class="search-item__header">
        <label class="neo-checkbox search-item__checkbox">
          <input type="checkbox" class="search-checkbox" data-url="${itemUrl}">
          <span class="neo-checkbox__mark"></span>
        </label>
        <div class="search-item__thumb">
          <img src="${item.thumbnail || ''}" alt="${escapeHtml(item.title)}" loading="lazy">
          ${item.duration ? `<span class="search-item__duration">${formatDuration(item.duration)}</span>` : ''}
        </div>
        <div class="search-item__info">
          <div class="search-item__title">${escapeHtml(item.title)}</div>
          <div class="search-item__channel">${escapeHtml(item.channel || 'Unknown')}</div>
          <div class="search-item__views">${item.view_count ? formatViews(item.view_count) + ' views' : ''}</div>
        </div>
        <div class="search-item__actions">
          <button class="btn btn--primary btn--sm search-select-btn" data-url="${itemUrl}">
            <svg class="svg-icon svg-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>Inspect</span>
          </button>
        </div>
      </div>

      <!-- Inline Custom Dropdown options per video -->
      <div class="search-item__options" id="item-options-${index}">
        <div class="item-opt-group">
          <label>Type</label>
          <div id="item-type-dropdown-${index}" class="und-dropdown"></div>
        </div>
        <div class="item-opt-group">
          <label>Quality</label>
          <div id="item-quality-dropdown-${index}" class="und-dropdown"></div>
        </div>
        <div class="item-opt-group">
          <label>Format</label>
          <div id="item-format-dropdown-${index}" class="und-dropdown"></div>
        </div>
      </div>
    </li>
  `}).join('');

  // Render per-item custom dropdown components
  results.forEach((item, index) => {
    const itemState = { mode: 'video', quality: 'best', format: 'mp4' };
    
    function updateItemDropdowns() {
      const opts = FORMAT_OPTIONS[itemState.mode];
      renderUndDropdown(`item-type-dropdown-${index}`, [
        { value: 'video', label: 'Video' },
        { value: 'audio', label: 'Audio' }
      ], itemState.mode, (val) => {
        itemState.mode = val;
        itemState.format = val === 'audio' ? 'mp3' : 'mp4';
        updateItemDropdowns();
        syncSelectedItem();
      });

      renderUndDropdown(`item-quality-dropdown-${index}`, opts.quality, itemState.quality, (val) => {
        itemState.quality = val;
        syncSelectedItem();
      });

      renderUndDropdown(`item-format-dropdown-${index}`, opts.format, itemState.format, (val) => {
        itemState.format = val;
        syncSelectedItem();
      });
    }

    function syncSelectedItem() {
      const checkbox = document.querySelector(`.search-checkbox[data-url="${CSS.escape(item.url)}"]`);
      if (checkbox && checkbox.checked) {
        selectedVideos.set(item.url, {
          url: item.url,
          title: item.title,
          thumbnail: item.thumbnail,
          channel: item.channel,
          mode: itemState.mode,
          quality: itemState.quality,
          format: itemState.format,
        });
      }
    }

    updateItemDropdowns();
  });
}

// ── Event Delegation: Search List Click ──────────────────────────────
function handleSearchListClick(e) {
  const btn = e.target.closest('.search-select-btn');
  if (btn) {
    e.stopPropagation();
    const url = btn.dataset.url;
    selectSearchResult(url);
    return;
  }
}

// ── Event Delegation: Search List Checkbox & Select Changes ──────────
function handleSearchListChange(e) {
  const target = e.target;
  if (target.classList.contains('search-checkbox')) {
    const item = target.closest('.search-item');
    const url = target.dataset.url;
    if (target.checked) {
      const index = Array.from(document.querySelectorAll('.search-item')).indexOf(item);
      const typeBtn = item.querySelector(`#item-type-dropdown-${index} .und-dropdown-button span`);
      const qualityBtn = item.querySelector(`#item-quality-dropdown-${index} .und-dropdown-button span`);
      const formatBtn = item.querySelector(`#item-format-dropdown-${index} .und-dropdown-button span`);

      const mode = typeBtn?.textContent.toLowerCase().includes('audio') ? 'audio' : 'video';
      const qualityLabel = qualityBtn?.textContent.trim() || '';
      const formatLabel = formatBtn?.textContent.trim() || '';
      const opts = FORMAT_OPTIONS[mode];
      const quality = (opts.quality.find(o => o.label === qualityLabel) || opts.quality[0]).value;
      const format = (opts.format.find(o => o.label === formatLabel) || opts.format[0]).value;

      selectedVideos.set(url, {
        url,
        title: item.dataset.title,
        thumbnail: item.dataset.thumb,
        channel: item.dataset.channel,
        mode,
        quality,
        format,
      });
      item.classList.add('selected');
    } else {
      selectedVideos.delete(url);
      item.classList.remove('selected');
    }
    updateBatchBar();
  }
}

// ── Select All / Deselect All ────────────────────────────────────────
function toggleSelectAll(e) {
  const checked = e.target.checked;
  const allItems = document.querySelectorAll('.search-item');
  const checkboxes = document.querySelectorAll('.search-checkbox');
  checkboxes.forEach(cb => {
    if (cb.checked !== checked) {
      cb.checked = checked;
      const item = cb.closest('.search-item');
      const url = cb.dataset.url;
      if (checked) {
        const index = Array.from(allItems).indexOf(item);
        const typeBtn = item.querySelector(`#item-type-dropdown-${index} .und-dropdown-button span`);
        const qualityBtn = item.querySelector(`#item-quality-dropdown-${index} .und-dropdown-button span`);
        const formatBtn = item.querySelector(`#item-format-dropdown-${index} .und-dropdown-button span`);

        const mode = typeBtn?.textContent.toLowerCase().includes('audio') ? 'audio' : 'video';
        const qualityLabel = qualityBtn?.textContent.trim() || '';
        const formatLabel = formatBtn?.textContent.trim() || '';
        const opts = FORMAT_OPTIONS[mode];
        const quality = (opts.quality.find(o => o.label === qualityLabel) || opts.quality[0]).value;
        const format = (opts.format.find(o => o.label === formatLabel) || opts.format[0]).value;

        selectedVideos.set(url, {
          url,
          title: item.dataset.title,
          thumbnail: item.dataset.thumb,
          channel: item.dataset.channel,
          mode,
          quality,
          format,
        });
        item.classList.add('selected');
      } else {
        selectedVideos.delete(url);
        item.classList.remove('selected');
      }
    }
  });
  updateBatchBar();
}

// ── Update Batch Action Bar ──────────────────────────────────────────
function updateBatchBar() {
  const count = selectedVideos.size;
  const countEl = document.getElementById('batchCount');
  if (countEl) countEl.textContent = `${count} selected`;
  const btn = document.getElementById('batchDownloadBtn');
  btn.disabled = count === 0;

  const bar = document.getElementById('batchBar');
  if (count > 0) {
    bar.classList.add('show');
  } else {
    bar.classList.remove('show');
  }
}

// ── Select Single Search Result → Fetch Info ─────────────────────────
async function selectSearchResult(url) {
  document.getElementById('urlInput').value = url;
  hide('searchResults');
  await fetchInfo(url);
}

// ── Fetch Video Info ─────────────────────────────────────────────────
async function fetchInfo(url) {
  if (!url) url = document.getElementById('urlInput').value.trim();
  if (!url) { showToast('Please paste a YouTube URL', 'error'); return; }

  const btn = document.getElementById('fetchBtn');
  const btnText = document.getElementById('fetchBtnText');
  btn.disabled = true;
  btnText.innerHTML = '<span class="spinner"></span> Fetching...';

  hide('videoPreview'); hide('formatSection'); hide('progressSection');
  hide('completeSection'); hide('errorSection'); hide('cancelledSection');
  hide('batchProgressSection');

  try {
    const res = await fetch(`${API}/api/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch video info');

    currentVideoUrl = url;
    renderVideoPreview(data);
    setMode(currentMode);
    hide('searchResults');
    show('videoPreview');
    show('formatSection');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btnText.innerHTML = '🔍 Go';
  }
}

// ── Render Video Preview ─────────────────────────────────────────────
function renderVideoPreview(info) {
  document.getElementById('videoThumb').src = info.thumbnail || '';
  document.getElementById('videoTitle').textContent = info.title || 'Unknown Title';
  document.getElementById('videoChannel').textContent = info.channel || 'Unknown Channel';
  document.getElementById('durationText').textContent = formatDuration(info.duration);
  document.getElementById('viewsText').textContent = formatViews(info.view_count);
}

// ── Mode Toggle ──────────────────────────────────────────────────────
function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-toggle__btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  populateSelects();
}

let selectedQuality = 'best';
let selectedFormat = 'mp4';

function populateSelects() {
  const opts = FORMAT_OPTIONS[currentMode];
  if (!opts.quality.some(o => o.value === selectedQuality)) selectedQuality = opts.quality[0].value;
  if (!opts.format.some(o => o.value === selectedFormat)) selectedFormat = opts.format[0].value;

  renderUndDropdown('qualityCustomDropdown', opts.quality, selectedQuality, (val) => {
    selectedQuality = val;
  });
  renderUndDropdown('formatCustomDropdown', opts.format, selectedFormat, (val) => {
    selectedFormat = val;
  });
}

// ── Start Single Download ────────────────────────────────────────────
async function startDownload() {
  if (!currentVideoUrl) return;
  const btn = document.getElementById('downloadBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Starting...';
  hide('errorSection');
  hide('cancelledSection');

  const mode = currentMode;
  const quality = selectedQuality;
  const format = selectedFormat;

  try {
    const res = await fetch(`${API}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: currentVideoUrl, mode: currentMode, quality, format }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start download');

    currentTaskId = data.task_id;
    hide('formatSection'); hide('videoPreview');
    document.getElementById('progressTitle').textContent = 'Downloading...';
    show('progressSection');
    document.getElementById('progressBar').style.width = '0%';
    document.getElementById('progressPercent').textContent = '0%';
    document.getElementById('progressStatus').textContent = 'Starting download...';
    document.getElementById('cancelBtn').disabled = false;
    listenProgress(currentTaskId);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '⬇️ Download';
  }
}

// ── Execute Batch Download with Per-Video Formats ────────────────────
async function executeBatchDownload() {
  if (selectedVideos.size === 0) { showToast('Select at least one video', 'error'); return; }

  const items = Array.from(selectedVideos.values());
  hide('searchResults');
  hide('formatSection');
  hide('videoPreview');
  show('batchProgressSection');

  const queue = document.getElementById('batchQueue');
  queue.innerHTML = items.map((info, i) => `
    <div class="batch-item" id="batch-${i}" data-url="${escapeAttr(info.url)}">
      <div class="batch-item__info">
        <span class="batch-item__num">${i + 1}</span>
        <div class="batch-item__text">
          <div class="batch-item__title">${escapeHtml(info.title)}</div>
          <div class="batch-item__fmt">${info.mode.toUpperCase()} · ${info.format.toUpperCase()} · ${info.quality}</div>
        </div>
      </div>
      <div class="batch-item__status" id="batch-status-${i}">⏳ Queued</div>
    </div>
  `).join('');

  // Download sequentially each with its custom format & quality settings
  for (let i = 0; i < items.length; i++) {
    const info = items[i];
    const statusEl = document.getElementById(`batch-status-${i}`);
    const itemEl = document.getElementById(`batch-${i}`);

    statusEl.textContent = '📥 Downloading...';
    statusEl.className = 'batch-item__status downloading';
    itemEl.classList.add('active');

    try {
      const res = await fetch(`${API}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: info.url,
          mode: info.mode,
          quality: info.quality,
          format: info.format,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      await waitForTask(data.task_id);
      const finalInfo = await getTaskStatus(data.task_id);

      if (finalInfo.status === 'done') {
        statusEl.textContent = '✅ Done';
        statusEl.className = 'batch-item__status done';
        window.open(`${API}/api/file/${data.task_id}`, '_blank');
      } else {
        statusEl.textContent = '❌ Failed';
        statusEl.className = 'batch-item__status failed';
      }
    } catch (err) {
      statusEl.textContent = '❌ Failed';
      statusEl.className = 'batch-item__status failed';
    }
    itemEl.classList.remove('active');
  }

  showToast(`Batch download complete (${items.length} videos)`, 'success');
  selectedVideos.clear();
  updateBatchBar();
  loadHistory();
}

// ── Wait for Task Status via SSE ─────────────────────────────────────
function waitForTask(taskId) {
  return new Promise((resolve) => {
    const es = new EventSource(`${API}/api/progress/${taskId}`);
    es.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.status === 'done' || data.status === 'error' || data.status === 'cancelled') {
        es.close();
        resolve(data);
      }
    };
    es.onerror = () => { es.close(); resolve({ status: 'error' }); };
  });
}

async function getTaskStatus(taskId) {
  return new Promise((resolve) => {
    const es = new EventSource(`${API}/api/progress/${taskId}`);
    es.onmessage = (event) => {
      const data = JSON.parse(event.data);
      es.close();
      resolve(data);
    };
    es.onerror = () => { es.close(); resolve({ status: 'error' }); };
  });
}

// ── Cancel Single Download ───────────────────────────────────────────
async function cancelDownload() {
  if (!currentTaskId) return;
  const btn = document.getElementById('cancelBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Cancelling...';
  try {
    await fetch(`${API}/api/cancel/${currentTaskId}`, { method: 'POST' });
  } catch (err) {
    showToast('Failed to cancel download', 'error');
    btn.disabled = false;
    btn.innerHTML = '✕ Cancel Download';
  }
}

// ── SSE Progress Listener ────────────────────────────────────────────
function listenProgress(taskId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API}/api/progress/${taskId}`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.status === 'downloading') {
      const pct = data.percent || 0;
      document.getElementById('progressBar').style.width = `${pct}%`;
      document.getElementById('progressPercent').textContent = `${pct}%`;
      document.getElementById('speedText').textContent = formatSpeed(data.speed);
      document.getElementById('etaText').textContent = formatEta(data.eta);
      document.getElementById('progressStatus').textContent = 'Downloading...';
    } else if (data.status === 'processing') {
      document.getElementById('progressBar').style.width = '100%';
      document.getElementById('progressPercent').textContent = '100%';
      document.getElementById('progressStatus').textContent = data.message || 'Processing...';
      document.getElementById('speedText').textContent = '—';
      document.getElementById('etaText').textContent = '—';
      document.getElementById('cancelBtn').disabled = true;
    } else if (data.status === 'done') {
      eventSource.close(); eventSource = null;
      showComplete(data);
    } else if (data.status === 'cancelled') {
      eventSource.close(); eventSource = null;
      showCancelled();
    } else if (data.status === 'error') {
      eventSource.close(); eventSource = null;
      showError(data.message || 'An unknown error occurred.');
    }
  };
  eventSource.onerror = () => { eventSource.close(); eventSource = null; };
}

// ── State Transitions ────────────────────────────────────────────────
function showComplete(data) {
  hide('progressSection');
  document.getElementById('completeFilename').textContent = data.filename || 'file';
  show('completeSection');
  showToast('Download complete! 🎉', 'success');
  loadHistory();
}

function showCancelled() {
  hide('progressSection');
  show('cancelledSection');
  showToast('Download cancelled', 'info');
}

function showError(message) {
  hide('progressSection');
  document.getElementById('errorMessage').textContent = message;
  show('errorSection');
  showToast(message, 'error');
}

function saveFile() {
  if (!currentTaskId) return;
  window.open(`${API}/api/file/${currentTaskId}`, '_blank');
  showToast('File will be cleaned up from the server automatically', 'info');
}

function resetUI() {
  hideAll();
  currentVideoUrl = '';
  currentTaskId = null;
  selectedVideos.clear();
  updateBatchBar();
  if (eventSource) { eventSource.close(); eventSource = null; }
  document.getElementById('urlInput').value = '';
  document.getElementById('urlInput').focus();
  loadHistory();
}

// ── History ──────────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const res = await fetch(`${API}/api/history`);
    const history = await res.json();
    const list = document.getElementById('historyList');
    if (!history.length) {
      list.innerHTML = `<li class="history-empty"><div class="history-empty__icon">📭</div><div>No downloads yet</div></li>`;
      return;
    }
    list.innerHTML = history.map(item => `
      <li class="history-item">
        <div class="history-item__info">
          <div class="history-item__icon">${item.mode === 'audio' ? '🎵' : '🎬'}</div>
          <div class="history-item__text">
            <div class="history-item__title">${escapeHtml(item.title)}</div>
            <div class="history-item__meta">${item.format.toUpperCase()} · ${timeAgo(item.timestamp)}</div>
          </div>
        </div>
        <button class="btn btn--secondary history-item__btn" data-task-id="${item.task_id}">💾 Save</button>
      </li>
    `).join('');
  } catch (err) { /* silent */ }
}

function handleHistoryClick(e) {
  const btn = e.target.closest('.history-item__btn');
  if (btn) {
    const taskId = btn.dataset.taskId;
    window.open(`${API}/api/file/${taskId}`, '_blank');
  }
}

// ── Toast ────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  const icons = { error: '❌', success: '✅', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── Show / Hide ──────────────────────────────────────────────────────
function show(id) { document.getElementById(id).classList.add('show'); }
function hide(id) { document.getElementById(id).classList.remove('show'); }
function hideAll() {
  ['searchResults', 'videoPreview', 'formatSection', 'progressSection',
   'completeSection', 'errorSection', 'cancelledSection', 'batchProgressSection']
    .forEach(hide);
}

// ── Formatters ───────────────────────────────────────────────────────
function formatDuration(s) {
  if (!s) return '—';
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}
function formatViews(c) {
  if (!c) return '—';
  if (c >= 1e9) return `${(c/1e9).toFixed(1)}B`;
  if (c >= 1e6) return `${(c/1e6).toFixed(1)}M`;
  if (c >= 1e3) return `${(c/1e3).toFixed(1)}K`;
  return c.toLocaleString();
}
function formatSpeed(b) {
  if (!b) return '—';
  if (b >= 1048576) return `${(b/1048576).toFixed(1)} MB/s`;
  if (b >= 1024) return `${(b/1024).toFixed(0)} KB/s`;
  return `${b} B/s`;
}
function formatEta(s) {
  if (!s || s <= 0) return '—';
  if (s >= 3600) return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
  if (s >= 60) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.round(s)}s`;
}
function timeAgo(ts) {
  const d = Math.floor(Date.now()/1000 - ts);
  if (d < 60) return 'just now'; if (d < 3600) return `${Math.floor(d/60)}m ago`;
  if (d < 86400) return `${Math.floor(d/3600)}h ago`; return `${Math.floor(d/86400)}d ago`;
}
function escapeHtml(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Universal Dropdown (und-dropdown) Component ──────────────────────
function renderUndDropdown(containerId, options, currentValue, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const currentOpt = options.find(o => o.value === currentValue) || options[0];
  const currentLabel = currentOpt ? currentOpt.label : currentValue;

  container.innerHTML = `
    <div class="und-dropdown-wrapper">
      <button class="und-dropdown-button neo-select" type="button" aria-haspopup="listbox" aria-expanded="false">
        <span>${escapeHtml(currentLabel)}</span>
      </button>
      <div class="und-dropdown-menu" role="listbox">
        ${options.map(opt => `
          <div class="und-dropdown-item ${opt.value === currentValue ? 'selected' : ''}" 
               data-value="${opt.value}" role="option" aria-selected="${opt.value === currentValue ? 'true' : 'false'}">
            ${escapeHtml(opt.label)}
          </div>
        `).join('')}
      </div>
    </div>
  `;

  const btn = container.querySelector('.und-dropdown-button');
  const menu = container.querySelector('.und-dropdown-menu');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isExpanded = btn.getAttribute('aria-expanded') === 'true';
    
    // Close other dropdowns
    document.querySelectorAll('.und-dropdown-menu.show').forEach(m => {
      if (m !== menu) {
        m.classList.remove('show');
        const otherBtn = m.previousElementSibling;
        if (otherBtn) otherBtn.setAttribute('aria-expanded', 'false');
      }
    });

    if (isExpanded) {
      menu.classList.remove('show');
      btn.setAttribute('aria-expanded', 'false');
    } else {
      menu.classList.add('show');
      btn.setAttribute('aria-expanded', 'true');
    }
  });

  menu.querySelectorAll('.und-dropdown-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = item.getAttribute('data-value');
      
      // Update visual selection text
      const btnSpan = btn.querySelector('span');
      if (btnSpan) btnSpan.textContent = item.textContent.trim();
      
      // Update active selection classes/attributes
      menu.querySelectorAll('.und-dropdown-item').forEach(i => {
        const isSelected = i === item;
        i.classList.toggle('selected', isSelected);
        i.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      });

      menu.classList.remove('show');
      btn.setAttribute('aria-expanded', 'false');
      if (onChange) onChange(val);
    });
  });
}

// Global click handler to close dropdowns when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.und-dropdown-menu.show').forEach(menu => {
    menu.classList.remove('show');
    const btn = menu.previousElementSibling;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
});
