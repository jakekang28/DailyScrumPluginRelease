/**
 * Collaboration Tools Capture Script
 *
 * Notion과 Slack에서 협업 활동을 수집합니다.
 * - Notion: 블록 변경 감지 (debounced)
 * - Slack: 메시지 감지
 *
 * @see research.md 3.2절
 */
(function() {
  'use strict';

  // ============================================================================
  // 전역 인스턴스 관리 (Extension Reload 대응)
  // ============================================================================

  const SCRIPT_ID = '__DAILY_SCRUM_COLLAB_CAPTURE__';

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

  /**
   * 현재 플랫폼 감지
   * @returns {string} 플랫폼 이름
   */
  function detectCurrentPlatform() {
    const hostname = window.location.hostname.toLowerCase();

    if (hostname.includes('notion.so')) {
      return 'notion';
    }
    if (hostname.includes('slack.com')) {
      return 'slack';
    }

    return 'unknown';
  }

  // ============================================================================
  // Notion 블록 캡처
  // ============================================================================

  let notionObserver = null;
  const processedBlocks = new Set();
  let notionBuffer = [];

  /**
   * Notion 블록 타입 감지
   * @param {Element} block - 블록 요소
   * @returns {string} 블록 타입
   */
  function detectBlockType(block) {
    try {
      // data-content-type 속성 확인
      const contentType = block.getAttribute('data-content-type');
      if (contentType) return contentType;

      // 클래스명으로 타입 추론
      const classList = block.className || '';
      if (classList.includes('heading')) return 'heading';
      if (classList.includes('bulleted')) return 'bulleted_list';
      if (classList.includes('numbered')) return 'numbered_list';
      if (classList.includes('code')) return 'code';
      if (classList.includes('quote')) return 'quote';
      if (classList.includes('toggle')) return 'toggle';

      return 'paragraph';
    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * Notion 블록 변경 감지
   */
  function setupNotionCapture() {
    notionObserver = new MutationObserver((mutations) => {
      try {
        for (const mutation of mutations) {
          const target = mutation.target;
          if (target.nodeType !== Node.ELEMENT_NODE) continue;

          // [data-block-id] 요소 찾기
          const block = target.closest('[data-block-id]');
          if (!block) continue;

          const blockId = block.getAttribute('data-block-id');
          if (!blockId) continue;

          // 민감한 요소 체크
          if (isSensitiveElement(block)) continue;

          // 이미 처리한 블록인지 확인 (최근 1초 이내)
          const blockKey = `${blockId}-${Date.now()}`;
          if (processedBlocks.has(blockId)) continue;

          const content = block.textContent?.trim();
          if (!content) continue;

          // 버퍼에 추가
          notionBuffer.push({
            blockId: blockId,
            content: content,
            type: detectBlockType(block),
            timestamp: Date.now()
          });

          processedBlocks.add(blockId);

          // 1초 후 처리된 블록 ID 제거 (재편집 감지 위해)
          setTimeout(() => {
            processedBlocks.delete(blockId);
          }, 1000);

          // Debounced 전송
          debouncedSendNotionData();
        }
      } catch (error) {
      }
    });

    // Observer 시작
    if (document.body) {
      notionObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }
  }

  /**
   * Notion 버퍼 즉시 전송
   */
  function flushNotionBuffer() {
    if (isStopped) return;
    try {
      if (!isContextValid()) {
        cleanup();
        return;
      }

      if (notionBuffer.length === 0) return;

      sendMessageWithRetry({
        action: 'DATA_CAPTURED',
        payload: {
          type: 'DAILY_SCRUM_CAPTURE',
          source: 'notion',
          data: {
            blocks: [...notionBuffer],
            url: window.location.href,
            pageTitle: document.title,
            timestamp: Date.now()
          }
        }
      }).catch(() => {
      });

      // 버퍼 초기화
      notionBuffer = [];
    } catch (error) {
    }
  }

  /**
   * Notion 데이터 전송 (Debounced)
   */
  const debouncedSendNotionData = debounce(() => {
    // 탭이 숨겨져 있으면 수집 스킵
    if (document.hidden) return;
    flushNotionBuffer();
  }, 2000); // 2초 debounce

  // ============================================================================
  // Slack 메시지 캡처
  // ============================================================================

  let slackObserver = null;
  const processedMessages = new Set();

  /**
   * Slack 메시지 감지
   */
  function setupSlackCapture() {
    slackObserver = new MutationObserver((mutations) => {
      try {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;

            // [data-qa="message_container"] 찾기
            const messages = node.querySelectorAll
              ? node.querySelectorAll('[data-qa="message_container"]')
              : [];

            // 노드 자체가 메시지 컨테이너인 경우
            if (node.matches && node.matches('[data-qa="message_container"]')) {
              extractSlackMessage(node);
            }

            // 하위 메시지들 처리
            messages.forEach(msg => extractSlackMessage(msg));
          }
        }
      } catch (error) {
      }
    });

    // Observer 시작
    if (document.body) {
      slackObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
  }

  /**
   * Slack 메시지 추출
   * @param {Element} messageContainer - 메시지 컨테이너 요소
   */
  function extractSlackMessage(messageContainer) {
    try {
      // Context 유효성 검사 (확장프로그램 리로드 대응)
      if (!isContextValid()) {
        cleanup();
        return;
      }

      // 탭이 숨겨져 있으면 수집 스킵
      if (document.hidden) return;

      // 민감한 요소 체크
      if (isSensitiveElement(messageContainer)) return;

      // 메시지 ID 생성 (중복 방지)
      const messageId = messageContainer.getAttribute('data-ts') ||
                        messageContainer.getAttribute('id') ||
                        simpleHash(messageContainer.textContent || '');

      if (processedMessages.has(messageId)) return;

      // 발신자
      const sender = messageContainer.querySelector('[data-qa="message_sender"]')?.textContent?.trim();

      // 메시지 내용
      const contentElement = messageContainer.querySelector('[class*="message_body"]') ||
                            messageContainer.querySelector('[data-qa="message-text"]');
      const content = contentElement?.textContent?.trim();

      if (!content) return;

      // 채널명
      const channelElement = document.querySelector('[data-qa="channel_name"]') ||
                            document.querySelector('[class*="channel_name"]');
      const channel = channelElement?.textContent?.trim();

      // 타임스탬프
      const timestampElement = messageContainer.querySelector('[data-qa="message_timestamp"]') ||
                              messageContainer.querySelector('time');
      const messageTimestamp = timestampElement?.getAttribute('datetime') ||
                              timestampElement?.textContent;

      // 전송
      sendMessageWithRetry({
        action: 'DATA_CAPTURED',
        payload: {
          type: 'DAILY_SCRUM_CAPTURE',
          source: 'slack',
          data: {
            sender: sender || 'unknown',
            content: content,
            channel: channel || 'unknown',
            messageTimestamp: messageTimestamp,
            capturedAt: Date.now(),
            url: window.location.href
          }
        }
      }).catch(() => {
      });

      processedMessages.add(messageId);

      // 메모리 관리: 1000개 초과 시 오래된 것부터 삭제
      if (processedMessages.size > 1000) {
        const iterator = processedMessages.values();
        for (let i = 0; i < 100; i++) {
          processedMessages.delete(iterator.next().value);
        }
      }
    } catch (error) {
    }
  }

  /**
   * 간단한 문자열 해시
   * @param {string} str - 해시할 문자열
   * @returns {string} 해시값
   */
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
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
      if (notionObserver) {
        notionObserver.disconnect();
        notionObserver = null;
      }
      if (slackObserver) {
        slackObserver.disconnect();
        slackObserver = null;
      }
      processedBlocks.clear();
      processedMessages.clear();
      notionBuffer = [];
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

      const platform = detectCurrentPlatform();

      if (platform === 'notion') {
        setupNotionCapture();
      } else if (platform === 'slack') {
        setupSlackCapture();
      } else {
        console.warn('[Daily Scrum] Unknown collaboration platform');
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

  // FLUSH_NOW / CLEANUP_AND_STOP 메시지 리스너
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'FLUSH_NOW') {
        flushNotionBuffer();
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
