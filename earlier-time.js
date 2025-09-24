// ==UserScript==
// @name         Expo2025 予約前倒し：サーバー時刻 43–53秒/分最大4回リロード＋即時リトライ3回
// @namespace    https://yourname.example/
// @version      2025-09-24
// @description  サーバー時刻で各分43〜53秒の間に最大4回自動リロード。直前枠の空き検出で予約変更を実行し、成功で停止。失敗時は秒に関係なく復旧用リロードを最大3回。
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
    // カレンダー/スロットの空き検出（例）
    // 「空き」「予約可」「◯」等のテキストや data-attr を持つ要素を想定
    slotContainer: '[data-testid="slot-list"], .slot-list, .time-slots',
    slotItem: '[data-testid="slot-item"], .slot, li, button',
    slotAvailableText: /空き|予約可|◯|○|available|open/i,

    // 「前の時間（直前枠）」の判定用：時刻テキストを含むノード（例：09:30）
    slotTimeText: /([01]?\d|2[0-3]):[0-5]\d/,

    // 予約変更/確定ボタン
    changeButton: 'button:matches(変更,予約,選択,Proceed,Select)',
    confirmButton: 'button:matches(確定,同意して進む,購入,Confirm,Pay,次へ)',
    // カレンダー再読込が必要な場合（開閉UIなど）
    calendarReload: 'button:matches(再読み込み,更新,Reload,Refresh)',
  };

  // 予約操作のタイムアウト/待機
  const ACTION_TIMEOUT_MS = 10_000;
  const DOM_POLL_INTERVAL_MS = 150;

  // リロード許可ウィンドウ（サーバー時刻）
  const WINDOW_START = 43; // >= 43s
  const WINDOW_END = 53;   // < 53s
  const MAX_RELOADS_PER_MINUTE = 4;

  // 予約失敗時の復旧リロード 最大回数（秒に関係なく実施）
  const MAX_FAILURE_RECOVERY = 3;

  // トグル保存キー
  const ENABLE_KEY = 'expo_adv_enable_v2';

  /***** 便利ユーティリティ *****/
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(...args) {
    console.log('[ExpoAdvance]', ...args);
    appendLogPanel(args.map(String).join(' '));
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
  let lastMinute = null;
  let reloadsThisMinute = 0;
  let ticking = false;
  let failureRecoveryRemaining = 0; // 失敗時の即時復旧用リロード残回数
  let stopped = false;

  // 予約変更フロー：直前枠が空いていたら実行
  async function tryReservationChangeOnPrevSlot() {
    // ページ/アカウントごとのDOM差異に備え、時間表記を解析して
    // 「現在表示中リストの直前の時刻」を優先してクリックする方針
    const container = $(SELECTORS.slotContainer) || document;
    const items = $$(SELECTORS.slotItem, container);
    if (!items.length) {
      log('スロットが見つかりませんでした');
      return false;
    }

    // 時刻を抽出して配列化
    const parsed = items.map(el => {
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const timeMatch = text.match(SELECTORS.slotTimeText);
      const timeStr = timeMatch ? timeMatch[0] : null;
      const available = SELECTORS.slotAvailableText.test(text) && !el.disabled;
      return { el, text, timeStr, available };
    }).filter(x => x.timeStr);

    if (!parsed.length) {
      log('時刻付きスロットが見つかりませんでした');
      return false;
    }

    // 直前（前の時間）＝現在時刻より前の最大の時刻、に近い順でavailableを探索
    const now = await getServerDate().catch(() => new Date());
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    // HH:MM → 絶対分
    function toAbsMin(ts) {
      const [h, m] = ts.split(':').map(n => parseInt(n, 10));
      return h * 60 + m;
    }

    const prevAvail = parsed
      .filter(p => p.available)
      .map(p => ({ ...p, abs: toAbsMin(p.timeStr) }))
      .filter(p => p.abs <= nowMinutes)  // 「前の時間」
      .sort((a, b) => b.abs - a.abs)[0];

    if (!prevAvail) {
      log('前の時間の空き枠は見つかりませんでした');
      return false;
    }

    log('前の時間の空き枠を検出 -> 選択:', prevAvail.text);

    // 1) スロット選択
    prevAvail.el.click();

    // 2) 「変更/予約/選択」等のボタン
    const changeBtn = findButtonByText([/変更|予約|選択|Proceed|Select/]);
    if (changeBtn) {
      changeBtn.click();
    } else {
      log('変更/予約ボタンが見つかりませんでした');
    }

    // 3) 確定系ボタンを待ってクリック
    const ok = await waitAndClickConfirm();
    if (!ok) {
      log('確定ボタン操作に失敗');
      return false;
    }

    // 成功のシグナルを簡易判定（URLや完了文言）
    const success = await waitForSuccess();
    if (success) {
      log('予約変更 成功。スクリプトを停止します。');
      stopped = true;
      return true;
    } else {
      log('予約変更が確認できませんでした（失敗扱い）');
      return false;
    }
  }

  async function waitAndClickConfirm() {
    const t0 = Date.now();
    while (Date.now() - t0 < ACTION_TIMEOUT_MS) {
      const btn = findButtonByText([/確定|同意して進む|購入|Confirm|Pay|次へ/]);
      if (btn) {
        btn.click();
        return true;
      }
      await sleep(DOM_POLL_INTERVAL_MS);
    }
    return false;
  }

  async function waitForSuccess() {
    // 予約完了ページ/完了メッセージの文言など（要調整）
    const successTexts = [/予約が確定|変更が完了|手続きが完了|Completed|Success/i];
    const t0 = Date.now();
    while (Date.now() - t0 < ACTION_TIMEOUT_MS) {
      const bodyText = document.body.innerText || '';
      if (successTexts.some(rx => rx.test(bodyText))) return true;
      await sleep(DOM_POLL_INTERVAL_MS);
    }
    // URL変化で判断できるならここに条件を追加
    return false;
  }

  function reloadPage(reason = '') {
    if (reason) log('リロード:', reason);
    location.reload();
  }

  // カレンダーの強制再読み込み（ボタンがある場合）
  function forceCalendarReload() {
    const btn = findButtonByText([/再読み込み|更新|Reload|Refresh/]);
    if (btn) {
      log('カレンダーの再読み込みボタンを押下');
      btn.click();
      return true;
    }
    return false;
  }

  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      // 1) 直前枠の空きを見つけたら即座に予約変更を試行
      //    （ページ遷移中などは noop になるが問題なし）
      try {
        const changed = await tryReservationChangeOnPrevSlot();
        if (stopped) return; // 成功で停止
        if (!changed) {
          // 予約失敗後の復旧リロード（秒に関係なく最大3回）
          if (failureRecoveryRemaining > 0) {
            const triedReloadButton = forceCalendarReload();
            if (!triedReloadButton) {
              failureRecoveryRemaining--;
              reloadPage('予約失敗復旧リロード 残り:' + failureRecoveryRemaining);
              return;
            }
            // ボタンで再読込できた場合はカウントは消費しない
          }
        } else {
          return; // 成功時
        }
      } catch (e) {
        log('予約変更処理で例外:', e.message || e);
        if (failureRecoveryRemaining > 0) {
          failureRecoveryRemaining--;
          reloadPage('例外復旧リロード 残り:' + failureRecoveryRemaining);
          return;
        }
      }

      // 2) サーバー時刻を取得
      const now = await getServerDate().catch(() => new Date());
      const sec = now.getSeconds();
      const min = now.getMinutes();

      // 分が変わったらリロード回数をリセット
      if (lastMinute !== min) {
        lastMinute = min;
        reloadsThisMinute = 0;
        log(`分が変わりました → ${now.toLocaleTimeString()} / この分のリロード残り: ${MAX_RELOADS_PER_MINUTE}`);
      }

      const inWindow = sec >= WINDOW_START && sec < WINDOW_END;

      // 3) 43〜53秒の窓内で、かつ分内のリロード上限未満ならリロード
      if (inWindow && reloadsThisMinute < MAX_RELOADS_PER_MINUTE) {
        reloadsThisMinute++;
        reloadPage(`サーバー時刻 ${sec}s（分内 ${reloadsThisMinute}/${MAX_RELOADS_PER_MINUTE}）`);
        return;
      }

      // 4) それ以外は待機
    } finally {
      ticking = false;
    }
  }

  /***** UI：トグル＆ログ *****/
  function isEnabled() {
    const v = localStorage.getItem(ENABLE_KEY);
    return v === null ? true : v === '1';
  }
  function setEnabled(flag) {
    localStorage.setItem(ENABLE_KEY, flag ? '1' : '0');
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
    const label = () => btn.textContent = isEnabled() ? '自動：ON' : '自動：OFF';
    label();
    btn.onclick = () => { setEnabled(!isEnabled()); label(); };

    const recBtn = document.createElement('button');
    recBtn.textContent = '復旧×3';
    Object.assign(recBtn.style, { padding: '4px 8px', cursor: 'pointer' });
    recBtn.title = '次回の失敗時に、秒に関係なく復旧用リロードを最大3回行います';
    recBtn.onclick = () => { failureRecoveryRemaining = MAX_FAILURE_RECOVERY; log('復旧リロード 3回予約済み'); };

    const logBtn = document.createElement('button');
    logBtn.textContent = 'ログ';
    Object.assign(logBtn.style, { padding: '4px 8px', cursor: 'pointer' });
    logBtn.onclick = toggleLogPanel;

    wrap.append(btn, recBtn, logBtn);
    document.documentElement.appendChild(wrap);
  }

  let logPanel;
  function appendLogPanel(text) {
    if (!logPanel) return;
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    logPanel.appendChild(line);
    if (logPanel.childElementCount > 200) {
      logPanel.firstChild.remove();
    }
  }
  function toggleLogPanel() {
    if (!logPanel) {
      logPanel = document.createElement('div');
      Object.assign(logPanel.style, {
        position: 'fixed', top: '60px', left: '10px', zIndex: 999999,
        width: '360px', maxHeight: '45vh', overflow: 'auto', background: '#fff',
        border: '1px solid #999', borderRadius: '10px', padding: '8px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)', fontSize: '12px'
      });
      document.documentElement.appendChild(logPanel);
      appendLogPanel('ログ開始');
    } else {
      logPanel.remove();
      logPanel = null;
    }
  }

  /***** メインループ *****/
  function main() {
    ensureToggle();
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
