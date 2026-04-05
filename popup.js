// popup.js – AutoPoster v2.0 Control Center

// ════════════════════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════════════════════

let groupLists      = [];   // [{ id, name, groups: [{id, url, name}] }]
let campaigns       = [];   // [{ id, name, scheduledAt, listId, mode, title, content, url, status }]
let isRunning       = false;
let currentGroups   = [];   // live group statuses from background
let countdownInterval = null;
let editingListId   = null;

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/**
 * Resolve spintax: {a|b|c} → randomly picked option (recursive)
 */
function resolveSpintax(text) {
  if (!text) return text;
  // Replace each {…|…} group with a random choice
  let result = text;
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 20) {
    changed = false;
    result = result.replace(/\{([^{}]+)\}/g, (_match, inner) => {
      const options = inner.split('|');
      changed = true;
      return options[Math.floor(Math.random() * options.length)];
    });
  }
  return result;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function formatDateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('he-IL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  setupTabs();
  setupMainTab();
  setupGroupsTab();
  setupScheduleTab();
  setupReportsTab();
  startPolling();
});

// ════════════════════════════════════════════════════════════════════════════
// LOAD ALL
// ════════════════════════════════════════════════════════════════════════════

async function loadAll() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['groupLists', 'campaigns', 'postTitle', 'postContent', 'postUrl',
       'delayMin', 'delayMax', 'isRunning', 'nextPostTime', 'lastRunLogs', 'groups'],
      (data) => {
        groupLists   = data.groupLists  || [];
        campaigns    = data.campaigns   || [];
        isRunning    = data.isRunning   || false;
        currentGroups = data.groups     || [];

        // Restore main tab fields
        if (data.postTitle)   $('postTitle').value   = data.postTitle;
        if (data.postContent) $('postContent').value = data.postContent;
        if (data.postUrl)     $('postUrl').value     = data.postUrl;
        if (data.delayMin)    $('delayMin').value    = data.delayMin;
        if (data.delayMax)    $('delayMax').value    = data.delayMax;

        updatePreview();
        renderListSelector();
        renderCampListSelector();
        updateListCountDisplay();
        updateDashboard();
        updateButtons();

        if (isRunning && data.nextPostTime && data.nextPostTime > Date.now()) {
          startCountdown(data.nextPostTime);
        }

        if (data.lastRunLogs) renderLogs(data.lastRunLogs);

        // Render groups/schedule tabs
        renderGroupLists();
        renderCampaigns();

        resolve();
      }
    );
  });
}

// ════════════════════════════════════════════════════════════════════════════
// TABS
// ════════════════════════════════════════════════════════════════════════════

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      // Toggle buttons
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Toggle panes
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      const pane = $(target);
      if (pane) pane.classList.add('active');
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN TAB
// ════════════════════════════════════════════════════════════════════════════

function setupMainTab() {
  $('postTitle').addEventListener('input',   () => { updatePreview(); saveContent(); });
  $('postContent').addEventListener('input', () => { updatePreview(); saveContent(); });
  $('postUrl').addEventListener('input',     () => { updatePreview(); saveContent(); });

  $('clearFieldsBtn').addEventListener('click', () => {
    $('postTitle').value   = '';
    $('postContent').value = '';
    $('postUrl').value     = '';
    updatePreview();
    saveContent();
  });

  $('delayMin').addEventListener('change', saveDelays);
  $('delayMax').addEventListener('change', saveDelays);

  $('listSelector').addEventListener('change', updateListCountDisplay);

  $('startPostBtn').addEventListener('click',    () => handleStart('post'));
  $('startCommentBtn').addEventListener('click', () => handleStart('comment'));
  $('stopBtn').addEventListener('click', handleStop);
}

// ── List Selector ──────────────────────────────────────────────────────────

function renderListSelector() {
  const sel = $('listSelector');
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">— בחר רשימה —</option>';
  groupLists.forEach((list) => {
    const opt = document.createElement('option');
    opt.value = list.id;
    opt.textContent = `${list.name} (${list.groups.length})`;
    sel.appendChild(opt);
  });
  // Restore selection if still valid
  if (currentVal && groupLists.some(l => l.id === currentVal)) {
    sel.value = currentVal;
  }
  updateListCountDisplay();
  updateButtons();
}

function updateListCountDisplay() {
  const listId = $('listSelector').value;
  const info   = $('listGroupCount');
  if (!listId) {
    info.textContent = '';
    return;
  }
  const list = groupLists.find(l => l.id === listId);
  info.textContent = list ? `${list.groups.length} קבוצות ברשימה` : '';
}

// ── Preview ────────────────────────────────────────────────────────────────

function updatePreview() {
  const title = $('postTitle').value.trim();
  const text  = $('postContent').value.trim();
  const url   = $('postUrl').value.trim();

  if (!title && !text && !url) {
    $('previewBox').innerHTML = '<span style="color:#bcc0c4;">תצוגה מקדימה תופיע כאן...</span>';
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
  $('previewBox').innerHTML = html;
}

// ── Save Helpers ───────────────────────────────────────────────────────────

function saveContent() {
  chrome.storage.local.set({
    postTitle:   $('postTitle').value,
    postContent: $('postContent').value,
    postUrl:     $('postUrl').value,
  });
}

function saveDelays() {
  const minVal = parseInt($('delayMin').value, 10) || 110;
  const maxVal = parseInt($('delayMax').value, 10) || 130;
  chrome.storage.local.set({ delayMin: minVal, delayMax: maxVal });
}

// ── Start / Stop ───────────────────────────────────────────────────────────

function handleStart(mode) {
  const listId = $('listSelector').value;
  if (!listId) {
    alert('אנא בחר רשימת קבוצות');
    return;
  }
  const list = groupLists.find(l => l.id === listId);
  if (!list || list.groups.length === 0) {
    alert('הרשימה הנבחרת ריקה — הוסף קבוצות תחילה');
    return;
  }
  const content = $('postContent').value.trim();
  const url     = $('postUrl').value.trim();
  if (!content && !url) {
    alert('אנא הזן תוכן לפוסט או קישור');
    return;
  }

  const groups = list.groups.map(g => ({ ...g, status: 'pending', error: undefined }));

  chrome.runtime.sendMessage({
    type: 'START',
    data: {
      title:    $('postTitle').value,
      content:  $('postContent').value,
      url:      $('postUrl').value,
      mode,
      groups,
      delayMin: parseInt($('delayMin').value, 10) || 110,
      delayMax: parseInt($('delayMax').value, 10) || 130,
    },
  });

  isRunning = true;
  $('dashboard').style.display = 'block';
  updateButtons();
  updateDashboard();
}

function handleStop() {
  chrome.runtime.sendMessage({ type: 'STOP' });
  isRunning = false;
  stopCountdown();
  updateButtons();
}

// ── Buttons State ──────────────────────────────────────────────────────────

function updateButtons() {
  const hasList = !!$('listSelector').value;

  if (isRunning) {
    $('startPostBtn').disabled    = true;
    $('startCommentBtn').disabled = true;
    $('stopBtn').disabled         = false;
    $('startPostBtn').textContent    = '⏳ פרסום בתהליך...';
    $('startCommentBtn').textContent = '⏳ פרסום בתהליך...';
  } else {
    $('startPostBtn').disabled    = !hasList;
    $('startCommentBtn').disabled = !hasList;
    $('stopBtn').disabled         = true;
    $('startPostBtn').textContent    = '📝 פרסם פוסט';
    $('startCommentBtn').textContent = '💬 פרסם תגובה';
  }
}

// ── Dashboard ──────────────────────────────────────────────────────────────

function updateDashboard() {
  const groups = currentGroups;
  const total  = groups.length;
  const done   = groups.filter(g => g.status === 'success' || g.status === 'failed').length;

  if (total === 0 || (!isRunning && done === 0)) {
    $('dashboard').style.display = 'none';
    return;
  }

  $('dashboard').style.display = 'block';

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $('progressText').textContent    = `${done}/${total} קבוצות`;
  $('progressPercent').textContent = `${pct}%`;
  $('progressBar').style.width     = `${pct}%`;

  if (isRunning) {
    const success    = groups.filter(g => g.status === 'success').length;
    const failed     = groups.filter(g => g.status === 'failed').length;
    const processing = groups.filter(g => g.status === 'processing').length;
    $('groupStats').textContent = `✅ ${success}  ❌ ${failed}  🔄 ${processing}  ⏳ ${total - done - processing}`;
  } else {
    $('groupStats').textContent = '';
  }
}

// ── Countdown ──────────────────────────────────────────────────────────────

function startCountdown(nextPostTime) {
  stopCountdown();
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, nextPostTime - Date.now());
    if (remaining === 0) {
      stopCountdown();
      $('countdown').textContent = '';
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    $('countdown').textContent = `⏱ ממתין ${secs} שניות עד לפרסום הבא`;
  }, 500);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// POLLING
// ════════════════════════════════════════════════════════════════════════════

function startPolling() {
  setInterval(() => {
    chrome.storage.local.get(
      ['isRunning', 'nextPostTime', 'lastRunLogs', 'groups'],
      (data) => {
        const wasRunning = isRunning;
        isRunning = data.isRunning || false;

        if (data.groups) {
          currentGroups = data.groups;
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
          if ($('countdown')) $('countdown').textContent = '';
        }

        if (data.lastRunLogs) renderLogs(data.lastRunLogs);
      }
    );
  }, 1200);
}

// ════════════════════════════════════════════════════════════════════════════
// GROUPS TAB
// ════════════════════════════════════════════════════════════════════════════

function setupGroupsTab() {
  // New list form toggle
  $('newListBtn').addEventListener('click', () => {
    const form = $('newListForm');
    const visible = form.style.display !== 'none';
    form.style.display = visible ? 'none' : 'block';
    if (!visible) $('newListName').focus();
  });

  $('cancelNewListBtn').addEventListener('click', () => {
    $('newListForm').style.display = 'none';
    $('newListName').value = '';
  });

  $('createListBtn').addEventListener('click', createList);
  $('newListName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createList();
  });

  // Back button
  $('backToListsBtn').addEventListener('click', () => {
    editingListId = null;
    $('groupsListView').style.display = 'block';
    $('groupsEditView').style.display = 'none';
  });

  // Save list name
  $('saveListNameBtn').addEventListener('click', () => {
    const list = groupLists.find(l => l.id === editingListId);
    if (!list) return;
    const newName = $('editListName').value.trim();
    if (!newName) return;
    list.name = newName;
    saveGroupLists();
    $('editListTitle').textContent = newName;
    renderListSelector();
    renderCampListSelector();
    renderGroupLists();
  });

  // Add group
  $('addGroupToListBtn').addEventListener('click', addGroupToList);
  $('newGroupUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addGroupToList();
  });

  // Import groups toggle
  $('importGroupsToListBtn').addEventListener('click', () => {
    const box = $('importGroupsBox');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
    if (box.style.display === 'block') $('importGroupsInput').focus();
  });

  $('importGroupsCancelBtn').addEventListener('click', () => {
    $('importGroupsBox').style.display = 'none';
    $('importGroupsInput').value = '';
  });

  $('importGroupsConfirmBtn').addEventListener('click', importGroupsToList);
}

// ── Create List ────────────────────────────────────────────────────────────

function createList() {
  const name = $('newListName').value.trim();
  if (!name) return;

  groupLists.push({ id: uid(), name, groups: [] });
  $('newListName').value = '';
  $('newListForm').style.display = 'none';

  saveGroupLists();
  renderGroupLists();
  renderListSelector();
  renderCampListSelector();
}

// ── Delete List ────────────────────────────────────────────────────────────

function deleteList(id) {
  const list = groupLists.find(l => l.id === id);
  if (!list) return;
  if (!confirm(`למחוק את הרשימה "${list.name}"?`)) return;
  groupLists = groupLists.filter(l => l.id !== id);
  saveGroupLists();
  renderGroupLists();
  renderListSelector();
  renderCampListSelector();
}

// ── Open Edit View ─────────────────────────────────────────────────────────

function openEditList(id) {
  const list = groupLists.find(l => l.id === id);
  if (!list) return;
  editingListId = id;
  $('editListName').value     = list.name;
  $('editListTitle').textContent = list.name;
  $('groupsListView').style.display = 'none';
  $('groupsEditView').style.display = 'block';
  renderEditGroupList();
}

// ── Add Group to List ──────────────────────────────────────────────────────

function addGroupToList() {
  const list = groupLists.find(l => l.id === editingListId);
  if (!list) return;

  const url = $('newGroupUrl').value.trim();
  if (!url) return;

  if (!url.includes('facebook.com')) {
    alert('אנא הזן כתובת URL תקינה של קבוצת פייסבוק');
    return;
  }
  if (list.groups.some(g => g.url === url)) {
    alert('קבוצה זו כבר קיימת ברשימה');
    $('newGroupUrl').value = '';
    return;
  }

  list.groups.push({ id: uid(), url, name: extractGroupName(url) });
  $('newGroupUrl').value = '';

  saveGroupLists();
  renderEditGroupList();
  renderListSelector();
  updateListCountDisplay();
}

// ── Remove Group from List ─────────────────────────────────────────────────

function removeGroupFromList(groupId) {
  const list = groupLists.find(l => l.id === editingListId);
  if (!list) return;
  list.groups = list.groups.filter(g => g.id !== groupId);
  saveGroupLists();
  renderEditGroupList();
  renderListSelector();
  updateListCountDisplay();
}

// ── Import Groups ──────────────────────────────────────────────────────────

function importGroupsToList() {
  const list = groupLists.find(l => l.id === editingListId);
  if (!list) return;

  const lines = $('importGroupsInput').value
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.includes('facebook.com'));

  let added = 0;
  for (const url of lines) {
    if (list.groups.some(g => g.url === url)) continue;
    list.groups.push({ id: uid(), url, name: extractGroupName(url) });
    added++;
  }

  $('importGroupsInput').value = '';
  $('importGroupsBox').style.display = 'none';

  saveGroupLists();
  renderEditGroupList();
  renderListSelector();
  updateListCountDisplay();

  if (added === 0) alert('לא נוספו קבוצות חדשות (כולן כבר קיימות או לא תקינות)');
  else alert(`נוספו ${added} קבוצות`);
}

// ── Save / Extract ─────────────────────────────────────────────────────────

function saveGroupLists() {
  chrome.storage.local.set({ groupLists });
}

function extractGroupName(url) {
  try {
    const m = url.match(/facebook\.com\/groups\/([^/?&#]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch (_) {}
  return url;
}

// ── Render: Lists ──────────────────────────────────────────────────────────

function renderGroupLists() {
  const container = $('groupListsContainer');
  if (groupLists.length === 0) {
    container.innerHTML = '<div class="empty-state">אין רשימות עדיין. לחץ "+ רשימה חדשה" להתחיל.</div>';
    return;
  }

  container.innerHTML = groupLists.map(list => `
    <div class="list-card">
      <div class="list-card-info">
        <div class="list-card-name">${escapeHtml(list.name)}</div>
        <div class="list-card-count">${list.groups.length} קבוצות</div>
      </div>
      <button class="btn btn-ghost btn-sm" data-edit="${list.id}">✏️ עריכה</button>
      <button class="btn-icon" data-delete="${list.id}" title="מחק רשימה">🗑</button>
    </div>
  `).join('');

  container.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => openEditList(btn.dataset.edit));
  });
  container.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteList(btn.dataset.delete));
  });
}

// ── Render: Edit Group List ────────────────────────────────────────────────

function renderEditGroupList() {
  const list = groupLists.find(l => l.id === editingListId);
  const container = $('editGroupList');
  const countEl   = $('editGroupCount');

  if (!list || list.groups.length === 0) {
    container.innerHTML = '<div class="empty-state">אין קבוצות ברשימה זו עדיין</div>';
    if (countEl) countEl.textContent = '';
    return;
  }

  container.innerHTML = list.groups.map(g => `
    <div class="group-item">
      <div class="group-item-info">
        <div class="group-item-name">${escapeHtml(g.name)}</div>
        <div class="group-item-url">${escapeHtml(g.url)}</div>
      </div>
      <button class="btn-icon" data-remove="${g.id}" title="הסר">✕</button>
    </div>
  `).join('');

  container.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => removeGroupFromList(btn.dataset.remove));
  });

  if (countEl) countEl.textContent = `${list.groups.length} קבוצות`;
}

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULE TAB
// ════════════════════════════════════════════════════════════════════════════

function setupScheduleTab() {
  $('scheduleCampBtn').addEventListener('click', createCampaign);
}

// ── Camp List Selector ─────────────────────────────────────────────────────

function renderCampListSelector() {
  const sel = $('campListSelector');
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">— בחר רשימה —</option>';
  groupLists.forEach((list) => {
    const opt = document.createElement('option');
    opt.value = list.id;
    opt.textContent = `${list.name} (${list.groups.length})`;
    sel.appendChild(opt);
  });
  if (currentVal && groupLists.some(l => l.id === currentVal)) {
    sel.value = currentVal;
  }
}

// ── Create Campaign ────────────────────────────────────────────────────────

function createCampaign() {
  const name     = $('campName').value.trim();
  const dateStr  = $('campDateTime').value;
  const listId   = $('campListSelector').value;
  const mode     = $('campMode').value;
  const title    = $('campTitle').value.trim();
  const content  = $('campContent').value.trim();
  const url      = $('campUrl').value.trim();

  if (!name)    { alert('אנא הזן שם לקמפיין');          return; }
  if (!dateStr) { alert('אנא בחר תאריך ושעה');           return; }
  if (!listId)  { alert('אנא בחר רשימת קבוצות');         return; }
  if (!content && !url) { alert('אנא הזן תוכן או קישור'); return; }

  const scheduledAt = new Date(dateStr).getTime();
  if (scheduledAt <= Date.now()) {
    alert('תאריך הפרסום חייב להיות בעתיד');
    return;
  }

  const camp = {
    id: uid(),
    name, scheduledAt, listId, mode, title, content, url,
    status: 'pending',
  };

  campaigns.push(camp);
  saveCampaigns();

  // Register Chrome alarm
  chrome.alarms.create('campaign_' + camp.id, { when: scheduledAt });

  renderCampaigns();

  // Clear form
  $('campName').value     = '';
  $('campDateTime').value = '';
  $('campListSelector').value = '';
  $('campTitle').value    = '';
  $('campContent').value  = '';
  $('campUrl').value      = '';
}

// ── Delete Campaign ────────────────────────────────────────────────────────

function deleteCampaign(id) {
  const camp = campaigns.find(c => c.id === id);
  if (!camp) return;
  if (!confirm(`לבטל את הקמפיין "${camp.name}"?`)) return;
  campaigns = campaigns.filter(c => c.id !== id);
  saveCampaigns();
  chrome.alarms.clear('campaign_' + id);
  renderCampaigns();
}

// ── Save Campaigns ─────────────────────────────────────────────────────────

function saveCampaigns() {
  chrome.storage.local.set({ campaigns });
}

// ── Render Campaigns ───────────────────────────────────────────────────────

function renderCampaigns() {
  const upcoming = campaigns
    .filter(c => c.status === 'pending' || c.status === 'running')
    .sort((a, b) => a.scheduledAt - b.scheduledAt);

  const past = campaigns
    .filter(c => c.status === 'done' || c.status === 'failed')
    .sort((a, b) => b.scheduledAt - a.scheduledAt)
    .slice(0, 10);

  const upcomingEl = $('upcomingCampaigns');
  const pastEl     = $('pastCampaigns');

  if (upcoming.length === 0) {
    upcomingEl.innerHTML = '<div class="empty-state">אין קמפיינים מתוזמנים</div>';
  } else {
    upcomingEl.innerHTML = upcoming.map(c => campItemHtml(c, true)).join('');
    upcomingEl.querySelectorAll('[data-cancel]').forEach(btn => {
      btn.addEventListener('click', () => deleteCampaign(btn.dataset.cancel));
    });
  }

  if (past.length === 0) {
    pastEl.innerHTML = '<div class="empty-state">אין קמפיינים בהיסטוריה</div>';
  } else {
    pastEl.innerHTML = past.map(c => campItemHtml(c, false)).join('');
  }
}

function campItemHtml(camp, showCancel) {
  const statusLabel = { pending: 'ממתין', running: 'פועל', done: 'הושלם', failed: 'נכשל' }[camp.status] || camp.status;
  const list = groupLists.find(l => l.id === camp.listId);
  const listName = list ? list.name : '—';
  const modeLabel = camp.mode === 'comment' ? '💬 תגובה' : '📝 פוסט';

  return `
    <div class="camp-item">
      <div class="camp-item-header">
        <div class="camp-item-name">${escapeHtml(camp.name)}</div>
        <span class="camp-status ${camp.status}">${statusLabel}</span>
        ${showCancel && camp.status === 'pending'
          ? `<button class="btn-icon" data-cancel="${camp.id}" title="בטל">✕</button>`
          : ''}
      </div>
      <div class="camp-item-meta">
        <span>📅 ${formatDateTime(camp.scheduledAt)}</span>
        <span>👥 ${escapeHtml(listName)}</span>
        <span>${modeLabel}</span>
      </div>
    </div>
  `;
}

// ════════════════════════════════════════════════════════════════════════════
// REPORTS TAB
// ════════════════════════════════════════════════════════════════════════════

function setupReportsTab() {
  $('copyLogBtn').addEventListener('click', async () => {
    chrome.storage.local.get(['lastRunLogs'], async (data) => {
      if (!data.lastRunLogs?.logs) return;
      const run = data.lastRunLogs;
      const text = [
        '=== AutoPoster Log ===',
        `Time:   ${run.ts || ''}`,
        `URL:    ${run.url || ''}`,
        `Status: ${run.success ? '✅ Success' : '❌ Failed'}`,
        run.error ? `Error:  ${run.error}` : '',
        '',
        ...run.logs,
      ].filter(l => l !== undefined).join('\n');

      try {
        await navigator.clipboard.writeText(text);
        $('copyLogBtn').textContent = '✅';
        setTimeout(() => { $('copyLogBtn').textContent = '📋 העתק'; }, 2000);
      } catch (_) {
        $('copyLogBtn').textContent = '❌';
        setTimeout(() => { $('copyLogBtn').textContent = '📋 העתק'; }, 2000);
      }
    });
  });

  $('clearLogBtn').addEventListener('click', () => {
    chrome.storage.local.remove('lastRunLogs', () => {
      $('reportStatus').textContent = 'אין לוג זמין';
      $('reportStatus').style.color = '#bcc0c4';
      $('logPanel').innerHTML = '<div style="color:#606770; text-align:center; padding:10px;">אין נתוני לוג להצגה</div>';
    });
  });
}

// ── Render Logs ────────────────────────────────────────────────────────────

function renderLogs(run) {
  if (!run || !run.logs) return;

  const statusEl = $('reportStatus');
  const time = run.ts ? new Date(run.ts).toLocaleTimeString('he-IL') : '';

  if (run.success) {
    statusEl.innerHTML = `<span style="color:#42b72a;font-weight:700;">✅ הצליח</span> &nbsp;<small style="color:#8a8d91">${escapeHtml(time)}</small>`;
  } else {
    statusEl.innerHTML = `<span style="color:#fa3e3e;font-weight:700;">❌ נכשל</span> ${escapeHtml(run.error || '')} &nbsp;<small style="color:#8a8d91">${escapeHtml(time)}</small>`;
  }

  const panel = $('logPanel');
  panel.innerHTML = run.logs.map(line => {
    let cls = 'log-line';
    if (line.includes('[FAIL]') || (line.includes('[DONE]') && !run.success)) cls += ' err';
    else if (line.includes('[DONE]') || line.includes('✅'))                   cls += ' ok';
    else if (line.includes('NOT FOUND') || line.includes('WARNING'))           cls += ' warn';
    return `<div class="${cls}">${escapeHtml(line)}</div>`;
  }).join('');

  panel.scrollTop = panel.scrollHeight;
}
