// background.js – Queue Manager & Tab Orchestrator (Service Worker) v2.0

const pendingResults = new Map(); // tabId → { resolve, reject, timer }
let processingTabId  = null;

// ─── Alarms ───────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'nextPost') {
    processNext();
  } else if (alarm.name.startsWith('campaign_')) {
    const campId = alarm.name.slice('campaign_'.length);
    triggerCampaign(campId);
  }
});

// ─── Messages ─────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'START':
      handleStart(msg.data).then(() => sendResponse({ ok: true }));
      return true; // async

    case 'STOP':
      handleStop();
      sendResponse({ ok: true });
      break;

    case 'POST_RESULT':
      handlePostResult(sender.tab?.id, msg.success, msg.error);
      return true;
  }
});

// ─── Spintax ──────────────────────────────────────────────────────────────────

function resolveSpintax(text) {
  if (!text) return text;
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

// ─── Start ────────────────────────────────────────────────────────────────────

async function handleStart({ title, content, url, mode, groups, delayMin, delayMax, campaignId }) {
  // Reset all groups to pending with fresh statuses
  const fresh = groups.map((g) => ({ ...g, status: 'pending', error: undefined }));

  await store({
    postTitle:         title   || '',
    postContent:       content || '',
    postUrl:           url     || '',
    postMode:          mode    || 'post',
    groups:            fresh,
    isRunning:         true,
    nextPostTime:      null,
    delayMin:          delayMin  || 110,
    delayMax:          delayMax  || 130,
    currentCampaignId: campaignId || null,
  });

  processNext();
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

async function handleStop() {
  chrome.alarms.clear('nextPost');

  // Reject any pending promise
  pendingResults.forEach(({ reject, timer }) => {
    clearTimeout(timer);
    reject(new Error('Stopped by user'));
  });
  pendingResults.clear();

  if (processingTabId !== null) {
    chrome.tabs.remove(processingTabId).catch(() => {});
    processingTabId = null;
  }

  // Mark any running campaign as failed
  const data = await load(['currentCampaignId']);
  if (data.currentCampaignId) {
    await completeCampaign(data.currentCampaignId, 'failed');
  }

  await store({ isRunning: false, nextPostTime: null, currentCampaignId: null });
}

// ─── Queue Processor ──────────────────────────────────────────────────────────

async function processNext() {
  const data = await load(['groups', 'postTitle', 'postContent', 'postUrl', 'postMode', 'isRunning', 'delayMin', 'delayMax', 'currentCampaignId']);
  if (!data.isRunning) return;

  const groups    = data.groups || [];
  const nextIndex = groups.findIndex((g) => g.status === 'pending');

  if (nextIndex === -1) {
    // All done
    if (data.currentCampaignId) {
      await completeCampaign(data.currentCampaignId, 'done');
    }
    await store({ isRunning: false, nextPostTime: null, currentCampaignId: null });
    return;
  }

  groups[nextIndex].status = 'processing';
  await store({ groups });

  const group = groups[nextIndex];

  try {
    // 1. Open tab (inactive initially)
    const tab = await chrome.tabs.create({ url: group.url, active: false });
    processingTabId = tab.id;

    // 2. Wait for page to fully load
    await waitForTabLoad(tab.id, 30000);

    // 3. Activate the tab — Facebook's Lexical editor requires an active window
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(1500);

    // 4. Extra wait for React/Lexical hydration
    await sleep(3500);

    // 5. Store task with spintax resolved per-group
    await store({
      currentTask: {
        title:   resolveSpintax(data.postTitle  || ''),
        content: resolveSpintax(data.postContent || ''),
        url:     data.postUrl || '',
        mode:    data.postMode || 'post',
      },
    });

    // 6. Inject content script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ['content.js'],
    });

    // 7. Await result (max 75s)
    await waitForResult(tab.id, 75000);

    // ── Success ──
    await markGroup(group.id, 'success');

  } catch (e) {
    console.warn(`[AutoPoster] Group failed: ${e.message}`);
    await markGroup(group.id, 'failed', e.message);
  }

  // 8. Close tab
  if (processingTabId !== null) {
    chrome.tabs.remove(processingTabId).catch(() => {});
    processingTabId = null;
  }

  // 9. Schedule next post after delay
  scheduleNext();
}

// ─── Schedule Next ────────────────────────────────────────────────────────────

async function scheduleNext() {
  const data = await load(['isRunning', 'groups', 'delayMin', 'delayMax']);
  if (!data.isRunning) return;

  const groups = data.groups || [];
  if (!groups.some((g) => g.status === 'pending')) {
    await store({ isRunning: false, nextPostTime: null });
    return;
  }

  const minSec = (parseInt(data.delayMin, 10) || 110);
  const maxSec = (parseInt(data.delayMax, 10) || 130);
  const rangeSec = Math.max(0, maxSec - minSec);

  const delayMs      = minSec * 1000 + Math.floor(Math.random() * rangeSec * 1000);
  const delayMin     = delayMs / 60_000;
  const nextPostTime = Date.now() + delayMs;

  await store({ nextPostTime });
  chrome.alarms.create('nextPost', { delayInMinutes: delayMin });
}

// ─── Post Result Handler ──────────────────────────────────────────────────────

async function handlePostResult(tabId, success, error) {
  if (tabId == null) return;
  const pending = pendingResults.get(tabId);

  if (pending) {
    // Normal path: service worker was alive
    clearTimeout(pending.timer);
    pendingResults.delete(tabId);
    if (success) pending.resolve();
    else         pending.reject(new Error(error || 'Post failed'));
    return;
  }

  // Fallback: SW was killed and restarted while waiting.
  // pendingResults is empty — processNext() chain is dead.
  console.warn('[AutoPoster] SW was restarted — handling result via storage fallback');
  const data   = await load(['groups']);
  const groups = data.groups || [];
  const idx    = groups.findIndex(g => g.status === 'processing');
  if (idx !== -1) {
    groups[idx].status = success ? 'success' : 'failed';
    if (!success && error) groups[idx].error = error;
    await store({ groups });
  }

  chrome.tabs.remove(tabId).catch(() => {});
  processingTabId = null;
  scheduleNext();
}

// ─── Campaign Trigger ─────────────────────────────────────────────────────────

async function triggerCampaign(campId) {
  const data = await load(['campaigns', 'groupLists', 'isRunning']);
  const campaigns  = data.campaigns  || [];
  const groupLists = data.groupLists || [];

  if (data.isRunning) {
    // Reschedule +5 minutes and wait
    console.warn('[AutoPoster] Campaign trigger: already running, rescheduling +5min');
    chrome.alarms.create('campaign_' + campId, { delayInMinutes: 5 });
    return;
  }

  const camp = campaigns.find(c => c.id === campId);
  if (!camp) {
    console.warn('[AutoPoster] Campaign not found:', campId);
    return;
  }

  const list = groupLists.find(l => l.id === camp.listId);
  if (!list) {
    console.warn('[AutoPoster] List not found for campaign:', camp.listId);
    // Mark campaign failed
    camp.status = 'failed';
    await store({ campaigns });
    return;
  }

  // Mark campaign as running
  camp.status = 'running';
  await store({ campaigns });

  // Kick off posting
  await handleStart({
    title:      camp.title   || '',
    content:    camp.content || '',
    url:        camp.url     || '',
    mode:       camp.mode    || 'post',
    groups:     list.groups.map(g => ({ ...g, status: 'pending', error: undefined })),
    delayMin:   110,
    delayMax:   130,
    campaignId: camp.id,
  });
}

// ─── Complete Campaign ────────────────────────────────────────────────────────

async function completeCampaign(campId, status) {
  if (!campId) return;
  const data      = await load(['campaigns']);
  const campaigns = data.campaigns || [];
  const camp      = campaigns.find(c => c.id === campId);
  if (!camp) return;
  camp.status = status;
  await store({ campaigns });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function waitForResult(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResults.delete(tabId);
      reject(new Error(`Timeout (${timeout / 1000}s) waiting for post result`));
    }, timeout);
    pendingResults.set(tabId, { resolve, reject, timer });
  });
}

function waitForTabLoad(tabId, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeout);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    // Might already be loaded
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {});
  });
}

async function markGroup(id, status, error = undefined) {
  const data   = await load(['groups']);
  const groups = data.groups || [];
  const idx    = groups.findIndex((g) => g.id === id);
  if (idx === -1) return;
  groups[idx].status = status;
  if (error) groups[idx].error = error;
  await store({ groups });
}

function store(obj) { return new Promise((res) => chrome.storage.local.set(obj, res)); }
function load(keys)  { return new Promise((res) => chrome.storage.local.get(keys, res)); }
function sleep(ms)   { return new Promise((r)   => setTimeout(r, ms)); }
