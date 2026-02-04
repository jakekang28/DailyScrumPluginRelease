/**
 * Network Interception Script
 *
 * MAIN world에서 실행되어 fetch()와 XMLHttpRequest를 래핑합니다.
 * ChatGPT, Claude, Gemini의 API 응답을 감지하여 Content Script로 전달합니다.
 *
 * 보안 원칙:
 * - Manifest V3 CSP 준수 (eval 사용 금지)
 * - 원본 fetch/XHR 동작 완전 보존
 * - 에러 발생 시 사용자 경험에 영향 없음
 *
 * @see research.md 3.1절
 */
(function() {
  'use strict';

  // ============================================================================
  // Fetch API 래핑
  // ============================================================================

  const originalFetch = window.fetch;

  window.fetch = async function(...args) {
    let response;

    try {
      // 원본 fetch 실행
      response = await originalFetch.apply(this, args);

      // URL 추출
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;

      // 타겟 엔드포인트 감지
      if (url && isTargetEndpoint(url)) {
        try {
          // response.clone()으로 원본 보존
          const clone = response.clone();
          const body = await clone.text();

          // Content Script로 전달
          window.postMessage({
            type: 'DAILY_SCRUM_CAPTURE',
            source: detectPlatform(url),
            data: {
              url: url,
              body: body,
              timestamp: Date.now(),
              method: args[1]?.method || 'GET'
            }
          }, '*');
        } catch (captureError) {
          // 캡처 실패해도 원본 응답은 반환
          console.debug('[Daily Scrum] Capture failed (non-critical):', captureError.message);
        }
      }
    } catch (fetchError) {
      // 원본 fetch 에러는 그대로 throw
      throw fetchError;
    }

    return response;
  };

  // ============================================================================
  // XMLHttpRequest 래핑
  // ============================================================================

  const OriginalXHR = window.XMLHttpRequest;

  window.XMLHttpRequest = function() {
    const xhr = new OriginalXHR();
    const originalOpen = xhr.open;
    const originalSend = xhr.send;

    let requestUrl = '';
    let requestMethod = '';

    // open 메서드 래핑 (URL 저장)
    xhr.open = function(method, url, ...rest) {
      requestMethod = method;
      requestUrl = url;
      return originalOpen.apply(this, [method, url, ...rest]);
    };

    // send 메서드 래핑 (응답 감지)
    xhr.send = function(...args) {
      if (isTargetEndpoint(requestUrl)) {
        const originalOnLoad = xhr.onload;

        xhr.onload = function(event) {
          try {
            // 응답 캡처
            const responseBody = xhr.responseText || xhr.response;

            window.postMessage({
              type: 'DAILY_SCRUM_CAPTURE',
              source: detectPlatform(requestUrl),
              data: {
                url: requestUrl,
                body: responseBody,
                timestamp: Date.now(),
                method: requestMethod
              }
            }, '*');
          } catch (captureError) {
            console.debug('[Daily Scrum] XHR capture failed (non-critical):', captureError.message);
          }

          // 원본 onload 핸들러 실행
          if (originalOnLoad) {
            return originalOnLoad.apply(this, arguments);
          }
        };
      }

      return originalSend.apply(this, args);
    };

    return xhr;
  };

  // XMLHttpRequest의 static 속성들 복사
  for (const prop in OriginalXHR) {
    if (OriginalXHR.hasOwnProperty(prop)) {
      try {
        window.XMLHttpRequest[prop] = OriginalXHR[prop];
      } catch (e) {
        // Some properties are read-only
      }
    }
  }

  // Prototype 체인 유지
  window.XMLHttpRequest.prototype = OriginalXHR.prototype;

  // ============================================================================
  // 유틸리티 함수
  // ============================================================================

  /**
   * 타겟 API 엔드포인트 감지
   * @param {string} url - 요청 URL
   * @returns {boolean} 타겟 엔드포인트 여부
   */
  function isTargetEndpoint(url) {
    if (!url || typeof url !== 'string') return false;

    return (
      url.includes('/backend-api/conversation') ||  // ChatGPT
      url.includes('/api/organizations') ||          // Claude
      url.includes('/batchexecute')                  // Gemini
    );
  }

  /**
   * 플랫폼 감지
   * @param {string} url - 요청 URL
   * @returns {string} 플랫폼 이름
   */
  function detectPlatform(url) {
    if (!url || typeof url !== 'string') return 'unknown';

    const lowerUrl = url.toLowerCase();

    if (lowerUrl.includes('chatgpt') || lowerUrl.includes('openai')) {
      return 'chatgpt';
    }
    if (lowerUrl.includes('claude') || lowerUrl.includes('anthropic')) {
      return 'claude';
    }
    if (lowerUrl.includes('gemini') || lowerUrl.includes('google')) {
      return 'gemini';
    }

    return 'unknown';
  }

  // ============================================================================
  // 초기화 완료 로깅 (개발용)
  // ============================================================================

  console.debug('[Daily Scrum] Network interception initialized');

})();
