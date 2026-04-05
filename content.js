// content.js – Facebook DOM Executor (v3 – post vs comment modes)

(async () => {
  'use strict';

  if (window.__autoPosterRunning) return;
  window.__autoPosterRunning = true;

  // ── Config ──────────────────────────────────────────────────────────────────
  const TASK_TIMEOUT      = 70_000;
  const EDITOR_WAIT       = 14_000;
  const LINK_PREVIEW_WAIT = 12_000;
  const TYPE_MIN          = 30;
  const TYPE_MAX          = 75;

  // ── Logging ──────────────────────────────────────────────────────────────────
  const LOGS = [];

  function log(step, msg) {
    const ts    = new Date().toLocaleTimeString('he-IL', { hour12: false });
    const entry = `[${ts}] [${step}] ${msg}`;
    LOGS.push(entry);
    console.log(`%c[AutoPoster]%c ${entry}`, 'color:#1877f2;font-weight:bold', 'color:inherit');
  }

  async function saveLogs(success, error = '') {
    return new Promise(r =>
      chrome.storage.local.set({
        lastRunLogs: { ts: new Date().toISOString(), url: location.href, success, error, logs: LOGS },
      }, r)
    );
  }

  function dumpDOM() {
    const lines = [];

    // Show ALL role=button elements (not just first 12)
    const btns = [...document.querySelectorAll('[role="button"]')];
    lines.push(`role=button (${btns.length} total):`);
    btns.forEach((el, i) => {
      const inArt = !!el.closest('[role="article"]');
      const inNav = !!(el.closest('[role="navigation"]') || el.closest('nav') || el.closest('header'));
      lines.push(
        `  [${i}]${inArt ? '[ART]' : ''}${inNav ? '[NAV]' : ''} ` +
        `aria="${el.getAttribute('aria-label') || '—'}" ` +
        `text="${(el.innerText || '').trim().slice(0, 50) || '—'}"`
      );
    });

    // tabindex="0" elements outside nav/article (the composer may lack role=button)
    const tabs = [...document.querySelectorAll('[tabindex="0"]')].filter(
      el => !el.closest('[role="article"]') &&
            !el.closest('[role="navigation"]') &&
            !el.closest('nav') &&
            el.getAttribute('role') !== 'button'  // already shown above
    );
    lines.push(`tabindex=0 (non-button, outside nav/article) — ${tabs.length}:`);
    tabs.slice(0, 20).forEach((el, i) =>
      lines.push(`  [${i}] ${el.tagName} role="${el.getAttribute('role') || '—'}" aria="${el.getAttribute('aria-label') || '—'}" text="${(el.innerText || '').trim().slice(0, 50)}"`)
    );

    const ces = [...document.querySelectorAll('[contenteditable]')];
    lines.push(`contenteditable (${ces.length}):`);
    ces.forEach((el, i) =>
      lines.push(`  [${i}]${el.closest('[role="article"]') ? '[ART]' : ''} role="${el.getAttribute('role') || '—'}" aria="${el.getAttribute('aria-label') || '—'}"`));

    lines.push(`dialogs: ${document.querySelectorAll('[role="dialog"]').length}, articles: ${document.querySelectorAll('[role="article"]').length}`);
    return lines.join('\n');
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────
  const sleep  = (ms) => new Promise(r => setTimeout(r, ms));

  function waitForEl(fn, timeout = 10_000) {
    return new Promise((resolve, reject) => {
      const el = fn();
      if (el) return resolve(el);
      const ob = new MutationObserver(() => {
        const found = fn();
        if (found) { ob.disconnect(); resolve(found); }
      });
      ob.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { ob.disconnect(); reject(new Error('waitForEl timeout')); }, timeout);
    });
  }

  // Full pointer+mouse sequence — reliable for React/Lexical
  function realClick(el) {
    el.focus();
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  POST MODE — find the "Write something…" NEW-POST composer at top of feed
  //  CRITICAL: must NOT be inside [role="article"] (that would be a comment box)
  // ────────────────────────────────────────────────────────────────────────────

  function notInArticle(el) {
    return !el.closest('[role="article"]') &&
           !el.closest('[aria-label*="תגובה"]') &&
           !el.closest('[aria-label*="comment"]');
  }

  function findPostTrigger() {
    // S1: exact aria-label OR exact text content — non-article only
    const exactLabels = [
      'כתוב משהו...',
      'מה עובר לך בראש?',
      'Write something...',
      "What's on your mind?",
      'כתוב פוסט',
      'כאן כותבים…',   // ← actual FB Hebrew groups placeholder
      'כאן כותבים...',
    ];
    for (const label of exactLabels) {
      // aria-label match
      for (const el of document.querySelectorAll(`[aria-label="${label}"]`)) {
        if (notInArticle(el)) { log('POST-TRIGGER', `S1a aria="${label}"`); return el; }
      }
      // text-content match (for unlabelled buttons like [aria="—"])
      for (const el of document.querySelectorAll('[role="button"], [tabindex="0"]')) {
        const t = (el.innerText || el.textContent).trim();
        if (t === label && notInArticle(el)) { log('POST-TRIGGER', `S1b text="${label}"`); return el; }
      }
    }

    // S2: data-testid
    const t = document.querySelector('[data-testid="status-attachment-mentions-input"]');
    if (t && notInArticle(t)) { log('POST-TRIGGER', 'S2 data-testid'); return t; }

    // S3: "צור פוסט" / "Create post" — new Facebook Groups UI
    //     includes partial match for "צור פוסט" inside a longer text
    const createTexts = ['צור פוסט', 'Create post', 'Create Post', 'יצירת פוסט', 'פוסט חדש'];
    for (const el of document.querySelectorAll('[role="button"], button, a, [tabindex="0"]')) {
      const t2 = (el.innerText || el.textContent).trim();
      if ((createTexts.includes(t2) || createTexts.some(c => t2 === c)) &&
          notInArticle(el) && !el.closest('nav') && !el.closest('[role="navigation"]')) {
        log('POST-TRIGGER', `S3 create-post text="${t2}" tag=${el.tagName}`);
        return el;
      }
    }
    // S3b: aria-label partial match for "צור פוסט"
    for (const el of document.querySelectorAll('[aria-label]')) {
      const a = el.getAttribute('aria-label') || '';
      if ((a.includes('צור פוסט') || a.includes('Create post') || a.includes('create post')) &&
          notInArticle(el)) {
        log('POST-TRIGGER', `S3b aria partial "${a}"`);
        return el;
      }
    }

    // S4: span/div text = placeholder, walk up to [role=button], not in article
    const needles = ['כתוב משהו', 'מה עובר לך', 'Write something'];
    for (const el of document.querySelectorAll('span, div[dir="auto"]')) {
      const txt = (el.innerText || el.textContent).trim();
      if (needles.some(n => txt.startsWith(n)) && txt.length < 60) {
        const btn = el.closest('[role="button"]') || el.closest('[tabindex="0"]');
        if (btn && notInArticle(btn) && !btn.closest('nav') && !btn.closest('[role="navigation"]')) {
          log('POST-TRIGGER', `S4 span text="${txt.slice(0, 30)}" btn=${btn.tagName}`);
          return btn;
        }
      }
    }

    // S5: inline Lexical editor already open, not in article
    const lexical = document.querySelector('[data-lexical-editor="true"]');
    if (lexical && notInArticle(lexical)) { log('POST-TRIGGER', 'S5 lexical editor'); return lexical; }

    // S6: any contenteditable[role=textbox] not in article
    for (const el of document.querySelectorAll('[contenteditable="true"][role="textbox"]')) {
      if (notInArticle(el)) { log('POST-TRIGGER', `S6 contenteditable tag=${el.tagName}`); return el; }
    }

    // S7: The LAST [role="button"] or [tabindex="0"] that appears before the first
    //     article in DOM order, outside nav/header — the post composer is always
    //     the LAST interactive element before the feed starts.
    const firstArticle = document.querySelector('[role="article"]');
    if (firstArticle) {
      const SKIP_ARIA = [
        'חזרה', 'יציאה', 'תפריט', 'Messenger', 'התראות', 'הפרופיל',
        'menu', 'back', 'close',
        'עריכת',       // cover-photo edit button
        'Edit',
        'תמונת הנושא',
        'report', 'דווח',
        'אנונימי',     // ← "פוסט אנונימי" — must never click this
        'anonymous',
        'הזמיני',      // Invite button
        'שיתוף',       // Share group button
        'הרגשה',       // Feeling/activity
        'סקר',         // Poll
        'אירוע',       // Event (but NOT the text trigger)
        'יצירת אירוע',
        'מידע נוסף',
        'הוספת פריטים',
      ];
      const candidates = [];
      for (const el of document.querySelectorAll('[role="button"], [tabindex="0"]')) {
        if (el.closest('[role="navigation"]') || el.closest('nav') ||
            el.closest('header') || el.closest('[role="banner"]') ||
            el.closest('[role="complementary"]') || el.closest('[role="article"]')) continue;

        const aria = el.getAttribute('aria-label') || '';
        if (SKIP_ARIA.some(n => aria.includes(n))) continue;

        // Must precede firstArticle in DOM order
        if (!(el.compareDocumentPosition(firstArticle) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;

        const txt = (el.innerText || el.textContent).trim();
        if (txt.length < 1) continue;

        candidates.push(el);
      }

      if (candidates.length > 0) {
        // Log all candidates so we can identify the right one
        log('POST-TRIGGER', `S7 found ${candidates.length} pre-article candidates:`);
        candidates.forEach((c, i) =>
          log('POST-TRIGGER', `  [${i}] aria="${c.getAttribute('aria-label') || '—'}" text="${(c.innerText || '').trim().slice(0, 50)}"`)
        );

        // The post composer button is typically the LAST one (closest to feed)
        // OR first one whose text/aria looks like a text-input placeholder.
        // IMPORTANT: use whole-word / phrase matching — avoid "פוסט" alone
        // because it also matches "פוסט אנונימי".
        const composerPhrases = [
          'כאן כותבים', 'כתוב משהו', 'מה עובר לך',
          'Write something', "What's on your mind",
        ];
        const byHint = candidates.find(c => {
          const t = (c.innerText || c.textContent).trim();
          const a = c.getAttribute('aria-label') || '';
          return composerPhrases.some(h => t.includes(h) || a.includes(h));
        });

        const chosen = byHint || candidates[candidates.length - 1];
        log('POST-TRIGGER', `S7 chosen: aria="${chosen.getAttribute('aria-label') || '—'}" text="${(chosen.innerText || '').trim().slice(0, 50)}"`);
        return chosen;
      }
    }

    log('POST-TRIGGER', 'NOT FOUND');
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  COMMENT MODE — find the first comment input in the feed
  // ────────────────────────────────────────────────────────────────────────────

  function findCommentTrigger() {
    // S1: exact aria-label for comment box
    const commentLabels = [
      'כתוב תגובה...',
      'הוסף תגובה...',
      'Write a comment...',
      'Add a comment...',
      'כתוב תגובה',
    ];
    for (const label of commentLabels) {
      const el = document.querySelector(`[aria-label="${label}"]`);
      if (el) { log('CMT-TRIGGER', `S1 aria="${label}"`); return el; }
    }

    // S2: placeholder match inside article
    for (const el of document.querySelectorAll('[placeholder]')) {
      const p = el.getAttribute('placeholder') || '';
      if (p.includes('תגובה') || p.includes('comment')) {
        log('CMT-TRIGGER', `S2 placeholder="${p}"`);
        return el;
      }
    }

    // S3: first contenteditable inside an article that is not the post itself
    for (const el of document.querySelectorAll('[role="article"] [contenteditable="true"]')) {
      const aria = el.getAttribute('aria-label') || '';
      if (aria.includes('תגובה') || aria.includes('comment') || aria.includes('Reply')) {
        log('CMT-TRIGGER', `S3 aria="${aria}"`);
        return el;
      }
    }

    // S4: any contenteditable inside an article
    const fallback = document.querySelector('[role="article"] [contenteditable="true"]');
    if (fallback) { log('CMT-TRIGGER', 'S4 first article contenteditable'); return fallback; }

    log('CMT-TRIGGER', 'NOT FOUND');
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Shared: find the active rich-text editor after opening the composer
  // ────────────────────────────────────────────────────────────────────────────

  function findEditor(mode) {
    if (mode === 'post') {
      // Prefer editor inside an open dialog (post compose dialog)
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        const e =
          dialog.querySelector('[contenteditable="true"][role="textbox"]') ||
          dialog.querySelector('[data-lexical-editor="true"]') ||
          dialog.querySelector('[contenteditable="true"]');
        if (e) { log('EDITOR', `in dialog aria="${e.getAttribute('aria-label') || '—'}"`); return e; }
      }
      // Inline (no dialog opened)
      for (const el of document.querySelectorAll('[contenteditable="true"][role="textbox"]')) {
        if (notInArticle(el)) { log('EDITOR', `inline post editor`); return el; }
      }
      const lex = document.querySelector('[data-lexical-editor="true"]');
      if (lex && notInArticle(lex)) { log('EDITOR', 'inline lexical'); return lex; }
    } else {
      // Comment: editor inside article or dialog
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        const e = dialog.querySelector('[contenteditable="true"]');
        if (e) { log('EDITOR', 'comment in dialog'); return e; }
      }
      // Look for comment input that already has focus or is expanded
      for (const el of document.querySelectorAll('[contenteditable="true"]')) {
        const aria = el.getAttribute('aria-label') || '';
        if (aria.includes('תגובה') || aria.includes('comment') || aria.includes('Reply')) {
          log('EDITOR', `comment editor aria="${aria}"`);
          return el;
        }
      }
      // Fallback: first contenteditable in article
      const e = document.querySelector('[role="article"] [contenteditable="true"]');
      if (e) { log('EDITOR', 'first article editor (fallback)'); return e; }
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Post submit button
  // ────────────────────────────────────────────────────────────────────────────

  function findPostButton(mode) {
    const root = document.querySelector('[role="dialog"]') || document;

    // For new posts: פרסם / Post
    // For comments:  פרסם תגובה / פרסם / Enter key (handled separately)
    const LABELS = mode === 'post'
      ? ['פרסם', 'פרסום', 'Post', 'שתף', 'Share', 'פרסמי']
      : ['פרסם תגובה', 'פרסם', 'Post comment', 'Post', 'Reply'];

    for (const label of LABELS) {
      const el = root.querySelector(`[aria-label="${label}"]`);
      if (el) { log('BTN', `aria="${label}"`); return el; }
    }
    for (const el of root.querySelectorAll('[role="button"], button')) {
      const t = (el.innerText || el.textContent).trim();
      if (LABELS.includes(t)) { log('BTN', `text="${t}"`); return el; }
    }
    // Partial match
    for (const el of root.querySelectorAll('[role="button"], button')) {
      const t = (el.innerText || el.textContent).trim();
      if (/^פרסמ/.test(t) || t.startsWith('Post') || t.startsWith('Reply')) {
        log('BTN', `partial="${t}"`);
        return el;
      }
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Content formatting
  //  Rules requested by user:
  //   • After the title (first line) — always insert a blank line
  //   • Every Enter press → blank line (paragraph spacing, not tight line-break)
  //   • Collapse 3+ consecutive newlines to 2
  // ────────────────────────────────────────────────────────────────────────────

  function formatContent(raw) {
    return raw
      .replace(/\r\n/g, '\n')  // Windows CRLF → LF
      .replace(/\r/g, '\n')    // bare CR → LF
      .trimEnd();               // remove trailing whitespace only; preserve internal newlines exactly
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Anonymous-post guard
  //  Facebook groups sometimes pre-select "Anonymous member" as the posting
  //  identity. This function checks the open dialog and switches to the user's
  //  real profile if anonymous mode is detected.
  // ────────────────────────────────────────────────────────────────────────────

  async function checkNotAnonymous() {
    await sleep(600);
    const dialog = document.querySelector('[role="dialog"]') || document.body;
    const fullText = (dialog.innerText || dialog.textContent) || '';

    const hasAnon = fullText.includes('אנונימי') || fullText.toLowerCase().includes('anonymous');
    if (!hasAnon) { log('ANON', 'No anonymous option visible ✓'); return; }

    log('ANON', 'WARNING: "anonymous" text found in dialog — checking posting identity...');

    // Find the "Post as" / identity selector button
    const identityBtn = [...dialog.querySelectorAll('[role="button"]')].find(btn => {
      const a = btn.getAttribute('aria-label') || '';
      const t = (btn.innerText || btn.textContent).trim();
      return a.includes('זהות') || a.includes('פרסם בתור') || a.includes('Post as') ||
             t.includes('אנונימי') || t.toLowerCase().includes('anonymous');
    });

    if (!identityBtn) {
      log('ANON', 'Could not find identity selector button. Proceed with caution.');
      return;
    }

    const currentId = (identityBtn.innerText || identityBtn.textContent).trim();
    if (!currentId.includes('אנונימי') && !currentId.toLowerCase().includes('anonymous')) {
      log('ANON', `Posting as: "${currentId.slice(0, 40)}" — not anonymous ✓`);
      return;
    }

    log('ANON', `Currently set to anonymous ("${currentId}") — opening selector...`);
    realClick(identityBtn);
    await sleep(1000);

    // Look for the non-anonymous (profile) option in the opened menu
    const menuItems = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="radio"], [role="listitem"]')];
    const profileOpt = menuItems.find(item => {
      const t = (item.innerText || item.textContent).trim();
      return t.length > 0 && !t.includes('אנונימי') && !t.toLowerCase().includes('anonymous');
    });

    if (profileOpt) {
      log('ANON', `Selecting profile: "${(profileOpt.innerText || '').trim().slice(0, 40)}"`);
      realClick(profileOpt);
      await sleep(600);
    } else {
      // Close the menu without changing
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      log('ANON', 'Profile option not found in menu — closed without change');
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Typing helpers
  // ────────────────────────────────────────────────────────────────────────────

  async function humanType(el, text) {
    el.focus();
    await sleep(500);
    if (document.activeElement !== el) { realClick(el); await sleep(400); }

    for (const char of text) {
      if (char === '\n') {
        // Use insertParagraph so Lexical/React creates a real paragraph break
        document.execCommand('insertParagraph', false);
        await sleep(90);
      } else {
        document.execCommand('insertText', false, char);
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
        await sleep(TYPE_MIN + Math.random() * (TYPE_MAX - TYPE_MIN));
      }
    }
    await sleep(500);
    log('TYPE', `Done. Preview: "${(el.innerText || el.textContent).slice(0, 60)}"`);
  }

  async function insertUrl(el, url) {
    el.focus();
    await sleep(400);
    document.execCommand('insertText', false, url);
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: url, bubbles: true }));
    log('URL', 'insertText');
    await sleep(600);
  }

  function waitForLinkPreview(timeout = LINK_PREVIEW_WAIT) {
    const SELS = [
      '[data-testid="external_link_attachment_container"]',
      '[data-testid="linkshim_attachment"]',
      '[aria-label*="תצוגה מקדימה"]',
      '[aria-label*="link preview"]',
    ];
    return new Promise(resolve => {
      const ob = new MutationObserver(() => {
        if (SELS.some(s => document.querySelector(s))) { ob.disconnect(); resolve(true); }
      });
      ob.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { ob.disconnect(); resolve(false); }, timeout);
    });
  }

  function report(success, error = '') {
    try { chrome.runtime.sendMessage({ type: 'POST_RESULT', success, error }); } catch (_) {}
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  MAIN
  // ────────────────────────────────────────────────────────────────────────────

  async function run() {
    log('START', `${location.href}`);

    const task = await new Promise(r =>
      chrome.storage.local.get(['currentTask'], d => r(d.currentTask || null))
    );
    if (!task) throw new Error('currentTask missing from storage');

    const { title = '', content, url, mode = 'post' } = task;
    log('TASK', `mode=${mode} title="${title.slice(0, 30)}" content="${content.slice(0, 40)}" url="${url}"`);

    // Login check
    if (document.querySelector('[data-testid="royal_login_form"]') ||
        document.querySelector('#loginform') ||
        /log.?in|התחברות/i.test(document.title)) {
      throw new Error('Login wall detected');
    }
    log('AUTH', 'no login wall ✓');

    // Scroll to top — ensures the post composer is in the viewport and rendered
    window.scrollTo({ top: 0, behavior: 'instant' });
    await sleep(800);

    // ── 1. Find trigger ─────────────────────────────────────────────────────
    const findTriggerFn = mode === 'post' ? findPostTrigger : findCommentTrigger;
    log('TRIGGER', `Searching for ${mode} trigger...`);

    let trigger = findTriggerFn();
    if (!trigger) {
      log('TRIGGER', 'Not found immediately, waiting up to 9s...');
      try { trigger = await waitForEl(findTriggerFn, 9000); }
      catch (_) {
        log('TRIGGER', `Give up. DOM:\n${dumpDOM()}`);
        throw new Error(`${mode === 'post' ? 'Post composer' : 'Comment box'} not found on page`);
      }
    }

    log('TRIGGER', `Found: tag=${trigger.tagName} aria="${trigger.getAttribute('aria-label') || '—'}" inArticle=${!!trigger.closest('[role="article"]')}`);

    // ── 2. Click to activate (unless already an editor) ─────────────────────
    const isEditor = trigger.contentEditable === 'true' || trigger.dataset.lexicalEditor === 'true';

    if (isEditor) {
      log('CLICK', 'Trigger is already an editor — skipping click');
    } else {
      trigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(800);
      log('CLICK', 'Firing click...');
      realClick(trigger);
      await sleep(2200);

      const opened = document.querySelector('[role="dialog"]') ||
                     (mode === 'post'
                       ? document.querySelector('[contenteditable="true"][role="textbox"]:not([role="article"] *)')
                       : document.querySelector('[role="article"] [contenteditable="true"]'));
      if (!opened) {
        log('CLICK', `No editor appeared after click. DOM:\n${dumpDOM()}`);
        throw new Error('Click did not open an editor');
      }
      log('CLICK', `Editor/dialog appeared: ${opened.getAttribute('role') || opened.tagName}`);
    }

    // ── 3. Find editor ───────────────────────────────────────────────────────
    log('EDITOR', 'Waiting for editor...');
    let editor;
    try { editor = await waitForEl(() => findEditor(mode), EDITOR_WAIT); }
    catch (_) {
      log('EDITOR', `Not found. DOM:\n${dumpDOM()}`);
      throw new Error('Text editor not found after clicking trigger');
    }

    // ── 3b. Anonymous guard (post mode) ──────────────────────────────────────
    if (mode === 'post') await checkNotAnonymous();

    // ── 4. Type title (if provided) then body ────────────────────────────────
    if (title && title.trim()) {
      log('TYPE', `Typing title: "${title.slice(0, 40)}"`);
      await humanType(editor, title.trim());
      // Re-focus and wait before inserting paragraph breaks
      editor.focus();
      await sleep(500);
      document.execCommand('insertParagraph', false);
      await sleep(300);
      document.execCommand('insertParagraph', false);
      await sleep(500);
    }

    const formattedContent = formatContent(content);
    log('TYPE', `Typing body ${formattedContent.length} chars (raw: ${content.length})...`);
    await humanType(editor, formattedContent);

    const typed = (editor.innerText || editor.textContent).trim();
    if (!typed) log('TYPE', 'WARNING: editor appears empty after typing!');

    // ── 5. URL with blank lines around it (post mode only) ───────────────────
    //   Result in post:
    //     [content paragraphs]
    //
    //     [URL]
    //
    //     [link preview card]
    if (url && mode === 'post') {
      log('URL', 'Inserting URL with 2 blank lines above...');

      // Re-focus before inserting paragraph breaks
      editor.focus();
      await sleep(500);

      // 2 blank lines BEFORE url (three insertParagraph = two blank lines)
      document.execCommand('insertParagraph', false);
      await sleep(300);
      document.execCommand('insertParagraph', false);
      await sleep(300);
      document.execCommand('insertParagraph', false);
      await sleep(500);

      await insertUrl(editor, url);

      // Wait up to 18s for preview card, then settle
      log('PREVIEW', 'Waiting up to 18s for link preview card...');
      const got = await waitForLinkPreview(18_000);
      log('PREVIEW', got ? 'Preview loaded ✓' : 'No preview detected — proceeding');
      await sleep(got ? 5000 : 4000);
    }

    // ── 6. Submit ────────────────────────────────────────────────────────────
    if (mode === 'comment') {
      // Comments can be submitted with Enter (simpler & more reliable)
      log('SUBMIT', 'Pressing Enter to submit comment...');
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
      await sleep(1000);

      // If Enter didn't work, fall back to button
      const stillOpen = document.querySelector('[role="dialog"]') ||
                        document.activeElement === editor;
      if (stillOpen) {
        log('SUBMIT', 'Enter did not close — trying submit button...');
        const btn = findPostButton(mode);
        if (btn) { realClick(btn); await sleep(1000); }
      }
    } else {
      // Post mode — must find and click the submit button
      log('BTN', 'Searching for Post button...');
      let postBtn = null;
      const btnEnd = Date.now() + 12_000;
      while (Date.now() < btnEnd) {
        postBtn = findPostButton(mode);
        if (postBtn) break;
        await sleep(700);
      }
      if (!postBtn) {
        log('BTN', `Not found after 12s. DOM:\n${dumpDOM()}`);
        throw new Error('Post button not found');
      }

      const disabled = () =>
        postBtn.getAttribute('aria-disabled') === 'true' ||
        postBtn.hasAttribute('disabled') ||
        postBtn.getAttribute('tabindex') === '-1';

      if (disabled()) {
        log('BTN', 'Button disabled, waiting up to 7s...');
        const end = Date.now() + 7000;
        while (Date.now() < end && disabled()) await sleep(500);
      }
      if (disabled()) throw new Error('Post button stayed disabled — content may not have registered');

      postBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(400);
      log('SUBMIT', 'Clicking Post button...');
      realClick(postBtn);
      await sleep(3000);
    }

    log('DONE', `✅ ${mode === 'post' ? 'Post' : 'Comment'} submitted`);
  }

  // ── Execute ───────────────────────────────────────────────────────────────────
  try {
    await Promise.race([
      run(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Watchdog ${TASK_TIMEOUT / 1000}s`)), TASK_TIMEOUT)),
    ]);
    await saveLogs(true);
    report(true);
  } catch (e) {
    log('FAIL', e.message);
    await saveLogs(false, e.message);
    report(false, e.message);
  }
})();
