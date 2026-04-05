// popup.js – Control Center UI

let groups = [];
let isRunning = false;
let countdownInterval = null;

const $ = (id) => document.getElementById(id);

const postTitle      = $('postTitle');
const postContent    = $('postContent');
const postUrl        = $('postUrl');
const previewBox     = $('previewBox');
const groupUrlInput  = $('groupUrlInput');
const addGroupBtn    = $('addGroupBtn');
const groupList      = $('groupList');
const groupCount     = $('groupCount');
const dashboard      = $('dashboard');
const progressText   = $('progressText');
const progressPercent = $('progressPercent');
const progressBar    = $('progressBar');
const countdown      = $('countdown');
const startPostBtn    = $('startPostBtn');
const startCommentBtn = $('startCommentBtn');
const stopBtn         = $('stopBtn');
const logSection     = $('logSection');
const logToggle      = $('logToggle');
const logToggleLabel = $('logToggleLabel');
const logToggleArrow = $('logToggleArrow');
const logPanel       = $('logPanel');
const copyLogBtn     = $('copyLogBtn');
const clearLogBtn    = $('clearLogBtn');

let logPanelOpen = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  setupListeners();
  startPolling();
});

async function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['groups', 'postTitle', 'postContent', 'postUrl', 'isRunning', 'nextPostTime', 'lastRunLogs'],
      (data) => {
        groups    = data.groups    || [];
        isRunning = data.isRunning || false;

        if (data.postTitle)   postTitle.value   = data.postTitle;
        if (data.postContent) postContent.value = data.postContent;
        if (data.postUrl)     postUrl.value     = data.postUrl;

        renderGroupList();
        updatePreview();
        updateDashboard();
        updateButtons();

        if (isRunning && data.nextPostTime && data.nextPostTime > Date.now()) {
          startCountdown(data.nextPostTime);
        }

        if (data.lastRunLogs) renderLogs(data.lastRunLogs);

        resolve();
      }
    );
  });
}

// ─── Listeners ────────────────────────────────────────────────────────────────

function setupListeners() {
  postTitle.addEventListener('input',   () => { updatePreview(); saveContent(); });
  postContent.addEventListener('input', () => { updatePreview(); saveContent(); });
  postUrl.addEventListener('input',     () => { updatePreview(); saveContent(); });

  addGroupBtn.addEventListener('click', addGroup);
  groupUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addGroup(); });

  startPostBtn.addEventListener('click',    () => handleStart('post'));
  startCommentBtn.addEventListener('click', () => handleStart('comment'));
  stopBtn.addEventListener('click',  handleStop);

  logToggle.addEventListener('click', () => {
    logPanelOpen = !logPanelOpen;
    logPanel.style.display     = logPanelOpen ? 'block' : 'none';
    logToggleArrow.textContent = logPanelOpen ? '▲' : '▼';
  });

  copyLogBtn.addEventListener('click', async () => {
    chrome.storage.local.get(['lastRunLogs'], async (data) => {
      if (!data.lastRunLogs?.logs) return;
      const text = [
        `=== AutoPoster Log ===`,
        `Time:    ${data.lastRunLogs.ts || ''}`,
        `URL:     ${data.lastRunLogs.url || ''}`,
        `Status:  ${data.lastRunLogs.success ? '✅ Success' : '❌ Failed'}`,
        data.lastRunLogs.error ? `Error:   ${data.lastRunLogs.error}` : '',
        ``,
        ...data.lastRunLogs.logs,
      ].filter(l => l !== undefined).join('\n');

      try {
        await navigator.clipboard.writeText(text);
        copyLogBtn.textContent = '✅';
        setTimeout(() => { copyLogBtn.textContent = 'העתק'; }, 2000);
      } catch (_) {
        copyLogBtn.textContent = '❌';
        setTimeout(() => { copyLogBtn.textContent = 'העתק'; }, 2000);
      }
    });
  });

  clearLogBtn.addEventListener('click', () => {
    chrome.storage.local.remove('lastRunLogs', () => {
      logSection.style.display = 'none';
      logPanel.innerHTML = '';
      logPanelOpen = false;
      logPanel.style.display = 'none';
      logToggleArrow.textContent = '▼';
    });
  });
}

// ─── Preview ──────────────────────────────────────────────────────────────────

function updatePreview() {
  const title = postTitle.value.trim();
  const text  = postContent.value.trim();
  const url   = postUrl.value.trim();

  if (!title && !text && !url) {
    previewBox.innerHTML = '<span style="color:#bcc0c4;">תצוגה מקדימה תופיע כאן...</span>';
    return;
  }

  let html = '';
  if (title) {
    html += `<div style="font-weight:700;font-size:15px;margin-bottom:6px;line-height:1.4;">${escapeHtml(title)}</div>`;
  }
  if (text) {
    html += `<div style="margin-bottom:6px;line-height:1.5;">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
  }
  if (url) {
    html += `<div style="background:#e7f3ff;border:1px solid #1877f2;border-radius:4px;padding:6px 8px;font-size:12px;color:#1877f2;word-break:break-all;">${escapeHtml(url)}</div>`;
  }

  previewBox.innerHTML = html;
}

function saveContent() {
  chrome.storage.local.set({
    postTitle:   postTitle.value,
    postContent: postContent.value,
    postUrl:     postUrl.value,
  });
}

// ─── Group Management ─────────────────────────────────────────────────────────

function addGroup() {
  const url = groupUrlInput.value.trim();
  if (!url) return;

  if (!url.includes('facebook.com')) {
    alert('אנא הזן כתובת URL תקינה של קבוצת פייסבוק');
    return;
  }

  if (groups.some((g) => g.url === url)) {
    alert('קבוצה זו כבר קיימת ברשימה');
    groupUrlInput.value = '';
    return;
  }

  groups.push({
    id:     Date.now().toString(),
    url,
    name:   extractGroupName(url),
    status: 'pending',
  });

  groupUrlInput.value = '';
  saveGroups();
  renderGroupList();
  updateButtons();
}

function removeGroup(id) {
  if (isRunning) return;
  groups = groups.filter((g) => g.id !== id);
  saveGroups();
  renderGroupList();
  updateButtons();
}

function saveGroups() {
  chrome.storage.local.set({ groups });
}

function extractGroupName(url) {
  try {
    const m = url.match(/facebook\.com\/groups\/([^/?&#]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch (_) {}
  return url;
}

// ─── Render Group List ────────────────────────────────────────────────────────

function renderGroupList() {
  if (groups.length === 0) {
    groupList.innerHTML = '<div class="empty-state">לא נוספו קבוצות עדיין</div>';
    groupCount.textContent = '';
    return;
  }

  const pending    = groups.filter((g) => g.status === 'pending').length;
  const success    = groups.filter((g) => g.status === 'success').length;
  const failed     = groups.filter((g) => g.status === 'failed').length;
  const processing = groups.filter((g) => g.status === 'processing').length;

  groupCount.textContent =
    isRunning
      ? `✅ ${success}  ❌ ${failed}  🔄 ${processing}  ⏳ ${pending}`
      : `${groups.length} קבוצות ברשימה`;

  groupList.innerHTML = groups
    .map((g) => {
      const icon       = statusIcon(g.status);
      const iconClass  = `status-icon s-${g.status}`;
      const canDelete  = !isRunning;
      const errorLine  = g.error
        ? `<div class="group-error">שגיאה: ${escapeHtml(g.error)}</div>`
        : '';

      return `
        <div class="group-item">
          <span class="${iconClass}">${icon}</span>
          <div class="group-info">
            <div class="group-name">${escapeHtml(g.name)}</div>
            <div class="group-url">${escapeHtml(g.url)}</div>
            ${errorLine}
          </div>
          ${canDelete ? `<button class="btn-delete" data-id="${g.id}" title="הסר">✕</button>` : ''}
        </div>`;
    })
    .join('');

  groupList.querySelectorAll('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', () => removeGroup(btn.dataset.id));
  });
}

function statusIcon(status) {
  return { pending: '⏳', processing: '🔄', success: '✅', failed: '❌' }[status] || '⏳';
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function updateDashboard() {
  const total = groups.length;
  const done  = groups.filter((g) => g.status === 'success' || g.status === 'failed').length;

  if (total === 0 || (!isRunning && done === 0)) {
    dashboard.style.display = 'none';
    return;
  }

  dashboard.style.display = 'block';

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressText.textContent    = `${done}/${total} קבוצות`;
  progressPercent.textContent = `${pct}%`;
  progressBar.style.width     = `${pct}%`;
}

function updateButtons() {
  if (isRunning) {
    startPostBtn.disabled    = true;
    startCommentBtn.disabled = true;
    stopBtn.disabled         = false;
    startPostBtn.textContent    = '⏳ פרסום בתהליך...';
    startCommentBtn.textContent = '⏳ פרסום בתהליך...';
  } else {
    const noGroups = groups.length === 0;
    startPostBtn.disabled    = noGroups;
    startCommentBtn.disabled = noGroups;
    stopBtn.disabled         = true;
    startPostBtn.textContent    = '📝 התחל פרסום פוסט';
    startCommentBtn.textContent = '💬 התחל פרסום תגובה';
  }
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────

function handleStart(mode) {
  if (!postContent.value.trim() && !postUrl.value.trim()) {
    alert('אנא הזן תוכן לפוסט או קישור');
    return;
  }
  if (groups.length === 0) {
    alert('אנא הוסף לפחות קבוצה אחת');
    return;
  }

  // Reset statuses
  groups = groups.map((g) => ({ ...g, status: 'pending', error: undefined }));

  chrome.runtime.sendMessage({
    type: 'START',
    data: {
      title:   postTitle.value,
      content: postContent.value,
      url:     postUrl.value,
      mode,      // 'post' | 'comment'
      groups,
    },
  });

  isRunning = true;
  dashboard.style.display = 'block';
  updateButtons();
  renderGroupList();
  updateDashboard();
}

function handleStop() {
  chrome.runtime.sendMessage({ type: 'STOP' });
  isRunning = false;
  stopCountdown();
  updateButtons();
}

// ─── Countdown ────────────────────────────────────────────────────────────────

function startCountdown(nextPostTime) {
  stopCountdown();

  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, nextPostTime - Date.now());
    if (remaining === 0) {
      stopCountdown();
      countdown.textContent = '';
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    countdown.textContent = `⏱ ממתין ${secs} שניות עד לפרסום הבא`;
  }, 500);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

// ─── Polling ──────────────────────────────────────────────────────────────────

function startPolling() {
  setInterval(() => {
    chrome.storage.local.get(
      ['groups', 'isRunning', 'nextPostTime', 'lastRunLogs'],
      (data) => {
        const wasRunning = isRunning;
        isRunning = data.isRunning || false;

        if (data.groups) {
          groups = data.groups;
          renderGroupList();
          updateDashboard();
        }

        if (wasRunning !== isRunning) {
          updateButtons();
          if (!isRunning) stopCountdown();
        }

        if (isRunning && data.nextPostTime && data.nextPostTime > Date.now()) {
          startCountdown(data.nextPostTime);
        } else if (!isRunning) {
          stopCountdown();
        }

        if (data.lastRunLogs) renderLogs(data.lastRunLogs);
      }
    );
  }, 1200);
}

// ─── Log Panel ────────────────────────────────────────────────────────────────

function renderLogs(run) {
  if (!run || !run.logs) return;

  logSection.style.display = 'block';

  // Update toggle label with status
  const status = run.success
    ? `<span class="log-status-ok">✅ הצליח</span>`
    : `<span class="log-status-fail">❌ נכשל: ${escapeHtml(run.error || '')}</span>`;

  const time = run.ts ? new Date(run.ts).toLocaleTimeString('he-IL') : '';
  logToggleLabel.innerHTML = `📋 לוג ריצה אחרונה &nbsp;${status}&nbsp; <small style="color:#8a8d91">${time}</small>`;

  // Render log lines
  logPanel.innerHTML = run.logs.map(line => {
    let cls = 'log-line';
    if (line.includes('[FAIL]') || line.includes('[DONE]') && !run.success) cls += ' err';
    else if (line.includes('[DONE]') || line.includes('✅'))                cls += ' ok';
    else if (line.includes('NOT FOUND') || line.includes('WARNING'))        cls += ' warn';
    return `<div class="${cls}">${escapeHtml(line)}</div>`;
  }).join('');

  // Auto-scroll to bottom
  logPanel.scrollTop = logPanel.scrollHeight;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
