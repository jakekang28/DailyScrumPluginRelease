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

  // ============================================================================
  // Google Docs 캡처 (API 기반)
  // ============================================================================

  let docsObserver = null;
  let docsIntervalId = null;
  let lastDocsCapture = 0;
  const DOCS_CAPTURE_INTERVAL = 30000; // 30초

  /**
   * Google Docs 활동 캡처 (API 사용)
   */
  async function captureGoogleDocsActivity() {
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
      if (now - lastDocsCapture < DOCS_CAPTURE_INTERVAL) return;

      const documentTitle = document.title.replace(' - Google Docs', '').trim();
      const documentId = extractDocId(window.location.href);

      if (!documentId) {
        return;
      }

      // 편집 중인지 확인 (cursor 존재 여부)
      const isEditing = document.querySelector('.kix-cursor') !== null ||
                       document.querySelector('.docs-text-ui-cursor-blink') !== null;

      // Background에 Google API 요청
      const response = await sendMessageWithRetry({
        action: 'GOOGLE_API_REQUEST',
        payload: {
          apiType: 'docs',
          documentId: documentId
        }
      });

      if (response && response.success) {
        // API에서 가져온 텍스트로 데이터 캡처
        sendMessageWithRetry({
          action: 'DATA_CAPTURED',
          payload: {
            type: 'DAILY_SCRUM_CAPTURE',
            source: 'google-docs',
            data: {
              documentTitle: documentTitle,
              documentId: documentId,
              activityType: isEditing ? 'editing' : 'viewing',
              visibleContent: response.data.text?.substring(0, 5000) || null,
              timestamp: Date.now(),
              url: window.location.href
            }
          }
        }).catch(() => {
        });
      } else {
      }

      lastDocsCapture = now;
    } catch (error) {
    }
  }

  /**
   * Google Docs observer 설정
   */
  function setupDocsCapture() {
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
  const SHEETS_CAPTURE_INTERVAL = 30000; // 30초

  /**
   * Google Sheets 활동 캡처 (API 사용)
   */
  async function captureGoogleSheetsActivity() {
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
      if (now - lastSheetsCapture < SHEETS_CAPTURE_INTERVAL) return;

      const documentTitle = document.title.replace(' - Google Sheets', '').trim();
      const documentId = extractDocId(window.location.href);

      if (!documentId) {
        return;
      }

      // 활성 시트 이름 (DOM에서)
      const activeSheetTab = document.querySelector('.docs-sheet-active-tab') ||
                            document.querySelector('[aria-selected="true"][role="tab"]');
      const activeSheet = activeSheetTab?.textContent?.trim() || 'Sheet1';

      // 편집 중인지 확인
      const isEditing = document.querySelector('.docs-formula-bar-input') !== null ||
                       document.querySelector('[aria-label*="Formula bar"]') !== null;

      // Background에 Google API 요청
      const response = await sendMessageWithRetry({
        action: 'GOOGLE_API_REQUEST',
        payload: {
          apiType: 'sheets',
          documentId: documentId
        }
      });

      if (response && response.success) {
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
              activityType: isEditing ? 'editing' : 'viewing',
              timestamp: Date.now(),
              url: window.location.href
            }
          }
        }).catch(() => {
        });
      } else {
      }

      lastSheetsCapture = now;
    } catch (error) {
    }
  }

  /**
   * Google Sheets observer 설정
   */
  function setupSheetsCapture() {
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
  const SLIDES_CAPTURE_INTERVAL = 30000; // 30초

  /**
   * Google Slides 활동 캡처 (API 사용)
   */
  async function captureGoogleSlidesActivity() {
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
      if (now - lastSlidesCapture < SLIDES_CAPTURE_INTERVAL) return;

      const documentTitle = document.title.replace(' - Google Slides', '').trim();
      const documentId = extractDocId(window.location.href);

      if (!documentId) {
        return;
      }

      // 발표자 노트 (DOM에서)
      const speakerNotesElement = document.querySelector('.punch-viewer-speakernotes-text') ||
                                  document.querySelector('[aria-label*="Speaker notes"]');
      const speakerNotes = speakerNotesElement?.textContent?.trim();

      // 현재 슬라이드 번호
      const slideNumberElement = document.querySelector('.punch-filmstrip-selected') ||
                                 document.querySelector('[aria-selected="true"][role="option"]');
      const slideNumber = slideNumberElement?.getAttribute('aria-posinset') || 'unknown';

      // 편집 모드 확인
      const isEditing = document.querySelector('.punch-viewer-container.punch-present-active') === null;

      // Background에 Google API 요청
      const response = await sendMessageWithRetry({
        action: 'GOOGLE_API_REQUEST',
        payload: {
          apiType: 'slides',
          documentId: documentId
        }
      });

      if (response && response.success) {
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
              activityType: isEditing ? 'editing' : 'presenting',
              timestamp: Date.now(),
              url: window.location.href
            }
          }
        }).catch(() => {
        });
      } else {
      }

      lastSlidesCapture = now;
    } catch (error) {
    }
  }

  /**
   * Google Slides observer 설정
   */
  function setupSlidesCapture() {
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
      processedDriveActions.clear();
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
          console.warn('[Daily Scrum] Unknown Google Workspace app');
          return;
      }

    } catch (error) {
      console.error('[Daily Scrum] Initialization error:', error);
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
