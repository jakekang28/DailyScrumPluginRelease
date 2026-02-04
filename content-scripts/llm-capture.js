/**
 * LLM Capture Script (DOM-based)
 *
 * ChatGPT, Claude, Gemini에서 대화 내용을 수집합니다.
 * MutationObserver로 응답 완료 감지 후 DOM에서 텍스트 추출
 *
 * @see research.md 3.1절
 */
(function() {
  'use strict';

  // ============================================================================
  // 플랫폼별 셀렉터 설정
  // ============================================================================

  const CONFIG = {
    GEMINI: {
      sendBtn: 'button[aria-label*="보내기"], button[aria-label*="Send"]',
      stopBtn: 'button[aria-label*="중지"], button[aria-label*="Stop"]',
      query: '.user-prompt, .query-text, div[class*="user-message"]',
      answer: '.markdown-main-panel, .markdown, .model-response-text'
    },
    GPT: {
      sendBtn: 'button[data-testid="send-button"]',
      stopBtn: 'button[data-testid="stop-button"]',
      query: '[data-message-author-role="user"]',
      answer: '[data-message-author-role="assistant"]'
    },
    CLAUDE: {
      sendBtn: 'button[aria-label="메시지 보내기"], button[aria-label*="Send"]',
      // 실제 DOM 구조 기반 셀렉터
      query: '[data-testid="user-message"]',
      answer: '.font-claude-response-body, p[class*="font-claude"]'
    }
  };

  // ============================================================================
  // 상태 변수
  // ============================================================================

  let platform = null;
  let config = null;
  let domObserver = null;
  let responseDebounceTimer = null;
  let lastCapturedHash = null;
  let isStreaming = false;
  let streamingCheckInterval = null; // 스트리밍 상태 폴링 타이머

  const DEBOUNCE_DELAY = 1500; // 응답 안정화 대기 시간 (ms)
  const STREAMING_CHECK_INTERVAL = 500; // 스트리밍 체크 간격 (ms)

  // ============================================================================
  // 유틸리티 함수
  // ============================================================================

  /**
   * 요소가 DOM에 나타날 때까지 대기
   * @param {string} selector - CSS 셀렉터
   * @param {number} timeout - 최대 대기 시간 (ms)
   * @returns {Promise<Element|null>}
   */
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve) => {
      // 이미 존재하면 즉시 반환
      const existing = document.querySelector(selector);
      if (existing) {
        return resolve(existing);
      }

      // MutationObserver로 요소 출현 감지
      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          resolve(element);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      // 타임아웃
      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  /**
   * 현재 플랫폼 감지
   * @returns {string} 플랫폼 이름 (chatgpt, claude, gemini, unknown)
   */
  function detectPlatform() {
    const hostname = window.location.hostname.toLowerCase();
    const href = window.location.href.toLowerCase();

    // ChatGPT
    if (hostname.includes('chatgpt.com') || hostname.includes('openai.com')) {
      return 'chatgpt';
    }

    // Claude (claude.ai 또는 다른 Claude 도메인)
    if (hostname.includes('claude.ai') || hostname.includes('claude.anthropic.com') ||
        hostname.includes('anthropic.com')) {
      return 'claude';
    }

    // Gemini (Google의 AI 제품)
    if (hostname.includes('gemini.google.com') ||
        (hostname.includes('google.com') && href.includes('gemini'))) {
      return 'gemini';
    }

    return 'unknown';
  }

  /**
   * 플랫폼에 맞는 설정 가져오기
   * @param {string} platformName
   * @returns {object|null}
   */
  function getConfig(platformName) {
    switch (platformName) {
      case 'chatgpt': return CONFIG.GPT;
      case 'claude': return CONFIG.CLAUDE;
      case 'gemini': return CONFIG.GEMINI;
      default: return null;
    }
  }

  /**
   * 간단한 문자열 해시 (중복 방지용)
   * @param {string} str
   * @returns {string}
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

  /**
   * 플랫폼별 스트리밍 상태 확인
   * - Claude: Send 버튼의 disabled 속성
   * - GPT/Gemini: Stop 버튼 존재 여부
   * @returns {boolean}
   */
  function checkIsStreaming() {
    if (!config) return false;

    if (platform === 'claude') {
      // Claude: Send 버튼이 disabled 상태면 스트리밍 중
      const sendBtn = document.querySelector(config.sendBtn);
      return sendBtn !== null && sendBtn.hasAttribute('disabled');
    }

    // GPT/Gemini: Stop 버튼으로 감지
    const stopBtn = document.querySelector(config.stopBtn);
    return stopBtn !== null && stopBtn.offsetParent !== null;
  }

  // ============================================================================
  // DOM 텍스트 추출
  // ============================================================================

  /**
   * 마지막 Query/Answer 쌍 추출
   * @returns {{query: string, answer: string}|null}
   */
  function extractLastConversation() {
    if (!config) return null;

    try {
      if (platform === 'claude') {
        return extractClaudeConversation();
      }

      // GPT/Gemini 기존 로직
      const queryElements = document.querySelectorAll(config.query);
      const answerElements = document.querySelectorAll(config.answer);

      if (queryElements.length === 0 || answerElements.length === 0) {
        return null;
      }

      const lastQuery = queryElements[queryElements.length - 1];
      const lastAnswer = answerElements[answerElements.length - 1];

      const queryText = lastQuery?.innerText?.trim() || '';
      const answerText = lastAnswer?.innerText?.trim() || '';

      if (!queryText || !answerText) {
        return null;
      }

      return { query: queryText, answer: answerText };
    } catch (error) {
      return null;
    }
  }

  /**
   * Claude 대화 추출 (특수 처리)
   * Claude의 메시지 구조: 사용자 메시지와 Claude 응답을 각각 찾기
   */
  function extractClaudeConversation() {
    try {
      // 사용자 메시지 찾기
      const userMessages = document.querySelectorAll(config.query);
      // Claude 응답 찾기
      const claudeResponses = document.querySelectorAll(config.answer);

      if (userMessages.length === 0 || claudeResponses.length === 0) {
        return null;
      }

      // 마지막 메시지들 가져오기
      const lastQuery = userMessages[userMessages.length - 1];
      const lastAnswer = claudeResponses[claudeResponses.length - 1];

      const queryText = lastQuery?.innerText?.trim() || '';
      const answerText = lastAnswer?.innerText?.trim() || '';

      if (!queryText || !answerText) {
        return null;
      }

      return { query: queryText, answer: answerText };
    } catch (error) {
      console.error('[Daily Scrum] Claude extraction error:', error);
      return null;
    }
  }

  // ============================================================================
  // 데이터 전송
  // ============================================================================

  /**
   * 캡처된 대화 데이터를 Background로 전송
   * @param {object} conversation - {query, answer}
   */
  function sendConversation(conversation) {
    // 탭이 숨겨져 있으면 수집 스킵
    if (document.hidden) return;

    if (!conversation || !conversation.query || !conversation.answer) {
      return;
    }

    // 중복 체크 (query+answer 해시)
    const hash = simpleHash(conversation.query + conversation.answer);
    if (hash === lastCapturedHash) {
      return;
    }
    lastCapturedHash = hash;

    const payload = {
      type: 'DAILY_SCRUM_CAPTURE',
      source: platform,
      data: {
        query: conversation.query,
        answer: conversation.answer,
        url: window.location.href,
        timestamp: Date.now()
      }
    };

    try {
      chrome.runtime.sendMessage({
        action: 'DATA_CAPTURED',
        payload: payload
      }).catch(() => {
        // Service Worker 비활성화 시 무시
      });
    } catch (error) {
      // 무시
    }
  }

  // ============================================================================
  // 응답 완료 감지
  // ============================================================================

  /**
   * 응답 완료 시 캡처 수행 (debounced)
   */
  function onResponseUpdate() {
    // 기존 타이머 취소
    if (responseDebounceTimer) {
      clearTimeout(responseDebounceTimer);
    }

    // 스트리밍 중이면 대기
    const streaming = checkIsStreaming();
    if (streaming) {
      if (!isStreaming) {
        isStreaming = true;

        // 주기적 폴링 시작 (버튼 제거 감지용)
        if (streamingCheckInterval) {
          clearInterval(streamingCheckInterval);
        }
        streamingCheckInterval = setInterval(() => {
          if (!checkIsStreaming()) {
            clearInterval(streamingCheckInterval);
            streamingCheckInterval = null;
            isStreaming = false;

            // 즉시 추출 시도
            attemptExtraction();
          }
        }, STREAMING_CHECK_INTERVAL);
      }
      return;
    }

    // 스트리밍이 끝났으면 debounce 후 캡처
    responseDebounceTimer = setTimeout(() => {
      attemptExtraction();
    }, DEBOUNCE_DELAY);
  }

  /**
   * 대화 추출 시도
   */
  function attemptExtraction() {
    // 폴링 타이머 정리
    if (streamingCheckInterval) {
      clearInterval(streamingCheckInterval);
      streamingCheckInterval = null;
    }

    if (isStreaming) {
      isStreaming = false;
    }

    const conversation = extractLastConversation();
    if (conversation) {
      sendConversation(conversation);
    }
  }

  // ============================================================================
  // MutationObserver 설정
  // ============================================================================

  /**
   * DOM 변경 감지 시작 (비동기)
   */
  async function setupObserver() {
    if (!config) {
      console.warn('[Daily Scrum] No config for platform:', platform);
      return;
    }

    // Send 버튼이 나타날 때까지 대기
    const sendBtn = await waitForElement(config.sendBtn, 10000);

    if (!sendBtn) {
      return;
    }

    domObserver = new MutationObserver((mutations) => {
      // Answer 영역에 변화가 있는지 확인
      let hasAnswerChange = false;

      for (const mutation of mutations) {
        // 텍스트 변경 감지
        if (mutation.type === 'characterData') {
          hasAnswerChange = true;
          break;
        }

        // 새 노드 추가 감지
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
              hasAnswerChange = true;
              break;
            }
          }
        }

        if (hasAnswerChange) break;
      }

      if (hasAnswerChange) {
        onResponseUpdate();
      }
    });

    // Body 전체 관찰 (subtree 포함)
    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  function cleanup() {
    if (responseDebounceTimer) {
      clearTimeout(responseDebounceTimer);
      responseDebounceTimer = null;
    }
    if (streamingCheckInterval) {
      clearInterval(streamingCheckInterval);
      streamingCheckInterval = null;
    }
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    lastCapturedHash = null;
  }

  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);

  // ============================================================================
  // 초기화
  // ============================================================================

  function init() {
    try {
      platform = detectPlatform();
      config = getConfig(platform);

      if (!config) {
        return;
      }

      // DOM이 준비되면 Observer 시작 (비동기)
      if (document.body) {
        setupObserver().catch(() => {
          // 무시
        });
      } else {
        const bodyWaiter = new MutationObserver(() => {
          if (document.body) {
            bodyWaiter.disconnect();
            setupObserver().catch(() => {
              // 무시
            });
          }
        });
        bodyWaiter.observe(document.documentElement, { childList: true });
      }
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

})();
