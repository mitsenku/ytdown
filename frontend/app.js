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
let currentThumbnailUrl = '';
let currentPreviewUrl = null;
let eventSource = null;
let batchQuality = '1080';

// Map: url -> { url, title, thumbnail, channel, mode, quality, format }
const selectedVideos = new Map();

function pauseAllVideos() {
  document.querySelectorAll('video').forEach(vid => vid.pause());
}

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
  document.addEventListener('play', (e) => {
    if (e.target.tagName === 'VIDEO') {
      document.querySelectorAll('video').forEach(vid => {
        if (vid !== e.target) vid.pause();
      });
    }
  }, true);
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

  // Search list event delegation (click on items/buttons, change on checkboxes)
  const searchList = document.getElementById('searchList');
  searchList.addEventListener('click', handleSearchListClick);
  searchList.addEventListener('change', handleSearchListChange);

  // Duration clipping toggle switch & collapse handlers
  const enableCutCheckbox = document.getElementById('enableCutCheckbox');
  const cutInputsContainer = document.getElementById('cutInputsContainer');
  const clipCollapseBtn = document.getElementById('clipCollapseBtn');

  if (enableCutCheckbox && cutInputsContainer) {
    enableCutCheckbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        cutInputsContainer.classList.remove('is-hidden');
        if (clipCollapseBtn) clipCollapseBtn.classList.remove('is-collapsed');
        updateCutSliders();
        loadVideoPreviewPlayer();
      } else {
        cutInputsContainer.classList.add('is-hidden');
        if (clipCollapseBtn) clipCollapseBtn.classList.add('is-collapsed');
        restoreVideoThumbnail();
      }
    });
  }

  if (clipCollapseBtn && enableCutCheckbox && cutInputsContainer) {
    clipCollapseBtn.addEventListener('click', () => {
      if (!enableCutCheckbox.checked) {
        enableCutCheckbox.checked = true;
        cutInputsContainer.classList.remove('is-hidden');
        clipCollapseBtn.classList.remove('is-collapsed');
        updateCutSliders();
        loadVideoPreviewPlayer();
      } else {
        const isCurrentlyHidden = cutInputsContainer.classList.toggle('is-hidden');
        clipCollapseBtn.classList.toggle('is-collapsed', isCurrentlyHidden);
      }
    });
  }

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
    startInput.addEventListener('blur', handleTimeInputChange);
    endInput.addEventListener('blur', handleTimeInputChange);
  }

  // Stepper buttons for 1-second nudging
  const startStepUp = document.getElementById('startStepUp');
  const startStepDown = document.getElementById('startStepDown');
  const endStepUp = document.getElementById('endStepUp');
  const endStepDown = document.getElementById('endStepDown');

  if (startStepUp) startStepUp.addEventListener('click', () => stepTime('start', 1));
  if (startStepDown) startStepDown.addEventListener('click', () => stepTime('start', -1));
  if (endStepUp) endStepUp.addEventListener('click', () => stepTime('end', 1));
  if (endStepDown) endStepDown.addEventListener('click', () => stepTime('end', -1));

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
  pauseAllVideos();
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
            <svg class="svg-icon svg-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>Download</span>
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
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <label style="margin: 0; font-size: 0.82rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">Clip</label>
            <label class="modern-toggle" for="item-clip-check-${index}" title="Toggle clip" style="transform: scale(0.85); transform-origin: right center;">
              <input type="checkbox" id="item-clip-check-${index}" class="modern-toggle__input">
              <span class="modern-toggle__track">
                <span class="modern-toggle__thumb"></span>
              </span>
            </label>
          </div>
          <div id="item-clip-inputs-${index}" style="display: none; flex-direction: column; gap: 8px; margin-top: 6px;">
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
      let startVal = parseFloat(startSlider.value) || 0;
      let endVal = parseFloat(endSlider.value) || 0;

      if (startVal > endVal) { startVal = endVal; startSlider.value = startVal; }

      const leftPct = duration > 0 ? (startVal / duration) * 100 : 0;
      const widthPct = duration > 0 ? ((endVal - startVal) / duration) * 100 : 100;

      track.style.left = `${Math.max(0, Math.min(100, leftPct))}%`;
      track.style.width = `${Math.max(0, Math.min(100, widthPct))}%`;

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

      clipCheck.addEventListener('change', async (e) => {
        itemState.enableCut = e.target.checked;
        clipInputs.style.display = e.target.checked ? 'flex' : 'none';
        syncSelectedItem();

        const searchItemNode = document.querySelector(`.search-item[data-url="${CSS.escape(item.url)}"]`);
        const thumbContainer = searchItemNode.querySelector('.search-item__thumb');

        if (e.target.checked) {
          searchItemNode.classList.add('playing-preview');
          const originalThumb = thumbContainer.innerHTML;
          thumbContainer.dataset.originalHTML = originalThumb;
          thumbContainer.innerHTML = `
            <img src="${escapeAttr(item.thumbnail)}" alt="" style="filter: brightness(0.35); width: 100%; height: 100%; object-fit: cover;">
            <div class="video-thumb__loader" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; flex-direction:column; color:#fff; font-size:0.8rem; background:rgba(0,0,0,0.6);">
              <span class="spinner" style="width: 20px; height: 20px; border-width: 2px;"></span>
              <span style="margin-top: 6px;">Loading...</span>
            </div>
          `;
          try {
            const res = await fetch(`${API}/api/preview`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: item.url }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Preview failed');

            thumbContainer.innerHTML = `<video id="search-preview-${index}" src="${data.preview_url}" controls playsinline preload="auto" style="width: 100%; height: 100%; object-fit: contain; background: #000; border-radius: 12px;"></video>`;
            const videoEl = document.getElementById(`search-preview-${index}`);
            if (videoEl && startSlider) {
               videoEl.currentTime = parseFloat(startSlider.value) || 0;
               if (endSlider) {
                 videoEl.addEventListener('timeupdate', () => {
                   const endVal = parseFloat(endSlider.value) || videoEl.duration;
                   if (videoEl.currentTime >= endVal) {
                     videoEl.pause();
                     videoEl.currentTime = endVal;
                   }
                 });
               }
            }
          } catch (err) {
            showToast('Could not load preview: ' + err.message, 'info');
            searchItemNode.classList.remove('playing-preview');
            thumbContainer.innerHTML = thumbContainer.dataset.originalHTML;
          }
        } else {
          searchItemNode.classList.remove('playing-preview');
          if (thumbContainer.dataset.originalHTML) {
            thumbContainer.innerHTML = thumbContainer.dataset.originalHTML;
          }
        }
      });

      startSlider.addEventListener('input', () => {
        if (parseFloat(startSlider.value) > parseFloat(endSlider.value)) {
          startSlider.value = endSlider.value;
        }
        updateItemSliders();
        const videoEl = document.getElementById(`search-preview-${index}`);
        if (videoEl) videoEl.currentTime = parseFloat(startSlider.value) || 0;
      });

      endSlider.addEventListener('input', () => {
        if (parseFloat(endSlider.value) < parseFloat(startSlider.value)) {
          endSlider.value = startSlider.value;
        }
        updateItemSliders();
        const videoEl = document.getElementById(`search-preview-${index}`);
        if (videoEl) videoEl.currentTime = parseFloat(endSlider.value) || 0;
      });

      // Z-index correction on drag
      startSlider.addEventListener('mousedown', () => { startSlider.style.zIndex = '10'; endSlider.style.zIndex = '9'; });
      startSlider.addEventListener('touchstart', () => { startSlider.style.zIndex = '10'; endSlider.style.zIndex = '9'; }, { passive: true });
      endSlider.addEventListener('mousedown', () => { endSlider.style.zIndex = '10'; startSlider.style.zIndex = '9'; });
      endSlider.addEventListener('touchstart', () => { endSlider.style.zIndex = '10'; startSlider.style.zIndex = '9'; }, { passive: true });

      startInput.addEventListener('change', () => {
        const startVal = parseTimeToSeconds(startInput.value);
        const startClamped = Math.min(Math.max(0, startVal), duration);
        startSlider.value = startClamped;
        if (startClamped > parseFloat(endSlider.value)) {
          endSlider.value = startClamped;
        }
        updateItemSliders();
        const videoEl = document.getElementById(`search-preview-${index}`);
        if (videoEl) videoEl.currentTime = parseFloat(startSlider.value) || 0;
      });

      endInput.addEventListener('change', () => {
        const endVal = parseTimeToSeconds(endInput.value);
        const endClamped = Math.min(Math.max(0, endVal), duration);
        endSlider.value = endClamped;
        if (endClamped < parseFloat(startSlider.value)) {
          startSlider.value = endClamped;
        }
        updateItemSliders();
        const videoEl = document.getElementById(`search-preview-${index}`);
        if (videoEl) videoEl.currentTime = parseFloat(endSlider.value) || 0;
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
    directDownloadFromSearch(url, btn);
    return;
  }

  // Prevent toggling the checkbox when interacting with options, inputs, dropdowns, or video player
  if (e.target.closest('.search-item__options') || e.target.closest('.neo-checkbox') || e.target.closest('video')) {
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

// ── Direct Download from Search Result ───────────────────────────────
async function directDownloadFromSearch(url, btn) {
  const item = btn.closest('.search-item');
  if (!item) return;
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

  const payload = { url, mode, quality, format };

  // Check clip settings
  const clipCheck = document.getElementById(`item-clip-check-${index}`);
  if (clipCheck && clipCheck.checked) {
    const startInput = document.getElementById(`item-cut-start-${index}`);
    const endInput = document.getElementById(`item-cut-end-${index}`);
    if (startInput && startInput.value) payload.cut_start = startInput.value.trim();
    if (endInput && endInput.value) payload.cut_end = endInput.value.trim();
  }

  // Disable button and show spinner
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> <span>Starting...</span>';
  pauseAllVideos();

  try {
    const res = await fetch(`${API}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start download');

    currentTaskId = data.task_id;
    hide('searchResults');
    document.getElementById('progressTitle').textContent = 'Downloading...';
    show('progressSection');
    document.getElementById('progressBar').style.width = '0%';
    document.getElementById('progressPercent').textContent = '0%';
    document.getElementById('progressStatus').textContent = 'Starting download...';
    document.getElementById('cancelBtn').disabled = false;
    listenProgress(currentTaskId);
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
}

// ── Helper: Read per-item state from dropdowns ───────────────────────
function getItemStateFromDOM(item, index) {
  const typeBtn = item.querySelector(`#item-type-dropdown-${index} .und-dropdown-button span`);
  const qualityBtn = item.querySelector(`#item-quality-dropdown-${index} .und-dropdown-button span`);
  const formatBtn = item.querySelector(`#item-format-dropdown-${index} .und-dropdown-button span`);

  const mode = typeBtn?.textContent.toLowerCase().includes('audio') ? 'audio' : 'video';
  const qualityLabel = qualityBtn?.textContent.trim() || '';
  const formatLabel = formatBtn?.textContent.trim() || '';
  const opts = FORMAT_OPTIONS[mode];
  const quality = (opts.quality.find(o => o.label === qualityLabel) || opts.quality[0]).value;
  const format = (opts.format.find(o => o.label === formatLabel) || opts.format[0]).value;

  const result = {
    url: item.dataset.url,
    title: item.dataset.title,
    thumbnail: item.dataset.thumb,
    channel: item.dataset.channel,
    mode,
    quality,
    format,
    enableCut: false,
    cutStart: '',
    cutEnd: '',
  };

  const clipCheck = document.getElementById(`item-clip-check-${index}`);
  if (clipCheck && clipCheck.checked) {
    result.enableCut = true;
    const startInput = document.getElementById(`item-cut-start-${index}`);
    const endInput = document.getElementById(`item-cut-end-${index}`);
    if (startInput) result.cutStart = startInput.value.trim();
    if (endInput) result.cutEnd = endInput.value.trim();
  }

  return result;
}

// ── Event Delegation: Search List Checkbox & Select Changes ──────────
function handleSearchListChange(e) {
  const target = e.target;
  if (target.classList.contains('search-checkbox')) {
    const item = target.closest('.search-item');
    const url = target.dataset.url;
    if (target.checked) {
      const index = Array.from(document.querySelectorAll('.search-item')).indexOf(item);
      selectedVideos.set(url, getItemStateFromDOM(item, index));
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
        selectedVideos.set(url, getItemStateFromDOM(item, index));
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

  hide('formatSection'); hide('progressSection');
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
  currentThumbnailUrl = info.thumbnail || '';
  currentPreviewUrl = null;
  const thumbContainer = document.querySelector('.video-thumb');
  if (thumbContainer) {
    thumbContainer.innerHTML = `<img id="videoThumb" src="${escapeAttr(currentThumbnailUrl)}" alt="Video thumbnail">`;
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
  const cutCheck = document.getElementById('enableCutCheckbox');
  const cutInputs = document.getElementById('cutInputsContainer');
  const collapseBtn = document.getElementById('clipCollapseBtn');
  const maxLabel = document.getElementById('sliderMaxLabel');

  if (startSlider && endSlider) {
    startSlider.min = 0;
    startSlider.max = duration;
    startSlider.value = 0;

    endSlider.min = 0;
    endSlider.max = duration;
    endSlider.value = duration;
  }

  if (maxLabel) {
    maxLabel.textContent = formatSecondsToTime(duration);
  }

  if (cutCheck) cutCheck.checked = false;
  if (cutInputs) cutInputs.classList.add('is-hidden');
  if (collapseBtn) collapseBtn.classList.add('is-collapsed');

  updateCutSliders();
}

// ── Preview Player for Clip Mode ─────────────────────────────────────
async function loadVideoPreviewPlayer() {
  const thumbContainer = document.querySelector('.video-thumb');
  if (!thumbContainer || !currentVideoUrl) return;

  if (currentPreviewUrl) {
    thumbContainer.innerHTML = `<video id="videoPreviewPlayer" src="${currentPreviewUrl}" controls playsinline preload="auto" style="width: 100%; height: 100%; object-fit: contain; background: #000; border-radius: var(--radius-large);"></video>`;
    const videoEl = document.getElementById('videoPreviewPlayer');
    if (videoEl) {
      const startVal = parseFloat(document.getElementById('cutStartSlider')?.value) || 0;
      videoEl.currentTime = startVal;
    }
    return;
  }

  thumbContainer.innerHTML = `
    <img id="videoThumb" src="${escapeAttr(currentThumbnailUrl)}" alt="Video thumbnail" style="filter: brightness(0.35);">
    <div class="video-thumb__loader">
      <span class="spinner" style="width: 28px; height: 28px; border-width: 3px;"></span>
      <span>Loading preview video on server...</span>
    </div>
  `;

  try {
    const res = await fetch(`${API}/api/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: currentVideoUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to download preview');

    currentPreviewUrl = data.preview_url;
    const enableCutCheckbox = document.getElementById('enableCutCheckbox');
    if (enableCutCheckbox && enableCutCheckbox.checked) {
      thumbContainer.innerHTML = `<video id="videoPreviewPlayer" src="${currentPreviewUrl}" controls playsinline preload="auto" style="width: 100%; height: 100%; object-fit: contain; background: #000; border-radius: var(--radius-large);"></video>`;
      const videoEl = document.getElementById('videoPreviewPlayer');
      if (videoEl) {
        const startVal = parseFloat(document.getElementById('cutStartSlider')?.value) || 0;
        videoEl.currentTime = startVal;
        const endSlider = document.getElementById('cutEndSlider');
        if (endSlider) {
          videoEl.addEventListener('timeupdate', () => {
            const endVal = parseFloat(endSlider.value) || videoEl.duration;
            if (videoEl.currentTime >= endVal) {
              videoEl.pause();
              videoEl.currentTime = endVal;
            }
          });
        }
      }
    }
  } catch (err) {
    showToast('Could not load video preview: ' + err.message, 'info');
    restoreVideoThumbnail();
  }
}

function restoreVideoThumbnail() {
  const thumbContainer = document.querySelector('.video-thumb');
  if (thumbContainer) {
    thumbContainer.innerHTML = `<img id="videoThumb" src="${escapeAttr(currentThumbnailUrl)}" alt="Video thumbnail">`;
  }
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
  pauseAllVideos();
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
    hide('formatSection');
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

  pauseAllVideos();

  const items = Array.from(selectedVideos.values());
  hide('searchResults');
  hide('formatSection');
  show('batchProgressSection');

  const overallStatus = document.getElementById('batchOverallStatus');
  const saveAllBtn = document.getElementById('batchSaveAllBtn');
  const newDownloadBtn = document.getElementById('batchNewDownloadBtn');
  if (saveAllBtn) saveAllBtn.style.display = 'none';
  if (newDownloadBtn) newDownloadBtn.style.display = 'none';
  if (overallStatus) overallStatus.textContent = `Queued ${items.length} video${items.length === 1 ? '' : 's'}...`;

  const completedTasks = [];
  
  let batchTotal = items.length;
  let batchQueued = items.length;
  let batchDownloading = 0;
  
  const updateSummary = () => {
    const sumBar = document.getElementById('batchSummaryBar');
    if (sumBar) sumBar.style.display = batchTotal > 0 ? 'flex' : 'none';
    document.getElementById('batchTotalCount').textContent = batchTotal;
    document.getElementById('batchDownloadingCount').textContent = batchDownloading;
    document.getElementById('batchQueuedCount').textContent = batchQueued;
  };
  
  const clearBtn = document.getElementById('batchClearCompletedBtn');
  if (clearBtn) {
    clearBtn.onclick = () => {
      document.querySelectorAll('.batch-item.completed-item').forEach(el => {
        el.remove();
        batchTotal--;
      });
      updateSummary();
    };
  }
  
  updateSummary();

  const queue = document.getElementById('batchQueue');
  queue.innerHTML = items.map((info, i) => {
    const isAudio = info.mode === 'audio';
    return `<div class="batch-item" id="batch-${i}" data-url="${escapeAttr(info.url)}">
      <div class="batch-item__main">
        <div style="display: flex; gap: 16px; align-items: flex-start; width: 100%;">
          <span class="batch-item__num">${i + 1}</span>
          <div class="batch-item__text" style="flex: 1; min-width: 0;">
            <div class="batch-item__title" title="${escapeHtml(info.title)}" style="font-size: 1.05rem; font-weight: 700; color: var(--text-primary); margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(info.title)}</div>
            <div class="batch-item__meta-text" style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 12px; font-weight: 500; letter-spacing: 0.3px;">
              ${info.mode.toUpperCase()} &bull; ${info.format.toUpperCase()} &bull; ${info.quality === 'best' ? 'best' : (isAudio ? info.quality + ' kbps' : info.quality + 'p')}
              ${info.enableCut ? ` &bull; ✂ ${escapeHtml(info.cutStart || '0')} &ndash; ${escapeHtml(info.cutEnd || 'End')}` : ''}
            </div>
            <div class="batch-item__status pending" id="batch-status-${i}" style="display: flex; align-items: center; gap: 6px; font-size: 0.9rem; font-weight: 600; color: var(--text-secondary);">
              <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5" style="width: 16px; height: 16px;"><path d="M12 2v20"></path><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
              <span style="color: var(--text-primary);">Queued</span>
            </div>
          </div>
          <button class="batch-item__menu-btn" style="background: var(--surface-secondary); border: 1px solid var(--glass-border); border-radius: 8px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text-secondary); box-shadow: var(--neo-raised-sm); flex-shrink: 0;">
            <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
          </button>
          <button class="btn btn--success btn--sm batch-item__save-btn" id="batch-save-${i}" style="display: none; align-items: center; gap: 6px; position: absolute; right: 24px; bottom: 24px;" type="button">
            <svg class="svg-icon svg-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
            <span>Save</span>
          </button>
        </div>
      </div>
      <div class="batch-item__details" id="batch-details-${i}" style="display: none; width: 100%;"></div>
    </div>
  `}).join('');

  // Download sequentially each with its custom format & quality settings
  for (let i = 0; i < items.length; i++) {
    const info = items[i];
    const statusEl = document.getElementById(`batch-status-${i}`);
    const itemEl = document.getElementById(`batch-${i}`);
    const saveBtn = document.getElementById(`batch-save-${i}`);

    if (overallStatus) overallStatus.textContent = `Downloading ${i + 1} of ${items.length}...`;

    statusEl.innerHTML = `
      <span class="spinner" style="width: 12px; height: 12px; border-width: 2px;"></span>
      <span>Downloading...</span>
    `;
    statusEl.className = 'batch-item__status downloading';
    itemEl.classList.add('active');
    
    batchQueued--;
    batchDownloading++;
    updateSummary();

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
      // Show details and inject progress UI
      const detailsEl = document.getElementById(`batch-details-${i}`);
      detailsEl.innerHTML = `
        <div class="batch-item__progress-bar-wrapper" style="width: 100%; height: 6px; background: var(--surface-secondary); border-radius: 99px; margin-top: 4px; border: 1px solid var(--glass-border); overflow: hidden;">
          <div class="batch-item__progress-bar" id="batch-progress-bar-${i}" style="width: 0%; height: 100%; background: linear-gradient(90deg, var(--primary) 0%, #FF7A41 100%); border-radius: 99px; transition: width 0.15s linear;"></div>
        </div>
        <div class="batch-progress-details">
          <div class="batch-progress-stats">
            <div id="batch-percent-${i}" style="font-family: 'JetBrains Mono', monospace; font-weight: 800; font-size: 1.25rem; color: var(--primary); min-width: 50px;">0%</div>
            
            <div class="batch-progress-stat">
              <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px; color: var(--text-secondary);"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
              <span id="batch-speed-${i}">—</span>
            </div>
            
            <div class="batch-progress-stat">
              <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px; color: var(--text-secondary);"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              <div class="batch-progress-stat-stack">
                <span id="batch-eta-${i}">—</span>
                <span>Time left</span>
              </div>
            </div>
            
            <div class="batch-progress-stat">
              <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px; color: var(--text-secondary);"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
              <div class="batch-progress-stat-stack">
                <span id="batch-downloaded-${i}">— / —</span>
                <span>Downloaded</span>
              </div>
            </div>
          </div>
          
          <button class="btn btn--danger batch-cancel-btn" id="batch-cancel-${i}" style="padding: 6px 16px; font-size: 0.85rem; font-weight: 700; border-radius: 8px; display: inline-flex; align-items: center; gap: 6px; box-shadow: var(--neo-raised-sm); flex-shrink: 0; background: transparent; color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3);">
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

        const downloadedEl = document.getElementById(`batch-downloaded-${i}`);

        if (progressData.status === 'downloading') {
          const pct = progressData.percent || 0;
          if (progressBar) progressBar.style.width = `${pct}%`;
          if (percentEl) percentEl.textContent = `${pct}%`;
          if (speedEl) speedEl.textContent = formatSpeed(progressData.speed);
          if (etaEl) etaEl.textContent = formatEta(progressData.eta);
          if (downloadedEl) {
            const downStr = formatBytes(progressData.downloaded_bytes);
            const totalStr = formatBytes(progressData.total_bytes);
            downloadedEl.textContent = `${downStr} / ${totalStr}`;
          }
        } else if (progressData.status === 'processing') {
          if (progressBar) progressBar.style.width = '100%';
          if (percentEl) percentEl.textContent = '100%';
          if (currentStatusEl) {
            currentStatusEl.innerHTML = `
              <span class="spinner" style="width: 12px; height: 12px; border-width: 2px;"></span>
              <span>${progressData.message || 'Processing...'}</span>
            `;
            currentStatusEl.className = 'batch-item__status downloading';
          }
          const cancelBtnEl = document.getElementById(`batch-cancel-${i}`);
          if (cancelBtnEl) cancelBtnEl.style.display = 'none';
        }
      });

      detailsEl.style.display = 'none';

      if (finalInfo.status === 'done') {
        statusEl.innerHTML = `
          <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" style="width: 14px; height: 14px;"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>Done</span>
        `;
        statusEl.className = 'batch-item__status completed';
        
        if (saveBtn) {
          saveBtn.style.display = 'inline-flex';
          saveBtn.onclick = () => {
            window.open(`${API}/api/file/${data.task_id}`, '_blank');
          };
        }
        itemEl.classList.add('completed-item');

        completedTasks.push({ taskId: data.task_id, title: info.title });
        if (saveAllBtn) saveAllBtn.style.display = 'inline-flex';
      } else if (finalInfo.status === 'cancelled') {
        statusEl.innerHTML = `
          <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 14px; height: 14px;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          <span>Cancelled</span>
        `;
        statusEl.className = 'batch-item__status failed';
        itemEl.classList.add('completed-item');
      } else {
        statusEl.innerHTML = `
          <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 14px; height: 14px;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
          <span>Failed</span>
        `;
        statusEl.className = 'batch-item__status failed';
        itemEl.classList.add('completed-item');
      }
    } catch (err) {
      statusEl.innerHTML = `
        <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 14px; height: 14px;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
        <span>Failed</span>
      `;
      statusEl.className = 'batch-item__status failed';
      itemEl.classList.add('completed-item');
      const detailsEl = document.getElementById(`batch-details-${i}`);
      if (detailsEl) detailsEl.style.display = 'none';
    } finally {
      itemEl.classList.remove('active');
      batchDownloading--;
      updateSummary();
    }
  }

  if (overallStatus) {
    overallStatus.textContent = `Completed ${completedTasks.length} of ${items.length} downloads`;
  }
  if (newDownloadBtn) {
    newDownloadBtn.style.display = 'inline-flex';
    newDownloadBtn.onclick = resetUI;
  }
  if (saveAllBtn && completedTasks.length > 0) {
    saveAllBtn.style.display = 'inline-flex';
    saveAllBtn.onclick = () => {
      completedTasks.forEach((t, idx) => {
        setTimeout(() => {
          window.open(`${API}/api/file/${t.taskId}`, '_blank');
        }, idx * 400);
      });
      showToast(`Downloading all ${completedTasks.length} files...`, 'info');
    };
  }

  showToast(`Batch download complete (${completedTasks.length}/${items.length} saved)`, 'success');
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
  currentPreviewUrl = null;
  currentThumbnailUrl = '';
  selectedVideos.clear();
  updateBatchBar();
  if (eventSource) { eventSource.close(); eventSource = null; }
  document.getElementById('urlInput').value = '';
  const cutCheck = document.getElementById('enableCutCheckbox');
  const cutInputs = document.getElementById('cutInputsContainer');
  const collapseBtn = document.getElementById('clipCollapseBtn');
  if (cutCheck) cutCheck.checked = false;
  if (cutInputs) cutInputs.classList.add('is-hidden');
  if (collapseBtn) collapseBtn.classList.add('is-collapsed');
  const cutStartInput = document.getElementById('cutStartInput');
  const cutEndInput = document.getElementById('cutEndInput');
  if (cutStartInput) cutStartInput.value = '00:00:00';
  if (cutEndInput) cutEndInput.value = '00:00:00';
  const startSlider = document.getElementById('cutStartSlider');
  const endSlider = document.getElementById('cutEndSlider');
  if (startSlider && endSlider) {
    startSlider.min = 0;
    startSlider.max = 100;
    startSlider.value = 0;
    endSlider.min = 0;
    endSlider.max = 100;
    endSlider.value = 100;
  }
  updateCutSliders();
  const thumbContainer = document.querySelector('.video-thumb');
  if (thumbContainer) {
    thumbContainer.innerHTML = `<img id="videoThumb" src="" alt="Video thumbnail">`;
  }
  const saveAllBtn = document.getElementById('batchSaveAllBtn');
  const newDownloadBtn = document.getElementById('batchNewDownloadBtn');
  if (saveAllBtn) saveAllBtn.style.display = 'none';
  if (newDownloadBtn) newDownloadBtn.style.display = 'none';
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
  ['searchResults', 'formatSection', 'progressSection',
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
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}
function formatBytes(b) {
  if (!b) return '—';
  if (b >= 1048576) return `${(b/1048576).toFixed(1)} MB`;
  if (b >= 1024) return `${(b/1024).toFixed(1)} KB`;
  return `${b} B`;
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
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  if (match && match[2].length === 11) {
    return `https://www.youtube.com/embed/${match[2]}`;
  }
  return null;
}

function formatSecondsToTime(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) {
    seconds = 0;
  }
  const total = Math.floor(Number(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((Number(seconds) % 1) * 100);
  let time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (ms > 0) {
    time += `.${String(ms).padStart(2, '0')}`;
  }
  return time;
}

function parseTimeToSeconds(timeStr) {
  if (typeof timeStr !== 'string') {
    if (typeof timeStr === 'number' && !isNaN(timeStr)) return timeStr;
    return 0;
  }
  timeStr = timeStr.trim();
  if (!timeStr) return 0;
  if (/^\d+(\.\d+)?$/.test(timeStr)) {
    return parseFloat(timeStr) || 0;
  }
  const parts = timeStr.split(':');
  try {
    if (parts.length === 2) {
      return (parseInt(parts[0], 10) || 0) * 60 + (parseFloat(parts[1]) || 0);
    } else if (parts.length === 3) {
      return (parseInt(parts[0], 10) || 0) * 3600 + (parseInt(parts[1], 10) || 0) * 60 + (parseFloat(parts[2]) || 0);
    }
  } catch(e) {}
  return 0;
}

function stepTime(field, deltaSeconds) {
  const startSlider = document.getElementById('cutStartSlider');
  const endSlider = document.getElementById('cutEndSlider');
  if (!startSlider || !endSlider) return;

  const max = parseFloat(startSlider.max) || 100;
  let startVal = parseFloat(startSlider.value) || 0;
  let endVal = parseFloat(endSlider.value) || max;

  if (field === 'start') {
    let newStart = Math.max(0, Math.min(startVal + deltaSeconds, endVal));
    startSlider.value = newStart;
  } else if (field === 'end') {
    let newEnd = Math.max(startVal, Math.min(endVal + deltaSeconds, max));
    endSlider.value = newEnd;
  }
  updateCutSliders();
  const videoEl = document.getElementById('videoPreviewPlayer');
  if (videoEl && !isNaN(videoEl.duration)) {
    videoEl.currentTime = (field === 'start' ? parseFloat(startSlider.value) : parseFloat(endSlider.value)) || 0;
  }
}

function handleStartSliderInput() {
  const startSlider = document.getElementById('cutStartSlider');
  const endSlider = document.getElementById('cutEndSlider');
  if (!startSlider || !endSlider) return;
  if (parseFloat(startSlider.value) > parseFloat(endSlider.value)) {
    startSlider.value = endSlider.value;
  }
  updateCutSliders();
  const videoEl = document.getElementById('videoPreviewPlayer');
  if (videoEl && !isNaN(videoEl.duration)) {
    videoEl.currentTime = parseFloat(startSlider.value) || 0;
  }
}

function handleEndSliderInput() {
  const startSlider = document.getElementById('cutStartSlider');
  const endSlider = document.getElementById('cutEndSlider');
  if (!startSlider || !endSlider) return;
  if (parseFloat(endSlider.value) < parseFloat(startSlider.value)) {
    endSlider.value = startSlider.value;
  }
  updateCutSliders();
  const videoEl = document.getElementById('videoPreviewPlayer');
  if (videoEl && !isNaN(videoEl.duration)) {
    videoEl.currentTime = parseFloat(endSlider.value) || 0;
  }
}

function handleTimeInputChange() {
  const startInput = document.getElementById('cutStartInput');
  const endInput = document.getElementById('cutEndInput');
  const startSlider = document.getElementById('cutStartSlider');
  const endSlider = document.getElementById('cutEndSlider');

  if (!startInput || !endInput || !startSlider || !endSlider) return;

  const max = parseFloat(startSlider.max) || 100;
  let startVal = parseTimeToSeconds(startInput.value);
  let endVal = parseTimeToSeconds(endInput.value);

  if (isNaN(startVal) || startVal < 0) startVal = 0;
  if (isNaN(endVal) || endVal <= 0) endVal = max;

  startVal = Math.max(0, Math.min(startVal, max));
  endVal = Math.max(0, Math.min(endVal, max));

  if (startVal > endVal) {
    endVal = startVal;
  }

  startSlider.value = startVal;
  endSlider.value = endVal;
  updateCutSliders();
}

function updateCutSliders() {
  const startSlider = document.getElementById('cutStartSlider');
  const endSlider = document.getElementById('cutEndSlider');
  const track = document.getElementById('cutSliderTrack');
  const startInput = document.getElementById('cutStartInput');
  const endInput = document.getElementById('cutEndInput');
  const startBadge = document.getElementById('startHandleBadge');
  const endBadge = document.getElementById('endHandleBadge');
  const durationBadge = document.getElementById('sliderClipDuration');
  const minLabel = document.getElementById('sliderMinLabel');
  const maxLabel = document.getElementById('sliderMaxLabel');

  if (!startSlider || !endSlider || !track || !startInput || !endInput) return;

  const max = parseFloat(startSlider.max) || 100;
  let startVal = parseFloat(startSlider.value) || 0;
  let endVal = parseFloat(endSlider.value) || max;

  if (startVal > endVal) {
    startVal = endVal;
    startSlider.value = startVal;
  }

  const leftPct = max > 0 ? Math.max(0, Math.min(100, (startVal / max) * 100)) : 0;
  const rightPct = max > 0 ? Math.max(0, Math.min(100, (endVal / max) * 100)) : 100;
  const widthPct = Math.max(0, rightPct - leftPct);

  track.style.left = `${leftPct}%`;
  track.style.width = `${widthPct}%`;

  const formattedStart = formatSecondsToTime(startVal);
  const formattedEnd = formatSecondsToTime(endVal);
  const formattedDiff = formatSecondsToTime(Math.max(0, endVal - startVal));

  startInput.value = formattedStart;
  endInput.value = formattedEnd;

  if (startBadge) {
    startBadge.textContent = formattedStart;
    startBadge.style.left = `${leftPct}%`;
  }

  if (endBadge) {
    endBadge.textContent = formattedEnd;
    endBadge.style.left = `${rightPct}%`;
  }

  if (durationBadge) {
    durationBadge.textContent = `Clip Length: ${formattedDiff}`;
  }

  if (minLabel) {
    minLabel.textContent = '00:00:00';
  }

  if (maxLabel) {
    maxLabel.textContent = formatSecondsToTime(max);
  }
}
