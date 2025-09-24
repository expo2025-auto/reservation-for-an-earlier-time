// ==UserScript==
// @name         Expo2025 予約前倒し：直前空き枠の自動取得
// @namespace    https://github.com/expo-automation/reservation-for-an-earlier-time
// @version      2025-09-24.4
// @description  現在の予約時刻より早い空き枠を自動選択し、確認モーダルまで進めて変更を完了します。失敗トースト検出時は同分内3回までリトライ。
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
    activeButton: '[aria-pressed="true"]',
    timePattern: /([01]?\d|2[0-3]):[0-5]\d/,
    setVisitButtonText: /来場日時を設定する/,
    confirmButtonText: /来場日時を変更する/,
    successToast: /来場日時が設定されました/,
    failureToast: /定員を超えたため、ご希望の時間帯は選択できませんでした/,
  };

  // 予約操作のタイムアウト/待機
  const ACTION_TIMEOUT_MS = 10_000;
  const DOM_POLL_INTERVAL_MS = 150;

  // リロード許可ウィンドウ（サーバー時刻）
  const WINDOW_START = 43; // >= 43s
  const WINDOW_END = 53; // < 53s
  const MAX_RELOADS_PER_MINUTE = 4;

  // 予約失敗時の復旧リロード 最大回数（秒に関係なく実施）
  const MAX_ATTEMPTS_PER_MINUTE = 3;
  const ATTEMPT_STORAGE_KEY = 'expo_adv_attempt_info_v3';
  const RELOAD_STORAGE_KEY = 'expo_adv_reload_info_v1';

  // トグル保存キー
  const ENABLE_KEY = 'expo_adv_enable_v2';
  let enabledFallback = false;

  const LOG_MAX_LINES = 5;
  const logBuffer = [];
  let logPanel;

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
    addLogEntry(args.map((arg) => String(arg)).join(' '));
  }

  // :matches() 疑似を簡易サポート（innerTextでフィルタ）
  function findButtonByText(patterns) {
    const pats = Array.isArray(patterns) ? patterns : [patterns];
    const buttons = $$('button, [role="button"]');
    for (const b of buttons) {
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
    const now = await getServerDate().catch(() => new Date());
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
    if (message) {
      log(message);
    }
  }

  /***** サーバー時刻取得（Dateヘッダ） *****/
  async function getServerDate() {
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
          const m = /^date:\s*(.+)$/gim.exec(res.responseHeaders || '');
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

  /***** リロード制御（サーバー時刻ベース） *****/
  let reloadsThisMinute = 0;
  let ticking = false;
  let pendingReload = false;
  let attemptBlockedUntil = 0;
  let reloadInfo = loadReloadInfo();

  // 予約変更フロー：直前枠が空いていたら実行
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

  function isSelectableSlot(el) {
    if (!el) return false;
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

  async function waitForButtonByText(pattern) {
    const t0 = Date.now();
    while (Date.now() - t0 < ACTION_TIMEOUT_MS) {
      const btn = findButtonByText(pattern);
      if (btn) return btn;
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
    const buttons = collectSlotButtons();
    if (!buttons.length) {
      log('時間選択ボタンが見つかりませんでした');
      return 'no-slot';
    }

    const currentButton = buttons.find(btn => btn.matches(SELECTORS.activeButton) || btn.getAttribute('aria-pressed') === 'true');
    if (!currentButton) {
      log('現在の予約枠を特定できませんでした');
      return 'no-slot';
    }

    const currentInfo = extractSlotInfo(currentButton);
    if (!currentInfo) {
      let snippet = '';
      try {
        snippet = (currentButton.outerHTML || '').replace(/\s+/g, ' ').trim();
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
      return 'error';
    }
    const scopeSignature = getSlotScopeSignature(currentButton);
    const scopeLabel = describeSlotScope(currentButton);
    const buttonText = (currentButton.innerText || currentButton.textContent || '').trim();
    const currentDisplayLabel = buttonText ? buttonText.split(/\s+/)[0] : currentInfo.label;
    const currentSignature = `${scopeSignature}|${currentDisplayLabel}`;
    if (lastLoggedCurrentSlotSignature !== currentSignature) {
      lastLoggedCurrentSlotSignature = currentSignature;
      const scopeMessage = scopeLabel ? `（${scopeLabel}）` : '';
      log(`現在の予約枠: ${currentDisplayLabel}${scopeMessage}`);
    }

    const candidateButtons = scopeButtonsToCurrentDay(buttons, currentButton);

    const candidates = candidateButtons
      .map(btn => {
        const info = extractSlotInfo(btn);
        if (!info) return null;
        return { el: btn, info, selectable: isSelectableSlot(btn) };
      })
      .filter(Boolean)
      .filter(item => item.selectable && item.info.minutes < currentInfo.minutes)
      .sort((a, b) => b.info.minutes - a.info.minutes);

    if (!candidates.length) {
      log('現在の予約時間より前で選択可能な枠はありません');
      return 'no-slot';
    }

    const target = candidates[0];

    const attempt = await registerAttempt();
    if (!attempt.allowed) {
      return 'limit';
    }

    log(`前倒し候補を選択: ${target.info.label} (${target.info.text})`);
    target.el.click();

    const setBtn = await waitForButtonByText(SELECTORS.setVisitButtonText);
    if (!setBtn) {
      log('「来場日時を設定する」ボタンが見つかりませんでした');
      return 'error';
    }
    setBtn.click();
    log('「来場日時を設定する」を押下');

    const confirmBtn = await waitForButtonByText(SELECTORS.confirmButtonText);
    if (!confirmBtn) {
      log('確認モーダルの「来場日時を変更する」ボタンが見つかりませんでした');
      return 'error';
    }
    confirmBtn.click();
    log('「来場日時を変更する」を押下');

    const result = await waitForToastResult();
    if (result === 'success') {
      log('来場日時の変更に成功しました。スクリプトを停止します。');
      setEnabled(false);
      return 'success';
    }
    if (result === 'failure') {
      log('定員オーバーのトーストを検出しました');
      scheduleReload('変更失敗トースト');
      return 'failure';
    }

    log('変更結果のトーストが確認できませんでした');
    return 'error';
  }

  function reloadPage(reason = '') {
    if (reason) log('リロード:', reason);
    location.reload();
  }

  async function tick() {
    if (ticking || pendingReload) return;
    ticking = true;
    try {
      let result = 'skipped';
      if (Date.now() >= attemptBlockedUntil) {
        try {
          result = await tryReservationChangeOnPrevSlot();
        } catch (e) {
          log('予約変更処理で例外:', e.message || e);
          scheduleReload('例外発生');
          return;
        }
        if (pendingReload) return;
        if (result === 'success' || result === 'failure') {
          return;
        }
      }

      const now = await getServerDate().catch(() => new Date());
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
      if (inWindow && reloadsThisMinute < MAX_RELOADS_PER_MINUTE) {
        reloadsThisMinute++;
        reloadInfo.count = reloadsThisMinute;
        saveReloadInfo(reloadInfo);
        pendingReload = true;
        reloadPage(`サーバー時刻 ${sec}s（分内 ${reloadsThisMinute}/${MAX_RELOADS_PER_MINUTE}）`);
        return;
      }

      if (result === 'limit') {
        // ログは registerAttempt 内で出力済み。上限解除まで待機。
      }
    } finally {
      ticking = false;
    }
  }

  /***** UI：トグル＆ログ *****/
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
  }

  function ensureToggle() {
    if ($('#expo-adv-toggle')) return;
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
      btn.textContent = isEnabled() ? '自動：ON' : '自動：OFF';
    }
    updateToggleLabel();
    btn.onclick = () => {
      setEnabled(!isEnabled());
      updateToggleLabel();
    };

    const logBtn = document.createElement('button');
    logBtn.textContent = 'ログ';
    Object.assign(logBtn.style, { padding: '4px 8px', cursor: 'pointer' });
    logBtn.onclick = toggleLogPanel;

    wrap.append(btn, logBtn);
    document.documentElement.appendChild(wrap);
  }

  function addLogEntry(text) {
    logBuffer.push({ time: new Date(), text });
    while (logBuffer.length > LOG_MAX_LINES) {
      logBuffer.shift();
    }
    if (logPanel) {
      renderLogPanel();
    }
  }

  function renderLogPanel() {
    if (!logPanel) return;
    logPanel.innerHTML = '';
    for (const entry of logBuffer) {
      const line = document.createElement('div');
      line.textContent = `[${entry.time.toLocaleTimeString()}] ${entry.text}`;
      logPanel.appendChild(line);
    }
  }

  function openLogPanel() {
    if (logPanel) return;
    logPanel = document.createElement('div');
    Object.assign(logPanel.style, {
      position: 'fixed', top: '60px', left: '10px', zIndex: 999999,
      width: '360px', maxHeight: '45vh', overflow: 'auto', background: '#fff',
      border: '1px solid #999', borderRadius: '10px', padding: '8px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.15)', fontSize: '12px'
    });
    document.documentElement.appendChild(logPanel);
    renderLogPanel();
  }

  function closeLogPanel() {
    if (!logPanel) return;
    logPanel.remove();
    logPanel = null;
  }

  function toggleLogPanel() {
    if (logPanel) {
      closeLogPanel();
    } else {
      openLogPanel();
    }
  }

  /***** メインループ *****/
  function main() {
    ensureToggle();
    openLogPanel();
    log('スクリプト起動');
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
