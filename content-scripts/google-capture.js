/**
 * Google Workspace Capture Script
 *
 * Google Docs, Sheets, Slides, Drive에서 활동을 수집합니다.
 * - Docs: .kix-lineview 텍스트 추출
 * - Sheets: 활동 패턴만 (title, active sheet)
 * - Slides: 발표자 노트 추출
 * - Drive: 파일 관리 활동
 *
 * @see research.md 3.3절
 */
(function() {
  'use strict';

  // ============================================================================
  // 전역 인스턴스 관리 (Extension Reload 대응)
  // ============================================================================

  const SCRIPT_ID = '__DAILY_SCRUM_GOOGLE_CAPTURE__';

  // 기존 인스턴스가 있으면 cleanup (확장프로그램 리로드 시)
  if (window[SCRIPT_ID]) {
    try {
      window[SCRIPT_ID].cleanup();
    } catch (e) {
      // 이전 인스턴스 cleanup 실패 무시
    }
  }

  /**
   * Extension context 유효성 검사
   * @returns {boolean} context가 유효하면 true
   */
  function isContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /**
   * Service Worker 준비 대기 후 메시지 전송 (Race Condition 방지)
   * @param {Object} message - 전송할 메시지
   * @param {number} maxRetries - 최대 재시도 횟수
   * @returns {Promise<any>} 응답
   */
  async function sendMessageWithRetry(message, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await chrome.runtime.sendMessage(message);
      } catch (error) {
        const errorMsg = error.message || '';
        if (errorMsg.includes('context invalidated') ||
            errorMsg.includes('Receiving end does not exist')) {
          // Service worker가 아직 준비 안됨 - 대기 후 재시도
          await new Promise(r => setTimeout(r, 100 * (i + 1)));
          continue;
        }
        throw error;
      }
    }
    // 모든 재시도 실패 시 조용히 실패
    return null;
  }

  // M3: cleanup 후 FLUSH_NOW 등으로 인한 추가 캡처 방지
  let isStopped = false;

  // ============================================================================
  // 유틸리티 함수
  // ============================================================================

  /**
   * 민감한 요소 체크
   * @param {Element} el - 검사할 요소
   * @returns {boolean} 민감한 요소 여부
   */
  function isSensitiveElement(el) {
    if (!el) return true;

    const type = el.type?.toLowerCase();
    if (type === 'password' || type === 'tel') return true;

    const autocomplete = el.getAttribute('autocomplete')?.toLowerCase();
    if (autocomplete?.includes('cc-') || autocomplete === 'password') return true;

    return false;
  }

  /**
   * URL에서 Document ID 추출
   * @param {string} url - 문서 URL
   * @returns {string|null} Document ID
   */
  function extractDocId(url) {
    const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
  }

  /**
   * 현재 Google 앱 감지
   * @returns {string} 앱 이름
   */
  function detectGoogleApp() {
    const hostname = window.location.hostname.toLowerCase();
    const pathname = window.location.pathname.toLowerCase();

    if (hostname.includes('docs.google.com') && pathname.includes('/document/')) {
      return 'docs';
    }
    if (hostname.includes('docs.google.com') && pathname.includes('/spreadsheets/')) {
      return 'sheets';
    }
    if (hostname.includes('docs.google.com') && pathname.includes('/presentation/')) {
      return 'slides';
    }
    if (hostname.includes('drive.google.com')) {
      return 'drive';
    }

    return 'unknown';
  }

  /**
   * Debounce 함수
   * @param {Function} func - 실행할 함수
   * @param {number} wait - 대기 시간 (ms)
   * @returns {Function} Debounced 함수
   */
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  function isElementInDocsEditor(target) {
    const el = target && target.nodeType === 1 ? target : null;
    const active = document.activeElement instanceof Element ? document.activeElement : null;
    return !!(
      el?.closest('.kix-appview-editor') ||
      el?.closest('.kix-page-content-wrapper') ||
      el?.closest('.kix-canvas-tile-content') ||
      el?.getAttribute('contenteditable') === 'true' ||
      active?.closest('.kix-appview-editor') ||
      active?.closest('.kix-page-content-wrapper') ||
      active?.closest('.kix-canvas-tile-content') ||
      (document.hasFocus() && !!document.querySelector('.kix-appview-editor'))
    );
  }

  function detachDocsIframeListeners() {
    if (!docsIframeDoc || !docsIframeHandlers) return;
    try {
      docsIframeDoc.removeEventListener('input', docsIframeHandlers.input, true);
      docsIframeDoc.removeEventListener('paste', docsIframeHandlers.paste, true);
      docsIframeDoc.removeEventListener('keydown', docsIframeHandlers.keydown, true);
      docsIframeDoc.removeEventListener('beforeinput', docsIframeHandlers.beforeinput, true);
      docsIframeDoc.removeEventListener('compositionend', docsIframeHandlers.compositionend, true);
    } catch {
      // ignore detach failures
    }
    docsIframeDoc = null;
    docsIframeHandlers = null;
  }

  function attachDocsIframeListeners() {
    const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    const iframeDoc = iframe?.contentDocument;
    if (!iframeDoc) return;
    if (iframeDoc === docsIframeDoc) return;

    detachDocsIframeListeners();

    const markInteraction = (text) => {
      hadRecentDocsInput = true;
      lastDocsInteractionAt = Date.now();
      pushTypingDelta(docsTypingBuffer, text);
      docsInputDebouncedCapture?.();
    };

    const keydownHandler = (e) => {
      const nonTextKeys = new Set([
        'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Escape',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'PageUp', 'PageDown', 'Home', 'End'
      ]);
      if (nonTextKeys.has(e.key) || /^F\d{1,2}$/.test(e.key)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      markInteraction(e.key.length === 1 ? e.key : '');
    };

    docsIframeHandlers = {
      input: (e) => markInteraction(e.data),
      paste: (e) => markInteraction(e.clipboardData?.getData('text/plain')),
      keydown: keydownHandler,
      beforeinput: (e) => {
        const inputType = e.inputType || '';
        if (!inputType.startsWith('insert') && !inputType.startsWith('delete')) return;
        markInteraction(e.data);
      },
      compositionend: (e) => markInteraction(e.data),
    };

    iframeDoc.addEventListener('input', docsIframeHandlers.input, true);
    iframeDoc.addEventListener('paste', docsIframeHandlers.paste, true);
    iframeDoc.addEventListener('keydown', docsIframeHandlers.keydown, true);
    iframeDoc.addEventListener('beforeinput', docsIframeHandlers.beforeinput, true);
    iframeDoc.addEventListener('compositionend', docsIframeHandlers.compositionend, true);
    docsIframeDoc = iframeDoc;
  }

  function isElementInSheetsEditor(target) {
    if (!(target instanceof Element)) return false;
    return !!(
      target.closest('.cell-input') ||
      target.closest('.docs-formula-bar-input') ||
      target.closest('.waffle-grid-container')
    );
  }

  function isElementInSlidesEditor(target) {
    if (!(target instanceof Element)) return false;
    return !!(
      target.closest('.punch-viewer-content') ||
      target.closest('.punch-viewer-svgpage') ||
      target.getAttribute('contenteditable') === 'true'
    );
  }

  function pushTypingDelta(buffer, text, maxItems = 40) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) return;
    buffer.push({
      text: value.length > 400 ? value.slice(0, 400) : value,
      at: Date.now()
    });
    if (buffer.length > maxItems) {
      buffer.splice(0, buffer.length - maxItems);
    }
  }

  // ============================================================================
  // Google Docs 캡처 (API 기반)
  // ============================================================================

  let docsObserver = null;
  let docsIntervalId = null;
  let lastDocsCapture = 0;
  let lastViewingDocId = null;
  let hadRecentDocsInput = false;
  let lastDocsInteractionAt = 0;
  let docsInputDebouncedCapture = null;
  let docsKeydownListener = null;
  let docsBeforeInputListener = null;
  let docsCompositionEndListener = null;
  let docsIframeBindInterval = null;
  let docsIframeDoc = null;
  let docsIframeHandlers = null;
  let docsTypingBuffer = [];
  const DOCS_CAPTURE_INTERVAL = 30000; // 30초
  const INPUT_CAPTURE_DEBOUNCE = 3000; // input burst 후 3초 뒤 강제 캡처

  /**
   * Google Docs 활동 캡처 (API 사용)
   */
  async function captureGoogleDocsActivity(force = false) {
    if (isStopped) return;
    try {
      // Context 유효성 검사 (확장프로그램 리로드 대응)
      if (!isContextValid()) {
        cleanup();
        return;
      }

      // 탭이 숨겨져 있으면 수집 스킵
      if (document.hidden) return;

      const now = Date.now();
      if (!force && now - lastDocsCapture < DOCS_CAPTURE_INTERVAL) return;

      const documentTitle = document.title.replace(' - Google Docs', '').trim();
      const documentId = extractDocId(window.location.href);

      if (!documentId) return;

      // 편집 중인지 확인 (cursor + document focus + editor active)
      const hasCursor = document.querySelector('.kix-cursor') !== null ||
                       document.querySelector('.docs-text-ui-cursor-blink') !== null;
      const inEditor = document.activeElement?.closest('.kix-appview-editor') !== null ||
                      document.activeElement?.getAttribute('contenteditable') === 'true';
      const hasEditorRoot = document.querySelector('.kix-appview-editor') !== null;
      const cursorEditingHeuristic = hasCursor && hasEditorRoot;
      if (cursorEditingHeuristic) {
        // Docs DOM/iframe differences can hide input events; keep a soft recent-activity signal.
        lastDocsInteractionAt = now;
      }
      const recentlyInteracted = (now - lastDocsInteractionAt) < 10000;
      const isEditing = hadRecentDocsInput || docsTypingBuffer.length > 0 || recentlyInteracted || cursorEditingHeuristic || (hasCursor && inEditor);
      hadRecentDocsInput = false;

      if (!isEditing) {
        // Viewing — skip API call, send lightweight record once per document
        if (lastViewingDocId === documentId) return;
        lastViewingDocId = documentId;

        sendMessageWithRetry({
          action: 'DATA_CAPTURED',
          payload: {
            type: 'DAILY_SCRUM_CAPTURE',
            source: 'google-docs',
            data: {
              documentTitle: documentTitle,
              documentId: documentId,
              activityType: 'viewing',
              timestamp: Date.now(),
              url: window.location.href
            }
          }
        }).catch(() => {});
        return;
      }

      // Editing — reset viewing tracker so next view is captured
      lastViewingDocId = null;

      if (docsTypingBuffer.length > 0) {
        const deltas = docsTypingBuffer.slice();
        docsTypingBuffer = [];
        lastDocsCapture = Date.now();
        sendMessageWithRetry({
          action: 'DATA_CAPTURED',
          payload: {
            type: 'DAILY_SCRUM_CAPTURE',
            source: 'google-docs',
            data: {
              documentTitle: documentTitle,
              documentId: documentId,
              activityType: 'typing',
              typedDeltas: deltas,
              timestamp: Date.now(),
              url: window.location.href
            }
          }
        }).catch(() => {});
        return;
      }

      // Background에 Google API 요청
      const response = await sendMessageWithRetry({
        action: 'GOOGLE_API_REQUEST',
        payload: {
          apiType: 'docs',
          documentId: documentId
        }
      });

      if (response && response.success) {
        // Fix 4: update timestamp after successful API call (not before)
        lastDocsCapture = Date.now();
        // API에서 가져온 텍스트로 데이터 캡처
        sendMessageWithRetry({
          action: 'DATA_CAPTURED',
          payload: {
            type: 'DAILY_SCRUM_CAPTURE',
            source: 'google-docs',
            data: {
              documentTitle: documentTitle,
              documentId: documentId,
              activityType: 'editing',
              visibleContent: response.data.text?.substring(0, 5000) || null,
              timestamp: Date.now(),
              url: window.location.href
            }
          }
        }).catch(() => {
        });
      } else {
        // API failure — don't update timestamp, allow retry on next interval
      }
    } catch (error) {
    }
  }

  /**
   * Google Docs observer 설정
   */
  function setupDocsCapture() {
    docsInputDebouncedCapture = debounce(() => {
      captureGoogleDocsActivity(true).catch(() => {});
    }, INPUT_CAPTURE_DEBOUNCE);

    // 문서 본문/편집 영역 input만 즉시 캡처 트리거 (노이즈 방지)
    document.addEventListener('input', (e) => {
      if (!isElementInDocsEditor(e.target)) return;
      hadRecentDocsInput = true;
      lastDocsInteractionAt = Date.now();
      pushTypingDelta(docsTypingBuffer, e.data);
      docsInputDebouncedCapture?.();
    }, true);
    // 복붙(키보드/컨텍스트 메뉴)도 편집 이벤트로 간주
    document.addEventListener('paste', (e) => {
      if (!isElementInDocsEditor(e.target)) return;
      hadRecentDocsInput = true;
      lastDocsInteractionAt = Date.now();
      pushTypingDelta(docsTypingBuffer, e.clipboardData?.getData('text/plain'));
      docsInputDebouncedCapture?.();
    }, true);

    // Docs는 실제 입력 타겟이 selector 밖에 위치하는 경우가 있어 keydown 보조 감지 필요
    docsKeydownListener = (e) => {
      const nonTextKeys = new Set([
        'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Escape',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'PageUp', 'PageDown', 'Home', 'End'
      ]);
      if (nonTextKeys.has(e.key) || /^F\d{1,2}$/.test(e.key)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!document.querySelector('.kix-appview-editor')) return;

      hadRecentDocsInput = true;
      lastDocsInteractionAt = Date.now();
      if (e.key.length === 1) {
        pushTypingDelta(docsTypingBuffer, e.key);
      }
      docsInputDebouncedCapture?.();
    };
    document.addEventListener('keydown', docsKeydownListener, true);

    // IME(한글 조합 입력) 보조 감지
    docsCompositionEndListener = (e) => {
      if (!isElementInDocsEditor(e.target)) return;
      hadRecentDocsInput = true;
      lastDocsInteractionAt = Date.now();
      pushTypingDelta(docsTypingBuffer, e.data);
      docsInputDebouncedCapture?.();
    };
    document.addEventListener('compositionend', docsCompositionEndListener, true);

    // beforeinput은 Docs 내부 편집 이벤트를 가장 안정적으로 감지
    docsBeforeInputListener = (e) => {
      if (!isElementInDocsEditor(e.target)) return;
      const inputType = e.inputType || '';
      if (!inputType.startsWith('insert') && !inputType.startsWith('delete')) return;
      hadRecentDocsInput = true;
      lastDocsInteractionAt = Date.now();
      pushTypingDelta(docsTypingBuffer, e.data);
      docsInputDebouncedCapture?.();
    };
    document.addEventListener('beforeinput', docsBeforeInputListener, true);

    // Docs 입력 이벤트는 texteventtarget iframe 안에서 발생할 수 있음
    attachDocsIframeListeners();
    docsIframeBindInterval = setInterval(attachDocsIframeListeners, 2000);

    // 주기적 캡처 (30초마다)
    docsIntervalId = setInterval(captureGoogleDocsActivity, DOCS_CAPTURE_INTERVAL);

    // 초기 캡처
    setTimeout(captureGoogleDocsActivity, 3000);

  }

  // ============================================================================
  // Google Sheets 캡처 (API 기반)
  // ============================================================================

  let sheetsObserver = null;
  let sheetsIntervalId = null;
  let lastSheetsCapture = 0;
  let lastViewingSheetsId = null;
  let hadRecentSheetsInput = false;
  let sheetsInputDebouncedCapture = null;
  let sheetsKeydownListener = null;
  let sheetsTypingBuffer = [];
  const SHEETS_CAPTURE_INTERVAL = 30000; // 30초

  /**
   * Google Sheets 활동 캡처 (API 사용)
   */
  async function captureGoogleSheetsActivity(force = false) {
    if (isStopped) return;
    try {
      // Context 유효성 검사 (확장프로그램 리로드 대응)
      if (!isContextValid()) {
        cleanup();
        return;
      }

      // 탭이 숨겨져 있으면 수집 스킵
      if (document.hidden) return;

      const now = Date.now();
      if (!force && now - lastSheetsCapture < SHEETS_CAPTURE_INTERVAL) return;

      const documentTitle = document.title.replace(' - Google Sheets', '').trim();
      const documentId = extractDocId(window.location.href);

      if (!documentId) return;

      // 활성 시트 이름 (DOM에서)
      const activeSheetTab = document.querySelector('.docs-sheet-active-tab') ||
                            document.querySelector('[aria-selected="true"][role="tab"]');
      const activeSheet = activeSheetTab?.textContent?.trim() || 'Sheet1';

      // 편집 중인지 확인 (formula bar에 focus가 있거나, cell input이 활성화된 경우)
      const formulaBar = document.querySelector('.docs-formula-bar-input');
      const cellInput = document.querySelector('.cell-input');
      const isEditing = (formulaBar !== null && formulaBar.contains(document.activeElement)) ||
                       (cellInput !== null && (
                         cellInput.classList.contains('cell-input-active') ||
                         cellInput.contains(document.activeElement)
                       )) || hadRecentSheetsInput;
      hadRecentSheetsInput = false;

      if (!isEditing) {
        // Viewing — skip API call, send lightweight record once per document
        if (lastViewingSheetsId === documentId) return;
        lastViewingSheetsId = documentId;

        sendMessageWithRetry({
          action: 'DATA_CAPTURED',
          payload: {
            type: 'DAILY_SCRUM_CAPTURE',
            source: 'google-sheets',
            data: {
              documentTitle: documentTitle,
              documentId: documentId,
              activeSheet: activeSheet,
              activityType: 'viewing',
              timestamp: Date.now(),
              url: window.location.href
            }
          }
        }).catch(() => {});
        return;
      }

      // Editing — reset viewing tracker
      lastViewingSheetsId = null;

      if (sheetsTypingBuffer.length > 0) {
        const deltas = sheetsTypingBuffer.slice();
        sheetsTypingBuffer = [];
        lastSheetsCapture = Date.now();
        sendMessageWithRetry({
          action: 'DATA_CAPTURED',
          payload: {
            type: 'DAILY_SCRUM_CAPTURE',
            source: 'google-sheets',
            data: {
              documentTitle: documentTitle,
              documentId: documentId,
              activeSheet: activeSheet,
              activityType: 'typing',
              typedDeltas: deltas,
              timestamp: Date.now(),
              url: window.location.href
            }
          }
        }).catch(() => {});
        return;
      }

      // Background에 Google API 요청
      const response = await sendMessageWithRetry({
        action: 'GOOGLE_API_REQUEST',
        payload: {
          apiType: 'sheets',
          documentId: documentId
        }
      });

      if (response && response.success) {
        // Fix 4: update timestamp after successful API call (not before)
        lastSheetsCapture = Date.now();
        sendMessageWithRetry({
          action: 'DATA_CAPTURED',
          payload: {
            type: 'DAILY_SCRUM_CAPTURE',
            source: 'google-sheets',
            data: {
              documentTitle: response.data.title || documentTitle,
              documentId: documentId,
              sheets: response.data.sheets,
              activeSheet: activeSheet,
              activityType: 'editing',
              timestamp: Date.now(),
              url: window.location.href
            }
          }
        }).catch(() => {
        });
      } else {
        // API failure — don't update timestamp, allow retry on next interval
      }
    } catch (error) {
    }
  }

  /**
   * Google Sheets observer 설정
   */
  function setupSheetsCapture() {
    sheetsInputDebouncedCapture = debounce(() => {
      captureGoogleSheetsActivity(true).catch(() => {});
    }, INPUT_CAPTURE_DEBOUNCE);

    // 시트 본문/수식 입력창 input만 즉시 캡처 트리거 (노이즈 방지)
    document.addEventListener('input', (e) => {
      if (!isElementInSheetsEditor(e.target)) return;
      hadRecentSheetsInput = true;
      pushTypingDelta(sheetsTypingBuffer, e.data);
      sheetsInputDebouncedCapture?.();
    }, true);
    document.addEventListener('paste', (e) => {
      if (!isElementInSheetsEditor(e.target)) return;
      hadRecentSheetsInput = true;
      pushTypingDelta(sheetsTypingBuffer, e.clipboardData?.getData('text/plain'));
      sheetsInputDebouncedCapture?.();
    }, true);

    // Sheets는 실제 입력 타겟이 예상 selector 밖인 경우가 있어 keydown 보조 감지
    sheetsKeydownListener = (e) => {
      const isTypingKey = e.key.length === 1 || ['Backspace', 'Delete', 'Enter', 'Tab'].includes(e.key);
      if (!isTypingKey) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!document.hasFocus()) return;
      if (!document.querySelector('.waffle-grid-container')) return;

      hadRecentSheetsInput = true;
      if (e.key.length === 1) {
        pushTypingDelta(sheetsTypingBuffer, e.key);
      }
      sheetsInputDebouncedCapture?.();
    };
    document.addEventListener('keydown', sheetsKeydownListener, true);

    // 주기적 캡처 (30초마다)
    sheetsIntervalId = setInterval(captureGoogleSheetsActivity, SHEETS_CAPTURE_INTERVAL);

    // 초기 캡처
    setTimeout(captureGoogleSheetsActivity, 3000);

  }

  // ============================================================================
  // Google Slides 캡처 (API 기반)
  // ============================================================================

  let slidesObserver = null;
  let slidesIntervalId = null;
  let lastSlidesCapture = 0;
  let lastViewingSlidesId = null;
  let hadRecentSlidesInput = false;
  let slidesInputDebouncedCapture = null;
  const SLIDES_CAPTURE_INTERVAL = 30000; // 30초

  /**
   * Google Slides 활동 캡처 (API 사용)
   */
  async function captureGoogleSlidesActivity(force = false) {
    if (isStopped) return;
    try {
      // Context 유효성 검사 (확장프로그램 리로드 대응)
      if (!isContextValid()) {
        cleanup();
        return;
      }

      // 탭이 숨겨져 있으면 수집 스킵
      if (document.hidden) return;

      const now = Date.now();
      if (!force && now - lastSlidesCapture < SLIDES_CAPTURE_INTERVAL) return;

      const documentTitle = document.title.replace(' - Google Slides', '').trim();
      const documentId = extractDocId(window.location.href);

      if (!documentId) return;

      // 발표자 노트 (DOM에서)
      const speakerNotesElement = document.querySelector('.punch-viewer-speakernotes-text') ||
                                  document.querySelector('[aria-label*="Speaker notes"]');
      const speakerNotes = speakerNotesElement?.textContent?.trim();

      // 현재 슬라이드 번호
      const slideNumberElement = document.querySelector('.punch-filmstrip-selected') ||
                                 document.querySelector('[aria-selected="true"][role="option"]');
      const slideNumber = slideNumberElement?.getAttribute('aria-posinset') || 'unknown';

      // 편집 모드 확인 (active text cursor or shape selection with document focus)
      const isPresenting = document.querySelector('.punch-viewer-container.punch-present-active') !== null;
      const hasTextCursor = document.querySelector('.cursor-caret') !== null ||
                           document.querySelector('.punch-viewer-svgpage-textbox-selected') !== null;
      const hasActiveShape = document.querySelector('.punch-selection-border') !== null;
      const isEditing = (!isPresenting && document.hasFocus() && (hasTextCursor || hasActiveShape)) || hadRecentSlidesInput;
      hadRecentSlidesInput = false;

      if (!isEditing) {
        // Presenting/viewing — skip API call, send lightweight record once per document
        if (lastViewingSlidesId === documentId) return;
        lastViewingSlidesId = documentId;

        sendMessageWithRetry({
          action: 'DATA_CAPTURED',
          payload: {
            type: 'DAILY_SCRUM_CAPTURE',
            source: 'google-slides',
            data: {
              documentTitle: documentTitle,
              documentId: documentId,
              currentSlide: slideNumber,
              activityType: 'viewing',
              timestamp: Date.now(),
              url: window.location.href
            }
          }
        }).catch(() => {});
        return;
      }

      // Editing — reset viewing tracker
      lastViewingSlidesId = null;

      // Background에 Google API 요청
      const response = await sendMessageWithRetry({
        action: 'GOOGLE_API_REQUEST',
        payload: {
          apiType: 'slides',
          documentId: documentId
        }
      });

      if (response && response.success) {
        // Fix 4: update timestamp after successful API call (not before)
        lastSlidesCapture = Date.now();
        sendMessageWithRetry({
          action: 'DATA_CAPTURED',
          payload: {
            type: 'DAILY_SCRUM_CAPTURE',
            source: 'google-slides',
            data: {
              documentTitle: documentTitle,
              documentId: documentId,
              visibleContent: response.data.fullText || null,
              slideCount: response.data.slides?.length || 'unknown',
              slides: response.data.slides,
              speakerNotes: speakerNotes,
              currentSlide: slideNumber,
              activityType: 'editing',
              timestamp: Date.now(),
              url: window.location.href
            }
          }
        }).catch(() => {
        });
      } else {
        // API failure — don't update timestamp, allow retry on next interval
      }
    } catch (error) {
    }
  }

  /**
   * Google Slides observer 설정
   */
  function setupSlidesCapture() {
    slidesInputDebouncedCapture = debounce(() => {
      captureGoogleSlidesActivity(true).catch(() => {});
    }, INPUT_CAPTURE_DEBOUNCE);

    // 슬라이드 편집 영역 input만 즉시 캡처 트리거 (노이즈 방지)
    document.addEventListener('input', (e) => {
      if (!isElementInSlidesEditor(e.target)) return;
      hadRecentSlidesInput = true;
      slidesInputDebouncedCapture?.();
    }, true);
    document.addEventListener('paste', (e) => {
      if (!isElementInSlidesEditor(e.target)) return;
      hadRecentSlidesInput = true;
      slidesInputDebouncedCapture?.();
    }, true);

    // 주기적 캡처 (30초마다)
    slidesIntervalId = setInterval(captureGoogleSlidesActivity, SLIDES_CAPTURE_INTERVAL);

    // 초기 캡처
    setTimeout(captureGoogleSlidesActivity, 3000);

  }

  // ============================================================================
  // Google Drive 캡처
  // ============================================================================

  let driveObserver = null;
  const processedDriveActions = new Set();

  /**
   * Google Drive 활동 캡처
   */
  function setupDriveCapture() {
    driveObserver = new MutationObserver((mutations) => {
      try {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;

            // 파일 업로드 감지
            const uploadElements = node.querySelectorAll
              ? node.querySelectorAll('[aria-label*="Upload"]')
              : [];

            if (uploadElements.length > 0 || (node.matches && node.matches('[aria-label*="Upload"]'))) {
              captureDriveActivity('file_upload');
            }

            // 폴더 생성 감지
            const folderElements = node.querySelectorAll
              ? node.querySelectorAll('[aria-label*="New folder"]')
              : [];

            if (folderElements.length > 0 || (node.matches && node.matches('[aria-label*="New folder"]'))) {
              captureDriveActivity('folder_created');
            }
          }
        }
      } catch (error) {
      }
    });

    if (document.body) {
      driveObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }

  }

  /**
   * Drive 활동 전송
   * @param {string} activityType - 활동 타입
   */
  function captureDriveActivity(activityType) {
    try {
      if (processedDriveActions.has(activityType)) return;

      sendMessageWithRetry({
        action: 'DATA_CAPTURED',
        payload: {
          type: 'DAILY_SCRUM_CAPTURE',
          source: 'google-drive',
          data: {
            activityType: activityType,
            timestamp: Date.now(),
            url: window.location.href
          }
        }
      }).catch(() => {
      });

      processedDriveActions.add(activityType);

      // 5초 후 재감지 허용
      setTimeout(() => {
        processedDriveActions.delete(activityType);
      }, 5000);
    } catch (error) {
    }
  }

  // ============================================================================
  // Cleanup on Page Unload
  // ============================================================================

  /**
   * 페이지 언로드 시 리소스 정리
   */
  function cleanup() {
    isStopped = true;
    try {
      // 타이머 정리
      if (docsIntervalId) {
        clearInterval(docsIntervalId);
        docsIntervalId = null;
      }
      if (sheetsIntervalId) {
        clearInterval(sheetsIntervalId);
        sheetsIntervalId = null;
      }
      if (slidesIntervalId) {
        clearInterval(slidesIntervalId);
        slidesIntervalId = null;
      }

      // Observer 정리
      if (docsObserver) {
        docsObserver.disconnect();
        docsObserver = null;
      }
      if (sheetsObserver) {
        sheetsObserver.disconnect();
        sheetsObserver = null;
      }
      if (slidesObserver) {
        slidesObserver.disconnect();
        slidesObserver = null;
      }
      if (driveObserver) {
        driveObserver.disconnect();
        driveObserver = null;
      }
      if (docsKeydownListener) {
        document.removeEventListener('keydown', docsKeydownListener, true);
        docsKeydownListener = null;
      }
      if (docsBeforeInputListener) {
        document.removeEventListener('beforeinput', docsBeforeInputListener, true);
        docsBeforeInputListener = null;
      }
      if (docsCompositionEndListener) {
        document.removeEventListener('compositionend', docsCompositionEndListener, true);
        docsCompositionEndListener = null;
      }
      if (docsIframeBindInterval) {
        clearInterval(docsIframeBindInterval);
        docsIframeBindInterval = null;
      }
      detachDocsIframeListeners();
      if (sheetsKeydownListener) {
        document.removeEventListener('keydown', sheetsKeydownListener, true);
        sheetsKeydownListener = null;
      }
      processedDriveActions.clear();
      docsTypingBuffer = [];
      sheetsTypingBuffer = [];
    } catch (error) {
    }
  }

  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);

  // ============================================================================
  // 초기화
  // ============================================================================

  /**
   * 스크립트 초기화
   */
  function init() {
    try {

      const app = detectGoogleApp();

      switch (app) {
        case 'docs':
          setupDocsCapture();
          break;
        case 'sheets':
          setupSheetsCapture();
          break;
        case 'slides':
          setupSlidesCapture();
          break;
        case 'drive':
          setupDriveCapture();
          break;
        default:
          return;
      }

    } catch (error) {
    }
  }

  // DOM이 준비되면 초기화
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /**
   * 즉시 캡처 트리거 (FLUSH_NOW 대응)
   * interval guard를 우회하여 현재 앱의 capture 함수를 즉시 호출
   */
  function triggerImmediateCapture() {
    if (isStopped) return;
    const app = detectGoogleApp();
    switch (app) {
      case 'docs':
        lastDocsCapture = 0;
        captureGoogleDocsActivity();
        break;
      case 'sheets':
        lastSheetsCapture = 0;
        captureGoogleSheetsActivity();
        break;
      case 'slides':
        lastSlidesCapture = 0;
        captureGoogleSlidesActivity();
        break;
      // drive는 MutationObserver 기반이므로 즉시 캡처 불필요
    }
  }

  // FLUSH_NOW / CLEANUP_AND_STOP 메시지 리스너
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'FLUSH_NOW') {
        triggerImmediateCapture();
        sendResponse({ success: true });
      } else if (message.action === 'CLEANUP_AND_STOP') {
        cleanup();
        sendResponse({ success: true });
      }
      return true;
    });
  }

  // 전역에 cleanup 함수 노출 (다음 리로드 시 cleanup 가능하도록)
  window[SCRIPT_ID] = { cleanup };

})();
