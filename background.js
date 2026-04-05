// background.js – Queue Manager & Tab Orchestrator (Service Worker)

const pendingResults = new Map(); // tabId → { resolve, reject, timer }
let processingTabId  = null;

// ─── Alarms ───────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'nextPost') processNext();
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
      break;
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function handleStart({ title, content, url, mode, groups }) {
  // Reset all groups to pending
  const fresh = groups.map((g) => ({ ...g, status: 'pending', error: undefined }));

  await store({
    postTitle:    title  || '',
    postContent:  content,
    postUrl:      url,
    postMode:     mode || 'post',   // 'post' | 'comment'
    groups:       fresh,
    isRunning:    true,
    nextPostTime: null,
  });

  processNext();
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

function handleStop() {
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

  store({ isRunning: false, nextPostTime: null });
}

// ─── Queue Processor ──────────────────────────────────────────────────────────

async function processNext() {
  const data = await load(['groups', 'postTitle', 'postContent', 'postUrl', 'isRunning']);
  if (!data.isRunning) return;

  const groups    = data.groups || [];
  const nextIndex = groups.findIndex((g) => g.status === 'pending');

  if (nextIndex === -1) {
    // All done
    await store({ isRunning: false, nextPostTime: null });
    return;
  }

  groups[nextIndex].status = 'processing';
  await store({ groups });

  const group = groups[nextIndex];

  try {
    // 1. Open tab (hidden initially)
    const tab = await chrome.tabs.create({ url: group.url, active: false });
    processingTabId = tab.id;

    // 2. Wait for page to fully load
    await waitForTabLoad(tab.id, 30000);

    // 3. ACTIVATE the tab — execCommand, focus(), and DOM events are silently
    //    blocked in inactive/background tabs. Facebook's Lexical editor requires
    //    an active, focused window to accept input.
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(1500); // let focus event fire

    // 4. Extra wait for React/Lexical hydration
    await sleep(3500);

    // 5. Store task data for content script
    await store({
      currentTask: {
        title:   data.postTitle  || '',
        content: data.postContent,
        url:     data.postUrl,
        mode:    data.postMode || 'post',
      },
    });

    // 6. Inject content script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ['content.js'],
    });

    // 7. Await result (max 75 s)
    await waitForResult(tab.id, 75000);

    // ── Success ──
    await markGroup(group.id, 'success');

  } catch (e) {
    console.warn(`[AutoPoster] Group failed: ${e.message}`);
    await markGroup(group.id, 'failed', e.message);
  }

  // 7. Close tab
  if (processingTabId !== null) {
    chrome.tabs.remove(processingTabId).catch(() => {});
    processingTabId = null;
  }

  // 8. Schedule next post after delay
  scheduleNext();
}

// ─── Schedule Next ────────────────────────────────────────────────────────────

async function scheduleNext() {
  const data = await load(['isRunning', 'groups']);
  if (!data.isRunning) return;

  // Check if there are more pending groups
  const groups = data.groups || [];
  if (!groups.some((g) => g.status === 'pending')) {
    await store({ isRunning: false, nextPostTime: null });
    return;
  }

  // Randomised delay: 110–130 seconds
  const delayMs   = 110_000 + Math.floor(Math.random() * 20_000);
  const delayMin  = delayMs / 60_000;
  const nextPostTime = Date.now() + delayMs;

  await store({ nextPostTime });
  chrome.alarms.create('nextPost', { delayInMinutes: delayMin });
}

// ─── Post Result Handler ──────────────────────────────────────────────────────

function handlePostResult(tabId, success, error) {
  if (tabId == null) return;
  const pending = pendingResults.get(tabId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingResults.delete(tabId);

  if (success) pending.resolve();
  else         pending.reject(new Error(error || 'Post failed'));
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

function store(obj)  { return new Promise((res) => chrome.storage.local.set(obj, res)); }
function load(keys)  { return new Promise((res) => chrome.storage.local.get(keys, res)); }
function sleep(ms)   { return new Promise((r)   => setTimeout(r, ms)); }
