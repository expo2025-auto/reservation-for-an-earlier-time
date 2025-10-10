// ==UserScript==
// @name         Expo2025 予約繰り上げ
// @namespace    https://github.com/expo-automation/reservation-for-an-earlier-time
// @version      1.1.２
// @description  現在の予約時刻より早い空き枠を自動選択し、確認モーダルまで進めて変更を完了します。失敗トースト検出時は同分内4回までリトライ。
// @downloadURL  https://github.com/expo2025-auto/reservation-for-an-earlier-time/raw/refs/heads/main/earlier-time.user.js
// @updateURL    https://github.com/expo2025-auto/reservation-for-an-earlier-time/raw/refs/heads/main/earlier-time.user.js
// @author       you
// @match        https://ticket.expo2025.or.jp/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      ticket.expo2025.or.jp
// ==/UserScript==

(function () {
  'use strict';

  /***** 調整ポイント（サイト改修時はここを直す） *****/
  const SELECTORS = {
    timeButton: 'td button, td [role="button"], [data-time-slot] button, [data-time-slot] [role="button"], div[role="button"][class*="style_main__button__"], button[class*="style_main__button__"], div[role="button"][aria-pressed]',
    activeButton: [
      '[aria-pressed="true"]',
      '[aria-selected="true"]',
      '[aria-current]:not([aria-current="false"])',
      '[aria-checked="true"]',
      '[data-current="true"]',
      '[data-active="true"]',
      '[data-selected="true"]',
      '[data-is-current="true"]',
      '[data-is-active="true"]',
      '[data-is-selected="true"]',
    ].join(', '),
    timePattern: /([01]?\d|2[0-3]):[0-5]\d/,
    setVisitButtonText: /来場日時を設定する/,
    confirmButtonText: /来場日時を変更する/,
    confirmToastButton: [
      'button.style_next_button__N_pbs',
      '.style_next_button__N_pbs[role="button"]',
    ],
    successToast: /来場日時が設定されました/,
    failureToast: /定員を超えたため、ご希望の時間帯は選択できませんでした/,
  };

  // 予約操作のタイムアウト/待機
  const ACTION_TIMEOUT_MS = 10_000;
  const RECENT_CHECK_THRESHOLD_MS = 10_000;
  const DOM_POLL_INTERVAL_MS = 150;

  // リロード許可ウィンドウ（サーバー時刻）

  const WINDOW_START = 14; // >= 14s
  const WINDOW_END = 28; // < 28s


  // 予約失敗時の復旧リロード 最大回数（秒に関係なく実施）
  const MAX_ATTEMPTS_PER_MINUTE = 3;
  const MAX_RELOADS_PER_MINUTE = 4;
  const ATTEMPT_STORAGE_KEY = 'expo_adv_attempt_info_v3';
  const RELOAD_STORAGE_KEY = 'expo_adv_reload_info_v1';

  // トグル保存キー
  const ENABLE_KEY = 'expo_adv_enable_v2';
  let enabledFallback = false;

  const STATUS_LABELS = {
    idle: '待機中',
    running: '実行中',
    done: '完了',
  };
  let currentStatus = 'idle';
  let statusIndicator;
  let currentSlotIndicator;
  let currentSlotDisplay = { label: '', estimated: false, text: '未取得' };
  let nextUpdateIndicator;
  let nextUpdateTimerId = null;
  let reloadsThisMinute = 0;

  function setStatus(state) {
    currentStatus = state;
    if (statusIndicator) {
      const label = STATUS_LABELS[state] || state;
      statusIndicator.textContent = label;
      statusIndicator.dataset.status = state;
    }
    updateNextUpdateDisplay();
  }

  function setCurrentSlotDisplay(label, options = {}) {
    const normalized = label ? String(label).trim() : '';
    const estimated = !!options.estimated;
    const fallback = options.fallback || '未取得';
    let text;
    if (normalized) {
      text = estimated ? `${normalized}（推定）` : normalized;
    } else {
      text = fallback;
    }
    currentSlotDisplay = { label: normalized, estimated, text };
    if (currentSlotIndicator) {
      currentSlotIndicator.textContent = text;
      if (estimated) {
        currentSlotIndicator.dataset.estimated = '1';
      } else {
        delete currentSlotIndicator.dataset.estimated;
      }
    }
  }

  function formatRemaining(ms) {
    const clamped = Math.max(0, ms);
    if (clamped >= 10_000) {
      const seconds = Math.floor(clamped / 1000);
      return `${seconds}秒`;
    }
    return `${(clamped / 1000).toFixed(1)}秒`;
  }

  function getSyncedNowMs() {
    if (hasServerTime) {
      return Date.now() + serverTimeOffsetMs;
    }
    return Date.now();
  }

  function getNextUpdateRemainingMs() {
    const nowMs = getSyncedNowMs();
    const msIntoMinute = ((nowMs % 60_000) + 60_000) % 60_000;
    const windowStartMs = WINDOW_START * 1000;
    const windowEndMs = WINDOW_END * 1000;
    if (reloadsThisMinute >= MAX_RELOADS_PER_MINUTE) {
      if (msIntoMinute < windowStartMs) {
        return windowStartMs - msIntoMinute;
      }
      return 60_000 - msIntoMinute + windowStartMs;
    }
    if (msIntoMinute >= windowStartMs && msIntoMinute < windowEndMs) {
      return 0;
    }
    if (msIntoMinute < windowStartMs) {
      return windowStartMs - msIntoMinute;
    }
    return 60_000 - msIntoMinute + windowStartMs;
  }

  function updateNextUpdateDisplay() {
    if (!nextUpdateIndicator) return;
    let text = '---';
    if (!isEnabled()) {
      text = '停止中';
    } else if (currentStatus === 'done') {
      text = '完了';
    } else if (currentStatus === 'running') {
      text = '実行中';
    } else if (attemptBlockedUntil > Date.now()) {
      text = formatRemaining(attemptBlockedUntil - Date.now());
    } else {
      const remainingMs = Math.max(0, getNextUpdateRemainingMs());
      text = formatRemaining(remainingMs);
    }
    nextUpdateIndicator.textContent = text;
  }

  const SLOT_SCOPE_SELECTORS = [
    '[role="tabpanel"]',
    '[data-date]',
    '[data-day]',
    '[data-tab-id]',
    '[data-date-value]',
    'tbody',
    'table',
  ];
  const SLOT_SCOPE_ATTRIBUTE_KEYS = ['data-date-value', 'data-date', 'data-day', 'data-tab-id'];

  let lastLoggedCurrentSlotSignature = null;
  let lastLoggedUsedStoredForCurrent = false;
  let lastKnownCurrentSlot = null;
  let lastActiveDetectionFailureLogTime = 0;
  let lastSuccessfulCheckTime = 0;
  let lastReloadDeferLogBucket = null;
  let checkCompletedThisLoad = false;

  const ACTIVE_TEXT_PATTERNS = [
    /現在.*予約/,
    /予約.*中/,
    /予約.*済/,
    /ご予約中/,
    /ご予約済/,
    /選択.*中/,
    /選択.*済/,
    /reserved/i,
    /currentreservation/i,
    /yourreservation/i,
    /booked/i,
  ];

  const ACTIVE_KEYWORD_REGEXPS = [
    /(?:^|[^a-z0-9])current(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])selected(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])active(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])checked(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])chosen(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])reserved(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])booked(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])mine(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])own(?:[^a-z0-9]|$)/i,
  ];

  function textMatchesActive(text) {
    if (!text) return false;
    const normalized = String(text).replace(/\s+/g, '');
    if (!normalized) return false;
    return ACTIVE_TEXT_PATTERNS.some((re) => re.test(normalized));
  }

  function containsActiveKeyword(str) {
    if (!str) return false;
    const lower = String(str).toLowerCase();
    if (lower.includes('inactive')) return false;
    return ACTIVE_KEYWORD_REGEXPS.some((re) => re.test(lower));
  }

  function collectActiveHintsFromSelf(el) {
    const hints = [];
    if (!el) return hints;
    try {
      if (SELECTORS.activeButton && el.matches(SELECTORS.activeButton)) {
        hints.push('selector-match');
      }
    } catch (e) {
      // invalid selector situations are ignored
    }
    const ariaAttrs = ['aria-pressed', 'aria-selected', 'aria-current', 'aria-checked'];
    for (const name of ariaAttrs) {
      const value = el.getAttribute(name);
      if (value && value !== 'false') {
        hints.push(`${name}=${value}`);
      }
    }
    const dataset = el.dataset || {};
    for (const [key, value] of Object.entries(dataset)) {
      const valStr = value == null ? '' : String(value);
      if (containsActiveKeyword(key) || containsActiveKeyword(valStr) || (valStr === '1' && containsActiveKeyword(key))) {
        hints.push(`data-${key}=${valStr}`);
      } else if (textMatchesActive(valStr)) {
        hints.push(`data-${key}~text`);
      }
    }
    const attributes = Array.from(el.attributes || []);
    for (const attr of attributes) {
      const name = attr.name;
      if (!name || name.startsWith('data-') || name.startsWith('aria-') || name === 'class') continue;
      const value = attr.value;
      if (containsActiveKeyword(name) || containsActiveKeyword(value)) {
        hints.push(`${name}=${value}`);
      } else if (textMatchesActive(value)) {
        hints.push(`${name}~text`);
      }
    }
    const classes = el.classList ? Array.from(el.classList) : (typeof el.className === 'string' ? el.className.split(/\s+/) : []);
    for (const cls of classes) {
      if (!cls) continue;
      if (containsActiveKeyword(cls)) {
        hints.push(`class:${cls}`);
      } else if (textMatchesActive(cls)) {
        hints.push(`class~text:${cls}`);
      }
    }
    const labelText = [el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim();
    if (labelText && textMatchesActive(labelText)) {
      hints.push(`label:${labelText}`);
    }
    const elementText = (el.innerText || el.textContent || '').trim();
    if (elementText && textMatchesActive(elementText)) {
      hints.push(`text:${elementText}`);
    }
    const altNodes = el.querySelectorAll ? el.querySelectorAll('[alt]') : [];
    for (const node of altNodes) {
      const alt = node.getAttribute('alt') || '';
      if (alt && textMatchesActive(alt)) {
        hints.push(`alt:${alt}`);
        break;
      }
    }
    return hints;
  }

  function collectActiveHints(el) {
    const hints = collectActiveHintsFromSelf(el);
    let depth = 0;
    let parent = el ? el.parentElement : null;
    while (parent && depth < 4) {
      const parentHints = collectActiveHintsFromSelf(parent);
      if (parentHints.length) {
        for (const hint of parentHints) {
          hints.push(`ancestor${depth + 1}:${hint}`);
        }
        break;
      }
      const parentText = (parent.innerText || parent.textContent || '').trim();
      if (parentText && textMatchesActive(parentText)) {
        hints.push(`ancestor${depth + 1}-text:${parentText}`);
        break;
      }
      parent = parent.parentElement;
      depth += 1;
    }
    return hints;
  }

  function scoreActiveHints(hints) {
    if (!hints || !hints.length) return 0;
    let score = 0;
    for (const rawHint of hints) {
      let hint = rawHint;
      if (rawHint.startsWith('ancestor')) {
        score += 15;
        const idx = rawHint.indexOf(':');
        hint = idx >= 0 ? rawHint.slice(idx + 1) : rawHint;
      }
      if (hint === 'selector-match') {
        score += 100;
      } else if (/aria-pressed/.test(hint)) {
        score += 90;
      } else if (/aria-selected/.test(hint)) {
        score += 85;
      } else if (/aria-current/.test(hint)) {
        score += 80;
      } else if (/aria-checked/.test(hint)) {
        score += 75;
      } else if (/data-/.test(hint)) {
        score += 60;
      } else if (/class/.test(hint)) {
        score += 45;
      } else if (/label/.test(hint) || /text/.test(hint) || /alt/.test(hint)) {
        score += 40;
      } else {
        score += 10;
      }
    }
    return score;
  }

  function normalizeLabel(str) {
    return (str || '').replace(/\s+/g, '').trim();
  }

  function findEntryByStoredSignature(entries, stored) {
    if (!stored) return null;
    const scored = [];
    for (const entry of entries) {
      const info = entry.info;
      let score = 0;
      if (stored.scopeSignature && stored.scopeSignature === (entry.scopeSignature || '')) {
        score += 8;
      }
      if (stored.minutes != null && info && info.minutes === stored.minutes) {
        score += 4;
      }
      if (stored.label && info && normalizeLabel(info.label) === normalizeLabel(stored.label)) {
        score += 2;
      }
      if (stored.text && normalizeLabel(entry.text) === normalizeLabel(stored.text)) {
        score += 1;
      }
      if (!score) continue;
      scored.push({ entry, score });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0];
    const runnerUp = scored[1];
    const threshold = stored.scopeSignature ? 8 : (stored.minutes != null ? 4 : 2);
    if (top.score < threshold) return null;
    if (runnerUp && runnerUp.score === top.score) return null;
    return top.entry;
  }

  /***** 便利ユーティリティ *****/
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function collectSlotButtons(root = document) {
    const nodes = $$(SELECTORS.timeButton, root);
    if (!nodes.length) return [];
    const seen = new Set();
    const buttons = [];
    for (const node of nodes) {
      const btn = node.closest('button, [role="button"]');
      if (!btn || seen.has(btn)) continue;
      seen.add(btn);
      buttons.push(btn);
    }
    return buttons;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(...args) {
    console.log('[ExpoAdvance]', ...args);
  }

  // :matches() 疑似を簡易サポート（innerTextでフィルタ）
  function isElementVisible(el) {
    if (!el) return false;
    if (el.hasAttribute('hidden')) return false;
    const style = window.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return !!(rect.width && rect.height);
  }

  function isElementEnabled(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.hasAttribute('disabled')) return false;
    if (el.dataset && el.dataset.disabled === 'true') return false;
    return true;
  }

  function triggerButtonClick(button) {
    if (!button) return;
    try {
      if (typeof button.focus === 'function') {
        button.focus({ preventScroll: true });
      }
    } catch {
      // ignore focus issues
    }
    if (typeof button.click === 'function') {
      button.click();
    }
    const events = [
      { type: 'pointerdown', init: { bubbles: true, cancelable: true, pointerType: 'mouse' }, pointer: true },
      { type: 'mousedown', init: { bubbles: true, cancelable: true } },
      { type: 'pointerup', init: { bubbles: true, cancelable: true, pointerType: 'mouse' }, pointer: true },
      { type: 'mouseup', init: { bubbles: true, cancelable: true } },
      { type: 'click', init: { bubbles: true, cancelable: true } },
    ];
    for (const evt of events) {
      if (evt.pointer) {
        if (typeof PointerEvent === 'function') {
          button.dispatchEvent(new PointerEvent(evt.type, evt.init));
        }
        continue;
      }
      button.dispatchEvent(new MouseEvent(evt.type, evt.init));
    }
  }

  function findButtonByText(patterns, options = {}) {
    const { requireVisible = false, requireEnabled = false } = options;
    const pats = Array.isArray(patterns) ? patterns : [patterns];
    const buttons = $$('button, [role="button"]');
    for (const b of buttons) {
      if (requireVisible && !isElementVisible(b)) continue;
      if (requireEnabled && !isElementEnabled(b)) continue;
      const t = (b.innerText || b.textContent || '').trim();
      if (pats.some(p => (p instanceof RegExp ? p.test(t) : t.includes(p)))) return b;
    }
    return null;
  }

  function loadAttemptInfo() {
    try {
      return JSON.parse(sessionStorage.getItem(ATTEMPT_STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function saveAttemptInfo(info) {
    try {
      sessionStorage.setItem(ATTEMPT_STORAGE_KEY, JSON.stringify(info));
    } catch {
      // storage full or unavailable
    }
  }

  function loadReloadInfo() {
    try {
      return JSON.parse(sessionStorage.getItem(RELOAD_STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function saveReloadInfo(info) {
    try {
      sessionStorage.setItem(RELOAD_STORAGE_KEY, JSON.stringify(info));
    } catch {
      // storage full or unavailable
    }
  }

  function resetReloadInfo(bucket) {
    const info = { bucket, count: 0, loggedMinute: null };
    saveReloadInfo(info);
    return info;
  }

  async function registerAttempt() {
    const now = await getServerDate();
    const nowMs = now.getTime();
    const bucket = Math.floor(nowMs / 60_000);
    const info = loadAttemptInfo();
    if (info.minute !== bucket) {
      info.minute = bucket;
      info.count = 0;
      info.logged = false;
    }
    const count = info.count || 0;
    if (count >= MAX_ATTEMPTS_PER_MINUTE) {
      const nextMinuteMs = (bucket + 1) * 60_000;
      const waitMs = Math.max(0, nextMinuteMs - nowMs);
      attemptBlockedUntil = Date.now() + waitMs;
      updateNextUpdateDisplay();
      if (!info.logged) {
        log(`この分の予約変更試行上限(${MAX_ATTEMPTS_PER_MINUTE}回)に到達。${Math.ceil(waitMs / 1000)}秒待機します。`);
        info.logged = true;
      }
      saveAttemptInfo(info);
      return { allowed: false, now, waitMs };
    }
    info.count = count + 1;
    info.logged = false;
    saveAttemptInfo(info);
    attemptBlockedUntil = 0;
    updateNextUpdateDisplay();
    log(`予約変更試行 ${info.count}/${MAX_ATTEMPTS_PER_MINUTE}（この分）`);
    return { allowed: true, now };
  }

  function resetAttemptInfo(message = '') {
    try {
      sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
    } catch {
      // storage unavailable
    }
    attemptBlockedUntil = 0;
    updateNextUpdateDisplay();
    if (message) {
      log(message);
    }
  }

  /***** サーバー時刻取得（Dateヘッダ） *****/
  let serverTimeOffsetMs = 0;
  let hasServerTime = false;
  let serverTimeInitFailed = false;
  let serverTimeInitPromise = null;

  async function fetchServerDate() {
    // 同一オリジン HEAD をまず試す
    try {
      const res = await fetch(location.origin + '/', { method: 'HEAD', cache: 'no-store' });
      const d = res.headers.get('Date');
      if (d) return new Date(d);
    } catch (e) {
      // 続行して GM_xmlhttpRequest にフォールバック
    }
    // フォールバック：GM_xmlhttpRequest
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        return reject(new Error('No GM_xmlhttpRequest available'));
      }
      GM_xmlhttpRequest({
        method: 'HEAD',
        url: location.origin + '/',
        headers: { 'Cache-Control': 'no-store' },
        onload: (res) => {
          const m = /^date:\s*(.+)$/im.exec(res.responseHeaders || '');
          if (m && m[1]) {
            resolve(new Date(m[1]));
          } else {
            reject(new Error('No Date header'));
          }
        },
        onerror: (err) => reject(err),
      });
    });
  }

  async function getServerDate() {
    if (!hasServerTime && !serverTimeInitFailed) {
      if (!serverTimeInitPromise) {
        serverTimeInitPromise = (async () => {
          const serverDate = await fetchServerDate();
          serverTimeOffsetMs = serverDate.getTime() - Date.now();
          hasServerTime = true;
          return new Date(Date.now() + serverTimeOffsetMs);
        })()
          .catch((err) => {
            serverTimeInitFailed = true;
            throw err;
          })
          .finally(() => {
            serverTimeInitPromise = null;
          });
      }
      try {
        return await serverTimeInitPromise;
      } catch (e) {
        // 端末時刻にフォールバック
      }
    }
    if (hasServerTime) {
      return new Date(Date.now() + serverTimeOffsetMs);
    }
    return new Date();
  }

  /***** リロード制御（サーバー時刻ベース） *****/
  let ticking = false;
  let pendingReload = false;
  let attemptBlockedUntil = 0;
  let reloadInfo = loadReloadInfo();

  // 予約変更フロー：直前枠が空いていたら実行
  function extractFirstTimeText(source) {
    if (!source) return '';
    const match = String(source).match(SELECTORS.timePattern);
    return match ? match[0] : '';
  }

  function extractSlotInfo(el) {
    if (!el) return null;
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const attrSources = [
      text,
      el.getAttribute('data-time-slot') || '',
      el.getAttribute('data-time') || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
    ];
    let html = '';
    try {
      html = (el.outerHTML || '').replace(/\s+/g, ' ');
    } catch (e) {
      html = '';
    }
    attrSources.push(html);

    let match = null;
    let matchSource = '';
    for (const src of attrSources) {
      if (!src) continue;
      const found = src.match(SELECTORS.timePattern);
      if (found) {
        match = found;
        matchSource = src;
        break;
      }
    }
    if (!match) return null;
    const [h, m] = match[0].split(':').map(n => parseInt(n, 10));
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return {
      text: text || matchSource || match[0],
      label: match[0],
      minutes: h * 60 + m,
    };
  }

  function isSelectableSlot(el, precomputedActiveHints = null) {
    if (!el) return false;
    const activeHints = precomputedActiveHints == null ? collectActiveHints(el) : precomputedActiveHints;
    if (activeHints.length) return false;
    if (el.getAttribute('aria-pressed') === 'true') return false;
    if (el.getAttribute('data-disabled') === 'true') return false;
    const ariaDisabled = el.getAttribute('aria-disabled');
    if (ariaDisabled && ariaDisabled !== 'false') return false;
    if (el.classList.contains('is-disabled')) return false;
    const td = el.closest('td');
    if (td && td.getAttribute('data-gray-out') === 'true') return false;
    const statusImg = el.querySelector('img[alt]');
    if (statusImg) {
      const alt = statusImg.getAttribute('alt') || '';
      if (/予約不可|満員/.test(alt)) return false;
    }
    return true;
  }

  async function waitForButtonByText(pattern, options = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < ACTION_TIMEOUT_MS) {
      const btn = findButtonByText(pattern, options);
      if (btn) return btn;
      await sleep(DOM_POLL_INTERVAL_MS);
    }
    return null;
  }

  async function waitForConfirmButton() {
    const t0 = Date.now();
    while (Date.now() - t0 < ACTION_TIMEOUT_MS) {
      for (const sel of SELECTORS.confirmToastButton) {
        const btn = document.querySelector(sel);
        if (btn && isElementVisible(btn)) return btn;
      }
      const fallback = findButtonByText(SELECTORS.confirmButtonText, { requireVisible: true });
      if (fallback) return fallback;
      await sleep(DOM_POLL_INTERVAL_MS);
    }
    return null;
  }

  async function waitForToastResult() {
    const t0 = Date.now();
    while (Date.now() - t0 < ACTION_TIMEOUT_MS) {
      const bodyText = document.body.innerText || '';
      if (SELECTORS.successToast.test(bodyText)) return 'success';
      if (SELECTORS.failureToast.test(bodyText)) return 'failure';
      await sleep(DOM_POLL_INTERVAL_MS);
    }
    return null;
  }

  function scheduleReload(reason = '', delay = 600) {
    if (pendingReload) return;
    pendingReload = true;
    if (reason) log(`リロード予約: ${reason}`);
    setTimeout(() => reloadPage(reason || '自動リロード'), delay);
  }

  function scopeButtonsToCurrentDay(allButtons, currentButton) {
    if (!currentButton) return allButtons;
    for (const sel of SLOT_SCOPE_SELECTORS) {
      const scopeEl = currentButton.closest(sel);
      if (!scopeEl) continue;
      const scoped = allButtons.filter(btn => scopeEl.contains(btn));
      if (scoped.length) return scoped;
    }
    return allButtons;
  }

  function getSlotScopeSignature(button) {
    if (!button) return '';
    for (const attr of SLOT_SCOPE_ATTRIBUTE_KEYS) {
      const scopeEl = button.closest(`[${attr}]`);
      if (scopeEl) {
        const value = scopeEl.getAttribute(attr);
        if (value) return `${attr}:${value}`;
      }
    }
    return '';
  }

  function describeSlotScope(button) {
    if (!button) return '';
    for (const attr of SLOT_SCOPE_ATTRIBUTE_KEYS) {
      const scopeEl = button.closest(`[${attr}]`);
      if (scopeEl) {
        const value = scopeEl.getAttribute(attr);
        if (value) return value;
      }
    }
    const table = button.closest('table');
    if (table) {
      const caption = table.querySelector('caption');
      if (caption && caption.textContent) {
        const text = caption.textContent.trim();
        if (text) return text;
      }
      const th = table.querySelector('thead th');
      if (th && th.textContent) {
        const text = th.textContent.trim();
        if (text) return text;
      }
    }
    return '';
  }

  async function tryReservationChangeOnPrevSlot() {
    let confirmedCurrentSlot = false;
    const buttons = collectSlotButtons();
    if (!buttons.length) {
      log('時間選択ボタンが見つかりませんでした');
      return { status: 'pending', checked: false };
    }

    const entries = buttons.map((btn) => {
      const info = extractSlotInfo(btn);
      const hints = collectActiveHints(btn);
      const text = (btn.innerText || btn.textContent || '').trim();
      const scopeSignature = getSlotScopeSignature(btn);
      const activeScore = scoreActiveHints(hints);
      return {
        el: btn,
        info,
        hints,
        text,
        scopeSignature,
        activeScore,
        selectable: false,
      };
    });

    const entryByElement = new Map();
    for (const entry of entries) {
      entry.selectable = isSelectableSlot(entry.el, entry.hints);
      entryByElement.set(entry.el, entry);
    }

    const activeEntries = entries
      .filter((entry) => entry.activeScore > 0)
      .sort((a, b) => b.activeScore - a.activeScore);

    let currentEntry = null;
    if (activeEntries.length) {
      const top = activeEntries[0];
      const runnerUp = activeEntries[1];
      if (
        top.activeScore >= 30 &&
        (!runnerUp || top.activeScore > runnerUp.activeScore || top.activeScore >= 90)
      ) {
        currentEntry = top;
      }
    }

    let usedStoredCurrent = false;
    if ((!currentEntry || !currentEntry.info) && lastKnownCurrentSlot) {
      const storedEntry = findEntryByStoredSignature(entries, lastKnownCurrentSlot);
      if (storedEntry) {
        currentEntry = storedEntry;
        usedStoredCurrent = true;
      }
    }

    if (!currentEntry) {
      if (lastKnownCurrentSlot && lastKnownCurrentSlot.displayLabel) {
        setCurrentSlotDisplay(lastKnownCurrentSlot.displayLabel, { estimated: true });
      } else {
        setCurrentSlotDisplay('', { fallback: '未検出' });
      }
      const now = Date.now();
      if (now - lastActiveDetectionFailureLogTime > 25_000) {
        lastActiveDetectionFailureLogTime = now;
        log('現在の予約枠を特定できませんでした');
        const debugSummary = entries
          .slice()
          .sort((a, b) => b.activeScore - a.activeScore)
          .slice(0, 6)
          .map((entry) => {
            const label = entry.info?.label || '?';
            const hintSummary = entry.hints.slice(0, 3).join('|') || 'no-hints';
            const scorePart = entry.activeScore ? `:${entry.activeScore}` : '';
            return `${label}${scorePart}:${hintSummary}`;
          })
          .join(' / ');
        if (debugSummary) {
          log(`候補情報: ${debugSummary}`);
        }
      }
      return { status: 'pending', checked: false };
    }
    lastActiveDetectionFailureLogTime = 0;

    let currentInfo = currentEntry.info;
    if (!currentInfo || Number.isNaN(currentInfo.minutes)) {
      if (lastKnownCurrentSlot && lastKnownCurrentSlot.minutes != null) {
        currentInfo = {
          text: lastKnownCurrentSlot.text || lastKnownCurrentSlot.label || '',
          label: lastKnownCurrentSlot.label || '',
          minutes: lastKnownCurrentSlot.minutes,
        };
        usedStoredCurrent = true;
      } else {
        let snippet = '';
        try {
          snippet = (currentEntry.el.outerHTML || '').replace(/\s+/g, ' ').trim();
        } catch (e) {
          snippet = '';
        }
        if (snippet.length > 180) {
          snippet = snippet.slice(0, 177) + '…';
        }
        const messages = ['現在の予約時間を取得できませんでした'];
        if (snippet) {
          messages.push(`要素抜粋: ${snippet}`);
        }
        log(...messages);
        return { status: 'error', checked: false };
      }
    }

    const scopeSignature = currentEntry.scopeSignature || getSlotScopeSignature(currentEntry.el);
    const scopeLabel = describeSlotScope(currentEntry.el);
    const buttonText = currentEntry.text;
    const displayCandidates = [
      currentInfo.label,
      extractFirstTimeText(buttonText),
      lastKnownCurrentSlot && lastKnownCurrentSlot.displayLabel,
    ].filter(Boolean);
    const currentDisplayLabel = displayCandidates.length ? displayCandidates[0] : '';
    setCurrentSlotDisplay(currentDisplayLabel, { estimated: usedStoredCurrent });
    const currentSignature = `${scopeSignature}|${currentDisplayLabel}`;
    const shouldLogCurrentSlot =
      lastLoggedCurrentSlotSignature !== currentSignature ||
      (usedStoredCurrent && !lastLoggedUsedStoredForCurrent) ||
      (!usedStoredCurrent && lastLoggedUsedStoredForCurrent);
    if (shouldLogCurrentSlot) {
      lastLoggedCurrentSlotSignature = currentSignature;
      lastLoggedUsedStoredForCurrent = usedStoredCurrent;
      const suffix = usedStoredCurrent ? '［保存情報から推定］' : '';
      log(`現在の予約枠: ${currentDisplayLabel}${suffix}`);
    } else {
      lastLoggedUsedStoredForCurrent = usedStoredCurrent;
    }

    if (currentInfo && Number.isFinite(currentInfo.minutes)) {
      lastKnownCurrentSlot = {
        scopeSignature: scopeSignature || '',
        scopeLabel,
        label: currentInfo.label || currentDisplayLabel,
        displayLabel: currentDisplayLabel,
        minutes: currentInfo.minutes,
        text: buttonText || '',
      };
    }

    confirmedCurrentSlot = true;
    lastSuccessfulCheckTime = Date.now();

    const candidateButtons = scopeButtonsToCurrentDay(buttons, currentEntry.el);

    const candidates = candidateButtons
      .map((btn) => entryByElement.get(btn))
      .filter((entry) => {
        if (!entry || !entry.info || !entry.selectable) return false;
        return entry.info.minutes < currentInfo.minutes;
      })
      .sort((a, b) => b.info.minutes - a.info.minutes);

    if (!candidates.length) {
      log('現在の予約時間より前で選択可能な枠はありません');
      return { status: 'no-slot', checked: true };
    }

    const target = candidates[0];

    const attempt = await registerAttempt();
    if (!attempt.allowed) {
      return { status: 'limit', checked: true };
    }

    log(`前倒し候補を選択: ${target.info.label} (${target.info.text})`);
    target.el.click();

    const setBtn = await waitForButtonByText(SELECTORS.setVisitButtonText, {
      requireVisible: true,
      requireEnabled: true,
    });
    if (!setBtn) {
      log('「来場日時を設定する」ボタンが見つかりませんでした');
      return { status: 'error', checked: confirmedCurrentSlot };
    }
    triggerButtonClick(setBtn);
    log('「来場日時を設定する」を押下');

    const confirmBtn = await waitForConfirmButton();
    if (!confirmBtn) {
      log('確認モーダルの「来場日時を変更する」ボタンが見つかりませんでした');
      return { status: 'error', checked: confirmedCurrentSlot };
    }
    confirmBtn.click();
    log('「来場日時を変更する」を押下');

    const result = await waitForToastResult();
    if (result === 'success') {
      log('来場日時の変更に成功しました。スクリプトを停止します。');
      setStatus('done');
      setEnabled(false);
      return { status: 'success', checked: confirmedCurrentSlot };
    }
    if (result === 'failure') {
      log('定員オーバーのトーストを検出しました');
      scheduleReload('変更失敗トースト');
      return { status: 'failure', checked: confirmedCurrentSlot };
    }

    log('変更結果のトーストが確認できませんでした');
    return { status: 'error', checked: confirmedCurrentSlot };
  }

  function reloadPage(reason = '') {
    if (reason) log('リロード:', reason);
    location.reload();
  }

  async function tick() {
    if (ticking || pendingReload) return;
    ticking = true;
    setStatus('running');
    try {
      let result = { status: 'skipped', checked: checkCompletedThisLoad };
      if (!checkCompletedThisLoad && Date.now() >= attemptBlockedUntil) {
        try {
          result = await tryReservationChangeOnPrevSlot();
        } catch (e) {
          log('予約変更処理で例外:', e.message || e);
          scheduleReload('例外発生');
          return;
        }
        if (result.checked) {
          checkCompletedThisLoad = true;
        }
        if (pendingReload) return;
        if (result.status === 'success' || result.status === 'failure') {
          return;
        }
      }

      const now = await getServerDate();
      const nowMs = now.getTime();
      const sec = now.getSeconds();
      const bucket = Math.floor(nowMs / 60_000);

      const hadBucket = typeof reloadInfo.bucket === 'number';
      if (reloadInfo.bucket !== bucket) {
        reloadInfo = resetReloadInfo(bucket);
        reloadsThisMinute = 0;
        resetAttemptInfo(hadBucket ? '分が変わったため、予約変更試行回数の記録をリセットしました' : '');
      } else {
        reloadsThisMinute = reloadInfo.count || 0;
        if (!('loggedMinute' in reloadInfo)) {
          reloadInfo.loggedMinute = null;
        }
      }

      if (reloadInfo.loggedMinute !== bucket) {
        log(`分が変わりました → ${now.toLocaleTimeString()} / この分のリロード残り: ${Math.max(0, MAX_RELOADS_PER_MINUTE - reloadsThisMinute)}`);
        reloadInfo.loggedMinute = bucket;
        saveReloadInfo(reloadInfo);
      }

      const inWindow = sec >= WINDOW_START && sec < WINDOW_END;
      const hasRecentCheck =
        lastSuccessfulCheckTime > 0 &&
        (checkCompletedThisLoad || Date.now() - lastSuccessfulCheckTime <= RECENT_CHECK_THRESHOLD_MS);
      if (inWindow && reloadsThisMinute < MAX_RELOADS_PER_MINUTE) {
        if (!hasRecentCheck) {
          if (lastReloadDeferLogBucket !== bucket) {
            log('現在の予約枠の確認待ちのためリロードを一時停止します');
            lastReloadDeferLogBucket = bucket;
          }
          return;
        }
        lastReloadDeferLogBucket = null;
        reloadsThisMinute++;
        reloadInfo.count = reloadsThisMinute;
        saveReloadInfo(reloadInfo);
        pendingReload = true;
        reloadPage(`サーバー時刻 ${sec}s（分内 ${reloadsThisMinute}/${MAX_RELOADS_PER_MINUTE}）`);
        return;
      }
      if (!inWindow) {
        lastReloadDeferLogBucket = null;
      }

      if (result.status === 'limit') {
        // ログは registerAttempt 内で出力済み。上限解除まで待機。
      }
    } finally {
      if (currentStatus !== 'done') {
        setStatus('idle');
      }
      ticking = false;
    }
  }

  /***** UI：トグル＆ステータス表示 *****/
  function isEnabled() {
    try {
      const v = sessionStorage.getItem(ENABLE_KEY);
      if (v === null) return enabledFallback;
      enabledFallback = v === '1';
      return enabledFallback;
    } catch {
      return enabledFallback;
    }
  }
  function setEnabled(flag) {
    enabledFallback = flag;
    try {
      sessionStorage.setItem(ENABLE_KEY, flag ? '1' : '0');
    } catch {
      // storage unavailable
    }
    updateNextUpdateDisplay();
  }

  function ensureToggle() {
    const existingWrap = $('#expo-adv-toggle');
    if (existingWrap) {
      statusIndicator = existingWrap.querySelector('#expo-adv-status-value');
      if (statusIndicator) {
        setStatus(currentStatus);
      }
      currentSlotIndicator = existingWrap.querySelector('#expo-adv-current-slot-value');
      if (currentSlotIndicator) {
        currentSlotIndicator.textContent = currentSlotDisplay.text;
        if (currentSlotDisplay.estimated) {
          currentSlotIndicator.dataset.estimated = '1';
        } else {
          delete currentSlotIndicator.dataset.estimated;
        }
      }
      nextUpdateIndicator = existingWrap.querySelector('#expo-adv-next-update-value');
      if (nextUpdateIndicator) {
        updateNextUpdateDisplay();
      }
      return;
    }
    const wrap = document.createElement('div');
    wrap.id = 'expo-adv-toggle';
    Object.assign(wrap.style, {
      position: 'fixed', top: '10px', left: '10px', zIndex: 999999,
      display: 'flex', gap: '6px', alignItems: 'center',
      background: '#fff', border: '1px solid #999', borderRadius: '10px',
      padding: '6px 8px', boxShadow: '0 2px 8px rgba(0,0,0,0.15)', fontSize: '12px'
    });

    const btn = document.createElement('button');
    Object.assign(btn.style, { padding: '4px 8px', cursor: 'pointer' });
    function updateToggleLabel() {
      btn.textContent = isEnabled() ? '自動繰り上げ変更：ON' : '自動繰り上げ変更：OFF';
    }
    updateToggleLabel();
    btn.onclick = () => {
      const next = !isEnabled();
      setEnabled(next);
      updateToggleLabel();
      if (next) {
        setStatus('idle');
      } else if (currentStatus !== 'done') {
        setStatus('idle');
      }
      updateNextUpdateDisplay();
    };

    const statusWrap = document.createElement('span');
    statusWrap.id = 'expo-adv-status';
    Object.assign(statusWrap.style, { display: 'flex', alignItems: 'center', gap: '4px' });

    const statusLabel = document.createElement('span');
    statusLabel.textContent = '状態:';

    const statusValue = document.createElement('span');
    statusValue.id = 'expo-adv-status-value';
    Object.assign(statusValue.style, { fontWeight: 'bold' });
    statusIndicator = statusValue;
    setStatus(currentStatus);

    statusWrap.append(statusLabel, statusValue);

    const currentSlotWrap = document.createElement('span');
    currentSlotWrap.id = 'expo-adv-current-slot';
    Object.assign(currentSlotWrap.style, { display: 'flex', alignItems: 'center', gap: '4px' });

    const currentSlotLabel = document.createElement('span');
    currentSlotLabel.textContent = '現在の予約:';

    const currentSlotValue = document.createElement('span');
    currentSlotValue.id = 'expo-adv-current-slot-value';
    Object.assign(currentSlotValue.style, { fontWeight: 'bold' });
    currentSlotIndicator = currentSlotValue;
    currentSlotIndicator.textContent = currentSlotDisplay.text;
    if (currentSlotDisplay.estimated) {
      currentSlotIndicator.dataset.estimated = '1';
    }

    currentSlotWrap.append(currentSlotLabel, currentSlotValue);

    const nextUpdateWrap = document.createElement('span');
    nextUpdateWrap.id = 'expo-adv-next-update';
    Object.assign(nextUpdateWrap.style, { display: 'flex', alignItems: 'center', gap: '4px' });

    const nextUpdateLabel = document.createElement('span');
    nextUpdateLabel.textContent = '次の更新:';

    const nextUpdateValue = document.createElement('span');
    nextUpdateValue.id = 'expo-adv-next-update-value';
    Object.assign(nextUpdateValue.style, { fontWeight: 'bold' });
    nextUpdateIndicator = nextUpdateValue;
    updateNextUpdateDisplay();

    nextUpdateWrap.append(nextUpdateLabel, nextUpdateValue);

    wrap.append(btn, statusWrap, currentSlotWrap, nextUpdateWrap);
    document.documentElement.appendChild(wrap);

    if (!nextUpdateTimerId) {
      nextUpdateTimerId = window.setInterval(updateNextUpdateDisplay, 200);
    }
  }

  /***** メインループ *****/
  function main() {
    ensureToggle();
    log('スクリプト起動');
    getServerDate().then((date) => {
      if (hasServerTime) {
        log(`サーバー時刻を基準に同期します（現在 ${date.toLocaleTimeString()}）`);
      } else {
        log('サーバー時刻の取得に失敗したため端末時刻を使用します');
      }
    });
    setInterval(async () => {
      if (!isEnabled()) return;
      await tick();
    }, 200);
  }

  // ページ準備後に開始
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }

})();
