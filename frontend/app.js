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
let batchQuality = '1080';

// Map: url -> { url, title, thumbnail, channel, mode, quality, format }
const selectedVideos = new Map();

// ── Format Options ───────────────────────────────────────────────────
const FORMAT_OPTIONS = {
  video: {
    quality: [
      { value: 'best',  label: 'Best Available' },
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
      { value: 'best', label: 'Best Available' },
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

  // Duration clipping checkbox toggle
  document.getElementById('enableCutCheckbox').addEventListener('change', (e) => {
    document.getElementById('cutInputsContainer').style.display = e.target.checked ? 'flex' : 'none';
  });

  // Event delegation for search results (checkboxes, select buttons, per-item options)
  const searchList = document.getElementById('searchList');
  searchList.addEventListener('click', handleSearchListClick);
  searchList.addEventListener('change', handleSearchListChange);

  // Sync clipping range sliders
  const startSlider = document.getElementById('cutStartSlider');
  const endSlider = document.getElementById('cutEndSlider');
  if (startSlider && endSlider) {
    startSlider.addEventListener('input', handleStartSliderInput);
    endSlider.addEventListener('input', handleEndSliderInput);
    startSlider.addEventListener('mousedown', () => { startSlider.style.zIndex = '10'; endSlider.style.zIndex = '9'; });
    startSlider.addEventListener('touchstart', () => { startSlider.style.zIndex = '10'; endSlider.style.zIndex = '9'; });
    endSlider.addEventListener('mousedown', () => { endSlider.style.zIndex = '10'; startSlider.style.zIndex = '9'; });
    endSlider.addEventListener('touchstart', () => { endSlider.style.zIndex = '10'; startSlider.style.zIndex = '9'; });
  }

  // Sync manual input changes back to range sliders
  const startInput = document.getElementById('cutStartInput');
  const endInput = document.getElementById('cutEndInput');
  if (startInput && endInput) {
    startInput.addEventListener('change', handleTimeInputChange);
    endInput.addEventListener('change', handleTimeInputChange);
  }

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
      icon.innerHTML = `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
      text.textContent = 'Light';
    } else {
      icon.innerHTML = `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
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
    btnText.innerHTML = `
      <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
      <span>Go</span>
    `;
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
        <div class="item-opt-group" style="flex: 2; min-width: 180px;">
          <label style="display: flex; justify-content: space-between;">
            <span>Clip</span>
            <input type="checkbox" id="item-clip-check-${index}" style="cursor: pointer;">
          </label>
          <div id="item-clip-inputs-${index}" style="display: none; flex-direction: column; gap: 8px; margin-top: 4px;">
            <div class="range-slider-container" style="padding: 8px 4px 14px 4px; position: relative; width: 100%;">
              <div class="range-slider" style="height: 6px;">
                <div class="range-slider__track" id="item-cut-track-${index}"></div>
                <input type="range" id="item-cut-start-slider-${index}" min="0" max="${item.duration || 100}" value="0">
                <input type="range" id="item-cut-end-slider-${index}" min="0" max="${item.duration || 100}" value="${item.duration || 100}">
              </div>
            </div>
            <div style="display: flex; gap: 4px;">
              <input type="text" class="neo-input" id="item-cut-start-${index}" placeholder="Start" style="padding: 6px; font-size: 0.8rem; text-align: center; width: 50%;" value="00:00:00">
              <input type="text" class="neo-input" id="item-cut-end-${index}" placeholder="End" style="padding: 6px; font-size: 0.8rem; text-align: center; width: 50%;">
            </div>
          </div>
        </div>
      </div>
    </li>
  `}).join('');

  // Render per-item custom dropdown components
  results.forEach((item, index) => {
    const itemState = { mode: 'video', quality: 'best', format: 'mp4', enableCut: false, cutStart: '', cutEnd: '' };
    
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

    const clipCheck = document.getElementById(`item-clip-check-${index}`);
    const clipInputs = document.getElementById(`item-clip-inputs-${index}`);
    const startSlider = document.getElementById(`item-cut-start-slider-${index}`);
    const endSlider = document.getElementById(`item-cut-end-slider-${index}`);
    const track = document.getElementById(`item-cut-track-${index}`);
    const startInput = document.getElementById(`item-cut-start-${index}`);
    const endInput = document.getElementById(`item-cut-end-${index}`);
    const duration = parseFloat(item.duration) || 100;

    function updateItemSliders() {
      if (!startSlider || !endSlider || !track || !startInput || !endInput) return;
      let startVal = parseFloat(startSlider.value);
      let endVal = parseFloat(endSlider.value);

      const leftPct = (startVal / duration) * 100;
      const widthPct = ((endVal - startVal) / duration) * 100;

      track.style.left = `${leftPct}%`;
      track.style.width = `${widthPct}%`;

      startInput.value = formatSecondsToTime(startVal);
      endInput.value = formatSecondsToTime(endVal);

      itemState.cutStart = startInput.value;
      itemState.cutEnd = endInput.value;
      syncSelectedItem();
    }

    if (clipCheck) {
      // Set initial values
      if (endInput) endInput.value = formatSecondsToTime(duration);
      if (startSlider && endSlider) {
        updateItemSliders();
      }

      clipCheck.addEventListener('change', (e) => {
        itemState.enableCut = e.target.checked;
        clipInputs.style.display = e.target.checked ? 'flex' : 'none';
        syncSelectedItem();
      });

      startSlider.addEventListener('input', () => {
        if (parseFloat(startSlider.value) > parseFloat(endSlider.value)) {
          startSlider.value = endSlider.value;
        }
        updateItemSliders();
      });

      endSlider.addEventListener('input', () => {
        if (parseFloat(endSlider.value) < parseFloat(startSlider.value)) {
          endSlider.value = startSlider.value;
        }
        updateItemSliders();
      });

      // Z-index correction on drag
      startSlider.addEventListener('mousedown', () => { startSlider.style.zIndex = '10'; endSlider.style.zIndex = '9'; });
      startSlider.addEventListener('touchstart', () => { startSlider.style.zIndex = '10'; endSlider.style.zIndex = '9'; });
      endSlider.addEventListener('mousedown', () => { endSlider.style.zIndex = '10'; startSlider.style.zIndex = '9'; });
      endSlider.addEventListener('touchstart', () => { endSlider.style.zIndex = '10'; startSlider.style.zIndex = '9'; });

      // Handle manual input changes
      startInput.addEventListener('change', () => {
        const startVal = parseTimeToSeconds(startInput.value);
        const startClamped = Math.min(Math.max(0, startVal), duration);
        startSlider.value = startClamped;
        if (startClamped > parseFloat(endSlider.value)) {
          endSlider.value = startClamped;
        }
        updateItemSliders();
      });

      endInput.addEventListener('change', () => {
        const endVal = parseTimeToSeconds(endInput.value);
        const endClamped = Math.min(Math.max(0, endVal), duration);
        endSlider.value = endClamped;
        if (endClamped < parseFloat(startSlider.value)) {
          startSlider.value = endClamped;
        }
        updateItemSliders();
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
          enableCut: itemState.enableCut,
          cutStart: itemState.cutStart,
          cutEnd: itemState.cutEnd,
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

  // Prevent toggling the checkbox when interacting with options, inputs, or dropdowns
  if (e.target.closest('.search-item__options') || e.target.closest('.neo-checkbox')) {
    return;
  }

  const item = e.target.closest('.search-item');
  if (item) {
    const cb = item.querySelector('.search-checkbox');
    if (cb) {
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
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
    btnText.innerHTML = `
      <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
      <span>Go</span>
    `;
  }
}

// ── Render Video Preview ─────────────────────────────────────────────
function renderVideoPreview(info) {
  const embedUrl = getYouTubeEmbedUrl(currentVideoUrl);
  const thumbContainer = document.querySelector('.video-thumb');
  if (embedUrl && thumbContainer) {
    thumbContainer.innerHTML = `<iframe id="videoPlayerFrame" src="${embedUrl}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen style="width: 100%; height: 100%; aspect-ratio: 16/9; border-radius: 18px;"></iframe>`;
  } else if (thumbContainer) {
    thumbContainer.innerHTML = `<img id="videoThumb" src="${info.thumbnail || ''}" alt="Video thumbnail" style="width: 100%; height: 100%; object-fit: cover;">`;
  }

  document.getElementById('videoTitle').textContent = info.title || 'Unknown Title';
  document.getElementById('videoChannel').textContent = info.channel || 'Unknown Channel';
  const formattedDuration = formatDuration(info.duration);
  document.getElementById('durationText').textContent = formattedDuration;
  document.getElementById('viewsText').textContent = formatViews(info.view_count);

  // Pre-fill clipping inputs and set slider boundaries
  const duration = info.duration || 0;
  const startSlider = document.getElementById('cutStartSlider');
  const endSlider = document.getElementById('cutEndSlider');

  if (startSlider && endSlider) {
    startSlider.min = 0;
    startSlider.max = duration;
    startSlider.value = 0;

    endSlider.min = 0;
    endSlider.max = duration;
    endSlider.value = duration;
  }

  document.getElementById('enableCutCheckbox').checked = false;
  document.getElementById('cutInputsContainer').style.display = 'none';

  updateCutSliders();
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

  let cutStart = null;
  let cutEnd = null;
  const enableCut = document.getElementById('enableCutCheckbox').checked;
  if (enableCut) {
    cutStart = document.getElementById('cutStartInput').value.trim();
    cutEnd = document.getElementById('cutEndInput').value.trim();
    const timeRegex = /^(?:(?:\d+:)?\d+:)?\d+(?:\.\d+)?$/;
    if (!timeRegex.test(cutStart) || !timeRegex.test(cutEnd)) {
      showToast('Invalid start or end time format. Use HH:MM:SS, MM:SS, or seconds.', 'error');
      btn.disabled = false;
      btn.innerHTML = '<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg><span>Download</span>';
      return;
    }
  }

  try {
    const res = await fetch(`${API}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        url: currentVideoUrl, 
        mode: currentMode, 
        quality, 
        format,
        cut_start: cutStart,
        cut_end: cutEnd
      }),
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
    btn.innerHTML = '<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg><span>Download</span>';
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
      <div class="batch-item__details" id="batch-details-${i}" style="display: none;"></div>
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
      const payload = {
        url: info.url,
        mode: info.mode,
        quality: info.quality,
        format: info.format,
      };
      if (info.enableCut) {
        if (info.cutStart) payload.cut_start = info.cutStart;
        if (info.cutEnd) payload.cut_end = info.cutEnd;
      }

      const res = await fetch(`${API}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Show details and inject progress UI
      const detailsEl = document.getElementById(`batch-details-${i}`);
      detailsEl.innerHTML = `
        <div class="batch-item__progress-bar-wrapper" style="margin-top: 8px;">
          <div class="batch-item__progress">
            <div class="batch-item__progress-bar" id="batch-progress-bar-${i}" style="width: 0%;"></div>
          </div>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 10px;">
          <div style="display: flex; align-items: center; gap: 16px; font-size: 0.9rem; color: var(--text-secondary);">
            <span id="batch-percent-${i}" style="font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 1rem; color: var(--primary);">0%</span>
            <span style="display: inline-flex; align-items: center; gap: 5px;">
              <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 16px; height: 16px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
              <span id="batch-speed-${i}">—</span>
            </span>
            <span style="display: inline-flex; align-items: center; gap: 5px;">
              <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 16px; height: 16px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              <span id="batch-eta-${i}">—</span>
            </span>
          </div>
          <button class="btn btn--danger batch-cancel-btn" id="batch-cancel-${i}" style="padding: 8px 18px; font-size: 0.88rem; font-weight: 600; border-radius: var(--radius-small); display: inline-flex; align-items: center; gap: 6px; box-shadow: var(--neo-raised-sm); flex-shrink: 0;">
            <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 16px; height: 16px;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            Cancel
          </button>
        </div>
      `;
      detailsEl.style.display = 'block';

      // Bind cancel event listener
      const cancelBtn = document.getElementById(`batch-cancel-${i}`);
      if (cancelBtn) {
        cancelBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          cancelBtn.disabled = true;
          cancelBtn.innerHTML = '<span class="spinner" style="width:14px; height:14px; margin-right:4px;"></span> Cancelling...';
          try {
            await fetch(`${API}/api/cancel/${data.task_id}`, { method: 'POST' });
          } catch (err) {
            cancelBtn.disabled = false;
            cancelBtn.innerHTML = 'Cancel';
          }
        });
      }

      const finalInfo = await waitForTask(data.task_id, (progressData) => {
        const progressBar = document.getElementById(`batch-progress-bar-${i}`);
        const percentEl = document.getElementById(`batch-percent-${i}`);
        const speedEl = document.getElementById(`batch-speed-${i}`);
        const etaEl = document.getElementById(`batch-eta-${i}`);
        const currentStatusEl = document.getElementById(`batch-status-${i}`);

        if (progressData.status === 'downloading') {
          const pct = progressData.percent || 0;
          if (progressBar) progressBar.style.width = `${pct}%`;
          if (percentEl) percentEl.textContent = `${pct}%`;
          if (speedEl) speedEl.textContent = formatSpeed(progressData.speed);
          if (etaEl) etaEl.textContent = formatEta(progressData.eta);
        } else if (progressData.status === 'processing') {
          if (progressBar) progressBar.style.width = '100%';
          if (percentEl) percentEl.textContent = '100%';
          if (currentStatusEl) {
            currentStatusEl.textContent = progressData.message || 'Processing...';
            currentStatusEl.className = 'batch-item__status downloading';
          }
          const cancelBtnEl = document.getElementById(`batch-cancel-${i}`);
          if (cancelBtnEl) cancelBtnEl.style.display = 'none';
        }
      });

      // Hide details after it's finished
      detailsEl.style.display = 'none';

      if (finalInfo.status === 'done') {
        statusEl.textContent = '✅ Done';
        statusEl.className = 'batch-item__status completed';
        window.open(`${API}/api/file/${data.task_id}`, '_blank');
      } else if (finalInfo.status === 'cancelled') {
        statusEl.textContent = '❌ Cancelled';
        statusEl.className = 'batch-item__status failed';
      } else {
        statusEl.textContent = '❌ Failed';
        statusEl.className = 'batch-item__status failed';
      }
    } catch (err) {
      statusEl.textContent = '❌ Failed';
      statusEl.className = 'batch-item__status failed';
      const detailsEl = document.getElementById(`batch-details-${i}`);
      if (detailsEl) detailsEl.style.display = 'none';
    }
    itemEl.classList.remove('active');
  }

  showToast(`Batch download complete (${items.length} videos)`, 'success');
  selectedVideos.clear();
  updateBatchBar();
  loadHistory();
}

// ── Wait for Task Status via SSE ─────────────────────────────────────
function waitForTask(taskId, onProgress) {
  return new Promise((resolve) => {
    const es = new EventSource(`${API}/api/progress/${taskId}`);
    es.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (onProgress) {
        onProgress(data);
      }
      if (data.status === 'done' || data.status === 'error' || data.status === 'cancelled') {
        es.close();
        resolve(data);
      }
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
    btn.disabled = false;
    btn.innerHTML = '<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span>Cancel Download</span>';
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
  document.getElementById('enableCutCheckbox').checked = false;
  document.getElementById('cutInputsContainer').style.display = 'none';
  document.getElementById('cutStartInput').value = '00:00:00';
  document.getElementById('cutEndInput').value = '';
  const thumbContainer = document.querySelector('.video-thumb');
  if (thumbContainer) {
    thumbContainer.innerHTML = `<img id="videoThumb" src="" alt="Video thumbnail">`;
  }
  loadHistory();
}

// ── History ──────────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const res = await fetch(`${API}/api/history`);
    const history = await res.json();
    const list = document.getElementById('historyList');
    if (!history.length) {
      list.innerHTML = `
        <li class="history-empty">
          <div class="history-empty__icon">
            <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 32px; height: 32px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          </div>
          <div>No downloads yet</div>
        </li>
      `;
      return;
    }
    list.innerHTML = history.map(item => `
      <li class="history-item">
        <div class="history-item__info">
          <div class="history-item__icon">
            ${item.mode === 'audio' 
              ? `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>` 
              : `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`
            }
          </div>
          <div class="history-item__text">
            <div class="history-item__title">${escapeHtml(item.title)}</div>
            <div class="history-item__meta">${item.format.toUpperCase()} · ${timeAgo(item.timestamp)}</div>
          </div>
        </div>
        <button class="btn btn--secondary history-item__btn" data-task-id="${item.task_id}" style="display: inline-flex; align-items: center; gap: 6px; justify-content: center;">
          <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          <span>Save</span>
        </button>
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
  const icons = {
    error: `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`,
    success: `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    info: `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`
  };
  toast.innerHTML = `<span style="display: inline-flex; align-items: center;">${icons[type] || icons.info}</span> <span style="margin-left: 6px;">${escapeHtml(message)}</span>`;
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

// ── Range Slider Handlers & Embed Helpers ──────────────────────────
function getYouTubeEmbedUrl(url) {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  if (match && match[2].length === 11) {
    return `https://www.youtube.com/embed/${match[2]}`;
  }
  return null;
}

function formatSecondsToTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 100);
  let time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (ms > 0) {
    time += `.${String(ms).padStart(2, '0')}`;
  }
  return time;
}

function parseTimeToSeconds(timeStr) {
  timeStr = timeStr.trim();
  if (!timeStr) return 0;
  if (/^\d+(\.\d+)?$/.test(timeStr)) {
    return parseFloat(timeStr);
  }
  const parts = timeStr.split(':');
  try {
    if (parts.length === 2) {
      return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    } else if (parts.length === 3) {
      return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
    }
  } catch(e) {}
  return 0;
}

function handleStartSliderInput() {
  const startSlider = document.getElementById('cutStartSlider');
  const endSlider = document.getElementById('cutEndSlider');
  if (parseFloat(startSlider.value) > parseFloat(endSlider.value)) {
    startSlider.value = endSlider.value;
  }
  updateCutSliders();
}

function handleEndSliderInput() {
  const startSlider = document.getElementById('cutStartSlider');
  const endSlider = document.getElementById('cutEndSlider');
  if (parseFloat(endSlider.value) < parseFloat(startSlider.value)) {
    endSlider.value = startSlider.value;
  }
  updateCutSliders();
}

function handleTimeInputChange() {
  const startVal = parseTimeToSeconds(document.getElementById('cutStartInput').value);
  const endVal = parseTimeToSeconds(document.getElementById('cutEndInput').value);

  const startSlider = document.getElementById('cutStartSlider');
  const endSlider = document.getElementById('cutEndSlider');
  const max = parseFloat(startSlider.max) || 100;

  const startClamped = Math.max(0, Math.min(startVal, max));
  const endClamped = Math.max(0, Math.min(endVal, max));

  if (startClamped <= endClamped) {
    startSlider.value = startClamped;
    endSlider.value = endClamped;
  } else {
    startSlider.value = endClamped;
    endSlider.value = startClamped;
  }
  updateCutSliders();
}

function updateCutSliders() {
  const startSlider = document.getElementById('cutStartSlider');
  const endSlider = document.getElementById('cutEndSlider');
  const track = document.getElementById('cutSliderTrack');
  const startInput = document.getElementById('cutStartInput');
  const endInput = document.getElementById('cutEndInput');

  if (!startSlider || !endSlider || !track || !startInput || !endInput) return;

  let startVal = parseFloat(startSlider.value);
  let endVal = parseFloat(endSlider.value);
  const max = parseFloat(startSlider.max) || 100;

  const leftPct = (startVal / max) * 100;
  const widthPct = ((endVal - startVal) / max) * 100;

  track.style.left = `${leftPct}%`;
  track.style.width = `${widthPct}%`;

  startInput.value = formatSecondsToTime(startVal);
  endInput.value = formatSecondsToTime(endVal);
}
