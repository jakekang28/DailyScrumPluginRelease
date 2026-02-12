/**
 * Interaction Tracker Script
 *
 * 사용자 인터랙션 메트릭과 Epistemic Signal을 수집합니다.
 * 키 내용이나 좌표는 수집하지 않고, 패턴과 메트릭만 수집합니다.
 *
 * @see research.md 3.4절
 */
(function() {
  'use strict';

  // ============================================================================
  // 전역 인스턴스 관리 (Extension Reload 대응)
  // ============================================================================

  const SCRIPT_ID = '__DAILY_SCRUM_INTERACTION_TRACKER__';

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

  const FLUSH_INTERVAL = 30000;        // 30초
  const IDLE_THRESHOLD = 30000;        // 30초
  const SCROLL_THROTTLE = 200;         // 200ms
  const TYPING_BURST_TIMEOUT = 2000;   // 2초
  const RAPID_ACTION_WINDOW = 2000;    // 2초
  const SUBWINDOW_INTERVAL = 10000;    // 10초
  const MIN_RAPID_ACTION_COUNT = 3;

  // ============================================================================
  // 유틸리티 함수
  // ============================================================================

  /**
   * 민감한 요소 체크 (비밀번호, 전화번호, 신용카드 등)
   * @param {Element} el - 검사할 요소
   * @returns {boolean} 민감한 요소 여부
   */
  function isSensitiveElement(el) {
    if (!el) return true;

    const type = el.type?.toLowerCase();
    if (type === 'password' || type === 'tel') return true;

    const autocomplete = el.getAttribute('autocomplete')?.toLowerCase();
    if (autocomplete?.includes('cc-') || autocomplete === 'password') return true;

    const name = el.name?.toLowerCase() || '';
    const id = el.id?.toLowerCase() || '';
    if (name.includes('ssn') || name.includes('social') ||
        id.includes('ssn') || id.includes('social')) return true;

    return false;
  }

  // ============================================================================
  // InteractionTracker 클래스
  // ============================================================================

  class InteractionTracker {
    constructor() {
      // 메트릭 버퍼
      this.buffer = this._createEmptyBuffer();

      // 내부 상태
      this._lastActivity = Date.now();
      this._lastScrollY = window.scrollY;
      this._typingTimer = null;
      this._scrollThrottleTimer = null;
      this._scrollDirectionBuffer = [];
      this._recentActions = [];
      this._subWindowEvents = [0, 0, 0];
      this._subWindowIndex = 0;
      this._subWindowTimer = null;
      this._flushTimer = null;
      this._boundListeners = {};
      this._isCleanedUp = false;

      // Chrome API 가용성 확인
      this._hasChromeAPI = typeof chrome !== 'undefined' &&
                          chrome.runtime &&
                          typeof chrome.runtime.sendMessage === 'function';
    }

    _createEmptyBuffer() {
      return {
        // 기존 메트릭
        clickCount: 0,
        scrollEvents: 0,
        typingBursts: 0,
        copyPasteCount: 0,
        selectionEvents: 0,
        idlePeriods: [],
        contextSwitches: 0,

        // Epistemic Signal
        scrollPattern: null,
        typingContext: { search: 0, chatInput: 0, editor: 0, other: 0 },
        selectionContext: [],
        rapidActionSequence: [],
        focusDuration: []
      };
    }

    // ============================================================================
    // 초기화
    // ============================================================================

    init() {
      // Click
      this._boundListeners.click = (e) => this._handleClick(e);
      document.addEventListener('click', this._boundListeners.click, { passive: true });

      // Keydown
      this._boundListeners.keydown = (e) => this._handleKeydown(e);
      document.addEventListener('keydown', this._boundListeners.keydown, { passive: true });

      // Scroll
      this._boundListeners.scroll = () => this._handleScroll();
      document.addEventListener('scroll', this._boundListeners.scroll, { passive: true });

      // Copy/Paste
      this._boundListeners.copy = () => this._handleCopy();
      this._boundListeners.paste = () => this._handlePaste();
      document.addEventListener('copy', this._boundListeners.copy, { passive: true });
      document.addEventListener('paste', this._boundListeners.paste, { passive: true });

      // Selection
      this._boundListeners.selectionchange = () => this._handleSelectionChange();
      document.addEventListener('selectionchange', this._boundListeners.selectionchange, { passive: true });

      // Visibility (Tab Transition)
      this._boundListeners.visibilitychange = () => this._handleVisibilityChange();
      document.addEventListener('visibilitychange', this._boundListeners.visibilitychange);

      // Sub-window 타이머 (10초)
      this._subWindowTimer = setInterval(() => this._rotateSubWindow(), SUBWINDOW_INTERVAL);

      // Flush 타이머 (30초)
      this._flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL);

      // FLUSH_NOW / CLEANUP_AND_STOP 메시지 리스너
      if (this._hasChromeAPI) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
          if (message.action === 'FLUSH_NOW') {
            this.flush();
            sendResponse({ success: true });
          } else if (message.action === 'CLEANUP_AND_STOP') {
            this.cleanup();
            sendResponse({ success: true });
          }
          return true;
        });
      }

      // Cleanup 핸들러
      window.addEventListener('beforeunload', () => this.cleanup());
      window.addEventListener('pagehide', () => this.cleanup());

    }

    // ============================================================================
    // 이벤트 핸들러
    // ============================================================================

    _handleClick(e) {
      if (isSensitiveElement(e.target)) return;

      this.buffer.clickCount++;
      this._subWindowEvents[this._subWindowIndex]++;
      this._recordActivity();
      this._trackRapidAction('click');
    }

    _handleKeydown(e) {
      const target = e.target;
      if (isSensitiveElement(target)) return;

      this._subWindowEvents[this._subWindowIndex]++;
      this._recordActivity();

      // 타이핑 버스트 디바운스
      if (this._typingTimer) clearTimeout(this._typingTimer);

      this._typingTimer = setTimeout(() => {
        this.buffer.typingBursts++;

        // 타이핑 컨텍스트 분류
        const context = this._classifyTypingTarget(target);
        this.buffer.typingContext[context]++;

        this._trackRapidAction('type');
      }, TYPING_BURST_TIMEOUT);
    }

    _handleScroll() {
      this.buffer.scrollEvents++;
      this._recordActivity();

      // Throttle 스크롤 방향 추적
      if (this._scrollThrottleTimer) return;

      this._scrollThrottleTimer = setTimeout(() => {
        this._trackScrollDirection();
        this._scrollThrottleTimer = null;
      }, SCROLL_THROTTLE);
    }

    _handleCopy() {
      this.buffer.copyPasteCount++;
      this._trackRapidAction('copy');
    }

    _handlePaste() {
      this.buffer.copyPasteCount++;
      this._trackRapidAction('paste');
    }

    _handleSelectionChange() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;

      const text = selection.toString().trim();
      if (!text) return;

      let container = null;
      try {
        const range = selection.getRangeAt(0);
        container = range.commonAncestorContainer;
        if (container.nodeType === Node.TEXT_NODE) {
          container = container.parentElement;
        }
      } catch (e) {
        return;
      }

      if (isSensitiveElement(container)) return;

      this.buffer.selectionEvents++;

      // 컨텍스트 기록 (텍스트 내용은 수집하지 않음)
      // C1: hard cap to prevent unbounded growth between flushes
      if (this.buffer.selectionContext.length < 50) {
        this.buffer.selectionContext.push({
          textLength: text.length,
          containsCode: this._isCodeElement(container),
          elementType: this._classifyElement(container)
        });
      }

      this._trackRapidAction('select');
    }

    _handleVisibilityChange() {
      // Context 유효성 검사
      if (!isContextValid()) {
        this.cleanup();
        return;
      }

      const hostname = window.location.hostname;
      const now = Date.now();

      // 탭을 떠날 때 contextSwitches 증가
      if (document.hidden) {
        this.buffer.contextSwitches++;
      }

      // Chrome API 확인 후 메시지 전송
      if (this._hasChromeAPI) {
        sendMessageWithRetry({
          action: 'TAB_TRANSITION',
          payload: {
            type: document.hidden ? 'leave' : 'enter',
            hostname: hostname,
            at: now
          }
        }).catch(() => {
          // Service Worker가 비활성화된 경우 무시
        });
      }
    }

    // ============================================================================
    // 분류 헬퍼
    // ============================================================================

    _classifyTypingTarget(el) {
      if (!el) return 'other';

      const tag = el.tagName?.toLowerCase();
      const type = el.type?.toLowerCase();
      const role = el.getAttribute('role')?.toLowerCase();

      // Search 컨텍스트
      if (type === 'search' || role === 'searchbox' ||
          el.closest('[role="search"]') ||
          el.closest('form[action*="search"]') ||
          el.closest('[aria-label*="search" i]')) {
        return 'search';
      }

      // Chat/LLM 입력 컨텍스트
      if (el.closest('[id*="prompt"]') ||
          el.closest('[data-qa="message_input"]') ||
          el.closest('.ProseMirror') ||
          el.closest('[contenteditable="true"][role="textbox"]') ||
          el.closest('[aria-label*="message" i]')) {
        return 'chatInput';
      }

      // Editor 컨텍스트
      if (el.isContentEditable ||
          el.contentEditable === 'true' ||
          tag === 'textarea' ||
          el.closest('.kix-lineview') ||
          el.closest('[data-block-id]') ||
          el.closest('.cm-editor') ||
          el.closest('.monaco-editor')) {
        return 'editor';
      }

      return 'other';
    }

    _isCodeElement(el) {
      return !!el?.closest('pre, code, .hljs, .code-block, .cm-editor, .monaco-editor, [class*="highlight"]');
    }

    _classifyElement(el) {
      if (!el) return 'other';

      if (el.closest('pre, code, .hljs, .code-block')) return 'code';
      if (el.closest('h1, h2, h3, h4, h5, h6, [role="heading"]')) return 'heading';
      if (el.closest('li, ul, ol')) return 'list';
      if (el.closest('table, tr, td, th')) return 'table';
      if (el.closest('p, span, div')) return 'paragraph';

      return 'other';
    }

    // ============================================================================
    // Epistemic Signal 추적
    // ============================================================================

    _trackScrollDirection() {
      const currentY = window.scrollY;
      const direction = currentY > this._lastScrollY ? 'D' : 'U';
      this._lastScrollY = currentY;

      // 같은 방향 연속 스크롤 집계
      const last = this._scrollDirectionBuffer[this._scrollDirectionBuffer.length - 1];
      if (last && last.dir === direction) {
        last.count++;
      } else {
        this._scrollDirectionBuffer.push({ dir: direction, count: 1 });
      }
    }

    _compressScrollPattern() {
      if (this._scrollDirectionBuffer.length === 0) return null;

      // [{dir:'D',count:3},{dir:'U',count:2}] → 'D3-U2'
      return this._scrollDirectionBuffer
        .map(segment => `${segment.dir}${segment.count}`)
        .join('-');
    }

    _trackRapidAction(actionType) {
      const now = Date.now();

      this._recentActions.push({ type: actionType, at: now });

      // 2초 이전 행동 제거
      this._recentActions = this._recentActions.filter(
        action => now - action.at <= RAPID_ACTION_WINDOW
      );

      // 3개 이상 행동이면 시퀀스 기록
      if (this._recentActions.length >= MIN_RAPID_ACTION_COUNT) {
        // C3: cap rapid action sequences per flush cycle
        if (this.buffer.rapidActionSequence.length < 20) {
          const sequence = this._recentActions.map(a => a.type);
          this.buffer.rapidActionSequence.push({
            sequence: sequence,
            at: now
          });
        }

        // 중복 방지를 위해 리셋
        this._recentActions = [];
      }
    }

    _rotateSubWindow() {
      this._subWindowIndex = (this._subWindowIndex + 1) % 3;

      // 사이클 완료 시 (인덱스가 0으로 돌아올 때) focus profile 기록
      if (this._subWindowIndex === 0) {
        const profile = this._subWindowEvents.map(count => {
          if (count >= 5) return 'high';
          if (count >= 2) return 'medium';
          return 'low';
        });

        // Fix 6: cap focusDuration to prevent unbounded growth (100 ≈ ~16min of 10s cycles)
        if (this.buffer.focusDuration.length < 100) {
          this.buffer.focusDuration.push(profile);
        }

        // 카운터 리셋
        this._subWindowEvents = [0, 0, 0];
      }
    }

    _recordActivity() {
      const now = Date.now();

      if (now - this._lastActivity > IDLE_THRESHOLD) {
        this.buffer.idlePeriods.push({
          start: this._lastActivity,
          end: now,
          duration: now - this._lastActivity
        });
      }

      this._lastActivity = now;
    }

    // ============================================================================
    // Flush
    // ============================================================================

    flush() {
      // Context 유효성 검사 (확장프로그램 리로드 대응)
      if (!isContextValid()) {
        this.cleanup();
        return;
      }

      // 데이터가 없으면 스킵
      if (!this._hasData()) {
        this._resetBuffer();
        return;
      }

      // Chrome API 확인
      if (!this._hasChromeAPI) {
        this._resetBuffer();
        return;
      }

      // 스크롤 패턴 압축
      const scrollPattern = this._compressScrollPattern();

      const payload = {
        type: 'DAILY_SCRUM_CAPTURE',
        source: 'interaction',
        data: {
          // 기존 메트릭
          clickCount: this.buffer.clickCount,
          scrollEvents: this.buffer.scrollEvents,
          typingBursts: this.buffer.typingBursts,
          copyPasteCount: this.buffer.copyPasteCount,
          selectionEvents: this.buffer.selectionEvents,
          idlePeriods: [...this.buffer.idlePeriods],
          contextSwitches: this.buffer.contextSwitches,

          // Epistemic Signal
          scrollPattern: scrollPattern,
          typingContext: { ...this.buffer.typingContext },
          selectionContext: [...this.buffer.selectionContext],
          rapidActionSequence: [...this.buffer.rapidActionSequence],
          focusDuration: [...this.buffer.focusDuration],

          // 메타데이터
          hostname: window.location.hostname,
          timestamp: Date.now()
        }
      };

      sendMessageWithRetry({
        action: 'INTERACTION_METRICS_UPDATE',
        payload: payload
      }).catch(() => {
        // Service Worker 메시지 전송 실패 무시
      });

      this._resetBuffer();
    }

    _hasData() {
      const b = this.buffer;

      // 기본 메트릭 체크
      if (b.clickCount > 0 || b.scrollEvents > 0 || b.typingBursts > 0 ||
          b.copyPasteCount > 0 || b.selectionEvents > 0) {
        return true;
      }

      // Epistemic Signal 체크
      if (this._scrollDirectionBuffer.length > 0 ||
          b.selectionContext.length > 0 ||
          b.rapidActionSequence.length > 0 ||
          b.focusDuration.length > 0 ||
          b.idlePeriods.length > 0) {
        return true;
      }

      // 타이핑 컨텍스트 체크
      const tc = b.typingContext;
      if (tc.search > 0 || tc.chatInput > 0 || tc.editor > 0 || tc.other > 0) {
        return true;
      }

      return false;
    }

    _resetBuffer() {
      this.buffer = this._createEmptyBuffer();
      this._scrollDirectionBuffer = [];
    }

    // ============================================================================
    // Cleanup
    // ============================================================================

    cleanup() {
      if (this._isCleanedUp) return;
      this._isCleanedUp = true;

      try {
        // 타이머 정리
        if (this._typingTimer) clearTimeout(this._typingTimer);
        if (this._scrollThrottleTimer) clearTimeout(this._scrollThrottleTimer);
        if (this._subWindowTimer) clearInterval(this._subWindowTimer);
        if (this._flushTimer) clearInterval(this._flushTimer);

        // 이벤트 리스너 제거
        document.removeEventListener('click', this._boundListeners.click);
        document.removeEventListener('keydown', this._boundListeners.keydown);
        document.removeEventListener('scroll', this._boundListeners.scroll);
        document.removeEventListener('copy', this._boundListeners.copy);
        document.removeEventListener('paste', this._boundListeners.paste);
        document.removeEventListener('selectionchange', this._boundListeners.selectionchange);
        document.removeEventListener('visibilitychange', this._boundListeners.visibilitychange);

        // 남은 데이터 플러시
        if (this._hasData()) {
          this.flush();
        }

      } catch (error) {
      }
    }
  }

  // ============================================================================
  // 초기화
  // ============================================================================

  let tracker = null;

  function init() {
    try {
      tracker = new InteractionTracker();
      tracker.init();

      // 전역에 인스턴스 노출 (다음 리로드 시 cleanup 가능하도록)
      window[SCRIPT_ID] = tracker;
    } catch (error) {
      console.error('[Daily Scrum] InteractionTracker initialization error:', error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
