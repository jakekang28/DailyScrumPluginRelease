/**
 * Web Reference Tracker
 *
 * 업무 관련 웹사이트 방문 기록을 수집합니다.
 * - URL + 제목만 수집 (최소 수집)
 * - 10초 이상 체류한 페이지만 기록
 * - 민감 정보 자동 필터링
 */
(function() {
  'use strict';

  // ============================================================================
  // 전역 인스턴스 관리 (Extension Reload 대응)
  // ============================================================================

  const SCRIPT_ID = '__DAILY_SCRUM_WEB_REFERENCE_TRACKER__';

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

  // ============================================================================
  // 상수
  // ============================================================================

  const MIN_DURATION = 10000; // 최소 체류 시간 (10초)
  const SENSITIVE_PATTERNS = [
    /bank|banking|payment|paypal/i,
    /health|medical|doctor|hospital/i,
    /login|signin|signup|password|auth/i,
    /mail\.google\.com|gmail/i,
    /facebook\.com|instagram\.com|twitter\.com|x\.com/i,
    /\.gov\//i,
    /amazon\.com\/.*cart|checkout/i,
    /shop|store|buy|purchase/i
  ];

  // ============================================================================
  // 상태
  // ============================================================================

  let visitStartTime = null;
  let isPageActive = true;
  let hasSentData = false;

  // ============================================================================
  // 유틸리티 함수
  // ============================================================================

  /**
   * 민감한 URL인지 확인
   */
  function isSensitiveUrl(url) {
    return SENSITIVE_PATTERNS.some(pattern => pattern.test(url));
  }

  /**
   * 사이트 타입 분류
   */
  function classifySite(url, title) {
    const hostname = new URL(url).hostname;

    if (hostname.includes('developer.mozilla.org') ||
        hostname.includes('docs.') ||
        hostname.includes('documentation')) {
      return 'technical-documentation';
    }

    if (hostname.includes('stackoverflow.com') ||
        hostname.includes('stackexchange.com')) {
      return 'code-reference';
    }

    if (hostname.includes('github.com')) {
      return 'code-repository';
    }

    if (hostname.includes('medium.com') ||
        hostname.includes('dev.to') ||
        hostname.includes('blog')) {
      return 'article-blog';
    }

    return 'general-reference';
  }

  /**
   * URL에서 path hash 생성 (citation용)
   */
  function generateUrlHash(url) {
    const urlObj = new URL(url);
    const pathKey = urlObj.hostname + urlObj.pathname;

    // 간단한 해시 생성
    let hash = 0;
    for (let i = 0; i < pathKey.length; i++) {
      const char = pathKey.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36).substring(0, 8);
  }

  /**
   * 페이지 정보 캡처
   */
  function capturePageReference() {
    try {
      // Context 유효성 검사 (확장프로그램 리로드 대응)
      if (!isContextValid()) {
        cleanup();
        return;
      }

      const url = window.location.href;

      // 민감 정보 필터링
      if (isSensitiveUrl(url)) {
        return;
      }

      const title = document.title.trim();
      if (!title) {
        return;
      }

      const visitEndTime = Date.now();
      const duration = visitEndTime - visitStartTime;

      // 최소 체류 시간 체크
      if (duration < MIN_DURATION) {
        return;
      }

      const siteType = classifySite(url, title);
      const urlHash = generateUrlHash(url);

      const payload = {
        type: 'DAILY_SCRUM_CAPTURE',
        source: 'web-reference',
        data: {
          url: url,
          title: title,
          siteType: siteType,
          urlHash: urlHash,
          visitedAt: visitStartTime,
          duration: Math.round(duration / 1000), // 초 단위
          timestamp: visitEndTime
        }
      };

      // Background로 전송
      sendMessageWithRetry({
        action: 'DATA_CAPTURED',
        payload: payload
      }).catch(() => {
        // Service Worker 비활성화 시 무시
      });

      hasSentData = true;
    } catch (error) {
      // 무시
    }
  }

  // ============================================================================
  // 이벤트 핸들러
  // ============================================================================

  /**
   * 페이지 가시성 변경
   */
  function handleVisibilityChange() {
    if (document.hidden) {
      // 페이지를 떠날 때
      isPageActive = false;
      if (!hasSentData && visitStartTime) {
        capturePageReference();
      }
    } else {
      // 페이지로 돌아올 때
      isPageActive = true;
      visitStartTime = Date.now();
      hasSentData = false;
    }
  }

  /**
   * 페이지 언로드
   */
  function handleBeforeUnload() {
    if (!hasSentData && visitStartTime) {
      capturePageReference();
    }
  }

  /**
   * 리소스 정리
   */
  function cleanup() {
    try {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
      visitStartTime = null;
      hasSentData = true; // 더 이상 전송하지 않도록
    } catch (error) {
      // 무시
    }
  }

  // ============================================================================
  // 초기화
  // ============================================================================

  function init() {
    try {
      // 민감 URL 체크
      if (isSensitiveUrl(window.location.href)) {
        return;
      }

      // 방문 시작 시간 기록
      visitStartTime = Date.now();

      // 이벤트 리스너 등록
      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('beforeunload', handleBeforeUnload);
      window.addEventListener('pagehide', handleBeforeUnload);

    } catch (error) {
      // 무시
    }
  }

  // DOM Ready 시 초기화
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // CLEANUP_AND_STOP 메시지 리스너
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'CLEANUP_AND_STOP') {
        cleanup();
        sendResponse({ success: true });
      }
      return true;
    });
  }

  // 전역에 cleanup 함수 노출 (다음 리로드 시 cleanup 가능하도록)
  window[SCRIPT_ID] = { cleanup };

})();
