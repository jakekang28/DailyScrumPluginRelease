// lib/temp-buffer.js
var DB_NAME = "dailyScrumBuffer";
var DB_VERSION = 1;
var STORE_NAME = "captures";
var CLEANUP_AGE_MS = 30 * 60 * 1e3;
var TempBuffer = class {
  constructor() {
    this.db = null;
  }
  /**
   * IndexedDB 초기화
   * @returns {Promise<IDBDatabase>}
   */
  async _initDB() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => {
        console.error("[TempBuffer] IndexedDB open error:", request.error);
        reject(request.error);
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const objectStore = db.createObjectStore(STORE_NAME, {
            keyPath: "id",
            autoIncrement: true
          });
          objectStore.createIndex("timestamp", "timestamp", { unique: false });
        }
      };
      request.onblocked = () => {
        console.warn("[TempBuffer] IndexedDB blocked by another connection");
        reject(new Error("IndexedDB blocked"));
      };
    });
  }
  /**
   * 데이터 추가
   * @param {Object} data - 저장할 데이터
   * @returns {Promise<number>} - 추가된 항목의 ID
   */
  async add(data) {
    try {
      await this.cleanup();
      const db = await this._initDB();
      const transaction = db.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const record = {
        ...data,
        timestamp: Date.now()
      };
      return new Promise((resolve, reject) => {
        const request = store.add(record);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          console.error("[TempBuffer] Add error:", request.error);
          reject(request.error);
        };
        transaction.oncomplete = () => {
        };
        transaction.onerror = () => {
          console.error("[TempBuffer] Add transaction error:", transaction.error);
          reject(transaction.error);
        };
      });
    } catch (error) {
      console.error("[TempBuffer] add() error:", error);
      throw error;
    }
  }
  /**
   * 30분 이상 된 데이터 삭제
   * @returns {Promise<number>} - 삭제된 항목 수
   */
  async cleanup() {
    try {
      const db = await this._initDB();
      const transaction = db.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("timestamp");
      const cutoffTime = Date.now() - CLEANUP_AGE_MS;
      const range = IDBKeyRange.upperBound(cutoffTime);
      return new Promise((resolve, reject) => {
        let deletedCount = 0;
        const cursorRequest = index.openCursor(range);
        cursorRequest.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            deletedCount++;
            cursor.continue();
          }
        };
        cursorRequest.onerror = () => {
          console.error("[TempBuffer] Cleanup cursor error:", cursorRequest.error);
          reject(cursorRequest.error);
        };
        transaction.oncomplete = () => {
          if (deletedCount > 0) {
          }
          resolve(deletedCount);
        };
        transaction.onerror = () => {
          console.error("[TempBuffer] Cleanup transaction error:", transaction.error);
          reject(transaction.error);
        };
      });
    } catch (error) {
      console.error("[TempBuffer] cleanup() error:", error);
      throw error;
    }
  }
  /**
   * 전체 데이터를 서버로 flush
   * @param {Function} encryptAndSend - 암호화 및 전송 콜백: async (data) => void
   * @returns {Promise<number>} - 전송된 항목 수
   */
  async flushToServer(encryptAndSend) {
    try {
      const db = await this._initDB();
      const allData = await this._getAllData(db);
      if (allData.length === 0) {
        return 0;
      }
      try {
        await encryptAndSend(allData);
      } catch (sendError) {
        console.error("[TempBuffer] encryptAndSend callback error:", sendError);
        throw sendError;
      }
      await this._clearAll(db);
      return allData.length;
    } catch (error) {
      console.error("[TempBuffer] flushToServer() error:", error);
      throw error;
    }
  }
  /**
   * 모든 데이터 읽기 (내부 헬퍼)
   * @param {IDBDatabase} db
   * @returns {Promise<Array>}
   */
  async _getAllData(db) {
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        console.error("[TempBuffer] getAll error:", request.error);
        reject(request.error);
      };
    });
  }
  /**
   * 모든 데이터 삭제 (내부 헬퍼)
   * @param {IDBDatabase} db
   * @returns {Promise<void>}
   */
  async _clearAll(db) {
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        console.error("[TempBuffer] clear error:", request.error);
        reject(request.error);
      };
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = () => {
        console.error("[TempBuffer] Clear transaction error:", transaction.error);
        reject(transaction.error);
      };
    });
  }
  /**
   * 저장된 항목 수 조회 (팝업 상태 표시용)
   * @returns {Promise<number>}
   */
  async getCount() {
    try {
      const db = await this._initDB();
      const transaction = db.transaction([STORE_NAME], "readonly");
      const store = transaction.objectStore(STORE_NAME);
      return new Promise((resolve, reject) => {
        const request = store.count();
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          console.error("[TempBuffer] count error:", request.error);
          reject(request.error);
        };
      });
    } catch (error) {
      console.error("[TempBuffer] getCount() error:", error);
      return 0;
    }
  }
  /**
   * IndexedDB 연결 닫기
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
};
var tempBuffer = new TempBuffer();

// lib/encryption.js
var EncryptionEngine = class _EncryptionEngine {
  /**
   * @private
   * @type {CryptoKey|null}
   */
  #key = null;
  /**
   * PBKDF2 iteration count
   * @private
   * @constant {number}
   */
  static #PBKDF2_ITERATIONS = 3e5;
  // 균형잡힌 보안/성능 (OWASP 2026 권장: 600,000+)
  /**
   * AES-GCM IV length (bytes)
   * @private
   * @constant {number}
   */
  static #IV_LENGTH = 12;
  // 96 bits (표준 권장)
  /**
   * Maximum ciphertext size (bytes) - DoS 방지
   * @private
   * @constant {number}
   */
  static #MAX_CIPHERTEXT_SIZE = 10 * 1024 * 1024;
  // 10MB
  /**
   * 암호화 키 파생
   *
   * ⚠️ 보안 경고: userId는 예측 가능하므로 진정한 E2E가 아님
   * 서버가 userId + serverSalt로 동일한 키를 재구성할 수 있음
   *
   * @param {string} userId - Supabase user ID (UUID)
   * @param {string} serverSalt - 서버에서 제공한 salt
   * @throws {Error} userId 또는 serverSalt가 비어있을 경우
   * @returns {Promise<void>}
   */
  async deriveKey(userId, serverSalt) {
    if (!userId || !serverSalt) {
      throw new Error("userId and serverSalt are required");
    }
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(userId),
      "PBKDF2",
      false,
      // extractable: false
      ["deriveKey"]
    );
    this.#key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: enc.encode(serverSalt),
        iterations: _EncryptionEngine.#PBKDF2_ITERATIONS,
        hash: "SHA-256"
      },
      keyMaterial,
      {
        name: "AES-GCM",
        length: 256
        // 256-bit key
      },
      false,
      // extractable: false (키를 메모리에서 추출 불가)
      ["encrypt", "decrypt"]
    );
    if (typeof process !== "undefined" && true) {
    }
  }
  /**
   * 데이터 암호화
   *
   * @param {any} data - 암호화할 데이터 (JSON 직렬화 가능해야 함)
   * @throws {Error} 키가 파생되지 않았거나 암호화 실패 시
   * @returns {Promise<{iv: number[], ciphertext: number[], algorithm: string, timestamp: number}>}
   */
  async encrypt(data) {
    if (!this.#key) {
      throw new Error("Encryption key not derived. Call deriveKey() first.");
    }
    try {
      const iv = crypto.getRandomValues(new Uint8Array(_EncryptionEngine.#IV_LENGTH));
      const plaintext = JSON.stringify(data);
      const plaintextBuffer = new TextEncoder().encode(plaintext);
      const ciphertextBuffer = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv
        },
        this.#key,
        plaintextBuffer
      );
      return {
        iv: Array.from(iv),
        ciphertext: Array.from(new Uint8Array(ciphertextBuffer)),
        algorithm: "AES-GCM-256",
        timestamp: Date.now()
      };
    } catch (error) {
      console.error("[Encryption] Encryption failed");
      throw new Error("Encryption failed");
    }
  }
  /**
   * 데이터 복호화
   *
   * 타이밍 공격 방지: 모든 에러를 동일한 메시지로 반환
   *
   * @param {{iv: number[], ciphertext: number[], algorithm: string}} encryptedData
   * @throws {Error} 키가 파생되지 않았거나 복호화 실패 시
   * @returns {Promise<any>} 복호화된 원본 데이터
   */
  async decrypt(encryptedData) {
    if (!this.#key) {
      throw new Error("Encryption key not derived. Call deriveKey() first.");
    }
    try {
      if (!encryptedData.iv || !encryptedData.ciphertext) {
        throw new Error("Invalid encrypted data format");
      }
      if (encryptedData.iv.length !== _EncryptionEngine.#IV_LENGTH) {
        throw new Error("Invalid encrypted data format");
      }
      if (encryptedData.ciphertext.length > _EncryptionEngine.#MAX_CIPHERTEXT_SIZE) {
        throw new Error("Invalid encrypted data format");
      }
      const iv = new Uint8Array(encryptedData.iv);
      const ciphertext = new Uint8Array(encryptedData.ciphertext);
      const plaintextBuffer = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv
        },
        this.#key,
        ciphertext
      );
      const plaintext = new TextDecoder().decode(plaintextBuffer);
      return JSON.parse(plaintext);
    } catch (error) {
      console.error("[Encryption] Decryption failed");
      throw new Error("Decryption failed");
    }
  }
  /**
   * 키 파생 여부 확인
   *
   * @returns {boolean}
   */
  hasKey() {
    return this.#key !== null;
  }
  /**
   * 키 폐기 (로그아웃 시 호출)
   *
   * ⚠️ 주의: 키는 extractable: false이므로 재파생 필요
   */
  clearKey() {
    this.#key = null;
  }
};
var encryptionEngine = new EncryptionEngine();

// lib/config.js
var SUPABASE_URL = "https://zoqtvrcrqnaatkdwmail.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpvcXR2cmNycW5hYXRrZHdtYWlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk0MDg5ODksImV4cCI6MjA4NDk4NDk4OX0.j2NNC57jmWPANjGufdLZb0FPz8lhOdaq9V32Fv0zZpE";
var GOOGLE_AUTH_CLIENT_ID = import.meta.env?.VITE_GOOGLE_AUTH_CLIENT_ID || "167290902104-m31v1limo9qjec9s7f9r9k9ltu4n25b3.apps.googleusercontent.com";

// lib/google-api-client.js
async function authorizeGoogleWorkspace(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        console.error("[Google API] OAuth flow error:", chrome.runtime.lastError);
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!token) {
        return reject(new Error("No token received"));
      }
      resolve(token);
    });
  });
}
async function getAccessToken() {
  try {
    const token = await authorizeGoogleWorkspace(false);
    return token;
  } catch (error) {
    return null;
  }
}
async function ensureValidToken() {
  return await authorizeGoogleWorkspace(true);
}
async function getDocument(documentId) {
  const token = await ensureValidToken();
  const response = await fetch(
    `https://docs.googleapis.com/v1/documents/${documentId}`,
    {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Docs API error: ${response.status} - ${error}`);
  }
  return await response.json();
}
async function getDocumentText(documentId) {
  const doc = await getDocument(documentId);
  let text = "";
  if (doc.body && doc.body.content) {
    for (const element of doc.body.content) {
      if (element.paragraph) {
        for (const el of element.paragraph.elements || []) {
          if (el.textRun && el.textRun.content) {
            text += el.textRun.content;
          }
        }
      }
    }
  }
  return text;
}
async function getSpreadsheet(spreadsheetId) {
  const token = await ensureValidToken();
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`,
    {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Sheets API error: ${response.status} - ${error}`);
  }
  return await response.json();
}
async function getPresentation(presentationId) {
  const token = await ensureValidToken();
  const response = await fetch(
    `https://slides.googleapis.com/v1/presentations/${presentationId}`,
    {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Slides API error: ${response.status} - ${error}`);
  }
  return await response.json();
}
async function getPresentationText(presentationId) {
  const presentation = await getPresentation(presentationId);
  const slides = [];
  let fullText = "";
  if (presentation.slides) {
    presentation.slides.forEach((slide, index) => {
      let slideText = "";
      if (slide.pageElements) {
        for (const element of slide.pageElements) {
          if (element.shape && element.shape.text) {
            for (const textElement of element.shape.text.textElements || []) {
              if (textElement.textRun && textElement.textRun.content) {
                slideText += textElement.textRun.content;
              }
            }
          }
        }
      }
      if (slideText.trim()) {
        slides.push({
          slideNumber: index + 1,
          text: slideText.trim()
        });
        fullText += slideText + "\n";
      }
    });
  }
  return { slides, fullText: fullText.trim() };
}

// background.js
var BATCH_SEND_INTERVAL = 1;
var MAX_RETRY_ATTEMPTS = 3;
var INITIAL_RETRY_DELAY = 1e3;
var STORAGE_KEYS = {
  CONSENT_GIVEN: "consentGiven",
  IS_LOGGED_IN: "isLoggedIn",
  USER_ID: "userId",
  SEND_QUEUE: "sendQueue",
  LAST_TRANSITION: "lastTransition",
  ACTIVE_TAB_INFO: "activeTabInfo",
  SERVER_SALT: "serverSalt",
  AUTH_TOKEN: "authToken",
  REFRESH_TOKEN: "refreshToken",
  IS_COLLECTING: "isCollecting",
  COLLECTION_START_TIME: "collectionStartTime",
  COLLECTION_STOP_TIME: "collectionStopTime",
  LAST_GENERATED_RANGE: "lastGeneratedRange"
};
var CONTENT_SCRIPT_MAPPING = [
  {
    patterns: ["https://chatgpt.com/*", "https://chat.openai.com/*", "https://claude.ai/*", "https://gemini.google.com/*"],
    scripts: ["content-scripts/llm-capture.js", "content-scripts/interaction-tracker.js"]
  },
  {
    patterns: ["https://www.notion.so/*", "https://app.slack.com/*"],
    scripts: ["content-scripts/collab-capture.js", "content-scripts/interaction-tracker.js"]
  },
  {
    patterns: ["https://docs.google.com/*", "https://sheets.google.com/*", "https://slides.google.com/*", "https://drive.google.com/*"],
    scripts: ["content-scripts/google-capture.js", "content-scripts/interaction-tracker.js"]
  },
  {
    patterns: ["https://developer.mozilla.org/*", "https://stackoverflow.com/*", "https://github.com/*", "https://medium.com/*", "https://dev.to/*"],
    scripts: ["content-scripts/web-reference-tracker.js"]
  }
];
async function refreshAuthToken() {
  try {
    const stored = await chrome.storage.local.get(["refreshToken"]);
    if (!stored.refreshToken) {
      console.error("[Daily Scrum] \u274C No refresh token in storage");
      return null;
    }
    console.log("[Daily Scrum] \u{1F504} Refreshing auth token...");
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        refresh_token: stored.refreshToken
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Daily Scrum] \u274C Token refresh failed:", errorText);
      if (response.status === 400 || response.status === 401) {
        console.log("[Daily Scrum] \u{1F512} Session expired, clearing auth state...");
        await chrome.storage.local.set({
          isLoggedIn: false,
          authToken: null,
          refreshToken: null
        });
      }
      return null;
    }
    const data = await response.json();
    await chrome.storage.local.set({
      authToken: data.access_token,
      refreshToken: data.refresh_token,
      // refresh token도 갱신됨
      isLoggedIn: true
    });
    console.log("[Daily Scrum] \u2705 Auth token refreshed successfully");
    return data.access_token;
  } catch (error) {
    console.error("[Daily Scrum] \u274C Token refresh error:", error);
    return null;
  }
}
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[Daily Scrum] Service Worker installed:", details.reason);
  chrome.alarms.create("batchSend", {
    periodInMinutes: BATCH_SEND_INTERVAL
  });
  const storage = await chrome.storage.local.get([
    STORAGE_KEYS.CONSENT_GIVEN,
    STORAGE_KEYS.IS_LOGGED_IN
  ]);
  if (storage[STORAGE_KEYS.IS_LOGGED_IN] === void 0) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.IS_LOGGED_IN]: false,
      [STORAGE_KEYS.SEND_QUEUE]: []
    });
  }
  console.log("[Daily Scrum] Alarms configured: batchSend every", BATCH_SEND_INTERVAL, "minute(s)");
  if (details.reason === "install" || details.reason === "update") {
    await injectContentScriptsToExistingTabs();
  }
});
async function injectContentScriptsToExistingTabs() {
  console.log("[Daily Scrum] Injecting content scripts to existing tabs...");
  for (const mapping of CONTENT_SCRIPT_MAPPING) {
    try {
      const tabs = await chrome.tabs.query({ url: mapping.patterns });
      for (const tab of tabs) {
        if (!tab.id || tab.id === chrome.tabs.TAB_ID_NONE) continue;
        for (const script of mapping.scripts) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: [script]
            });
            console.log(`[Daily Scrum] Injected ${script} into tab ${tab.id} (${tab.url})`);
          } catch (err) {
            console.log(`[Daily Scrum] Could not inject ${script} into tab ${tab.id}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error("[Daily Scrum] Tab query failed for patterns", mapping.patterns, ":", err);
    }
  }
  console.log("[Daily Scrum] Content script injection completed");
}
chrome.runtime.onStartup.addListener(() => {
  console.log("[Daily Scrum] Service Worker started");
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "DATA_CAPTURED") {
    handleDataCaptured(message.payload, sender);
    sendResponse({ success: true });
  } else if (message.action === "TAB_TRANSITION") {
    handleTabTransition(message.payload, sender);
    sendResponse({ success: true });
  } else if (message.action === "GOOGLE_API_REQUEST") {
    handleGoogleApiRequest(message.payload).then((result) => sendResponse({ success: true, data: result })).catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  } else if (message.action === "AUTHORIZE_GOOGLE_WORKSPACE") {
    authorizeGoogleWorkspace().then((token) => sendResponse({ success: true, token })).catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  } else if (message.action === "START_COLLECTION") {
    handleStartCollection().then((result) => sendResponse(result)).catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  } else if (message.action === "STOP_COLLECTION") {
    handleStopCollection().then((result) => sendResponse(result)).catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  } else if (message.action === "FORCE_FLUSH") {
    handleForceFlush().then((result) => sendResponse(result)).catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  } else if (message.action === "GET_COLLECTION_STATE") {
    handleGetCollectionState().then((result) => sendResponse(result)).catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  } else {
    console.warn("[Daily Scrum] Unknown action:", message.action);
    sendResponse({ success: false, error: "Unknown action" });
  }
  return true;
});
async function handleGoogleApiRequest(payload) {
  try {
    const { apiType, documentId } = payload;
    let token = await getAccessToken();
    if (!token) {
      token = await authorizeGoogleWorkspace();
    }
    switch (apiType) {
      case "docs":
        const docText = await getDocumentText(documentId);
        return {
          documentId,
          text: docText,
          type: "docs"
        };
      case "sheets":
        const spreadsheet = await getSpreadsheet(documentId);
        return {
          documentId,
          title: spreadsheet.properties?.title,
          sheets: spreadsheet.sheets?.map((s) => s.properties?.title),
          type: "sheets"
        };
      case "slides":
        const presentation = await getPresentationText(documentId);
        return {
          documentId,
          slides: presentation.slides,
          fullText: presentation.fullText,
          type: "slides"
        };
      default:
        throw new Error(`Unknown API type: ${apiType}`);
    }
  } catch (error) {
    console.error("[Daily Scrum] Google API request error:", error);
    throw error;
  }
}
async function handleStartCollection() {
  const startTime = Date.now();
  await chrome.storage.local.set({
    [STORAGE_KEYS.IS_COLLECTING]: true,
    [STORAGE_KEYS.COLLECTION_START_TIME]: startTime,
    [STORAGE_KEYS.COLLECTION_STOP_TIME]: null
  });
  console.log("[Daily Scrum] \u25B6 Collection started at", new Date(startTime).toISOString());
  return { success: true, startTime };
}
async function handleStopCollection() {
  const stopTime = Date.now();
  await chrome.storage.local.set({
    [STORAGE_KEYS.IS_COLLECTING]: false,
    [STORAGE_KEYS.COLLECTION_STOP_TIME]: stopTime
  });
  console.log("[Daily Scrum] \u23F9 Collection stopped at", new Date(stopTime).toISOString());
  return { success: true, stopTime };
}
async function handleForceFlush() {
  console.log("[Daily Scrum] \u{1F504} Force flushing all tabs...");
  try {
    const tabs = await chrome.tabs.query({});
    const flushPromises = tabs.map((tab) => {
      if (!tab.id || tab.id === chrome.tabs.TAB_ID_NONE) return Promise.resolve();
      return chrome.tabs.sendMessage(tab.id, { action: "FLUSH_NOW" }).catch(() => {
      });
    });
    await Promise.all(flushPromises);
    console.log("[Daily Scrum] \u2705 FLUSH_NOW broadcast completed");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await processBatchSend();
    console.log("[Daily Scrum] \u2705 Force batch send completed");
    return { success: true };
  } catch (error) {
    console.error("[Daily Scrum] \u274C Force flush failed:", error);
    return { success: false, error: error.message };
  }
}
async function handleGetCollectionState() {
  const storage = await chrome.storage.local.get([
    STORAGE_KEYS.IS_COLLECTING,
    STORAGE_KEYS.COLLECTION_START_TIME,
    STORAGE_KEYS.COLLECTION_STOP_TIME,
    STORAGE_KEYS.LAST_GENERATED_RANGE,
    STORAGE_KEYS.SEND_QUEUE
  ]);
  return {
    success: true,
    isCollecting: storage[STORAGE_KEYS.IS_COLLECTING] || false,
    startTime: storage[STORAGE_KEYS.COLLECTION_START_TIME] || null,
    stopTime: storage[STORAGE_KEYS.COLLECTION_STOP_TIME] || null,
    lastGeneratedRange: storage[STORAGE_KEYS.LAST_GENERATED_RANGE] || null,
    queueLength: storage[STORAGE_KEYS.SEND_QUEUE]?.length || 0
  };
}
async function handleDataCaptured(payload, sender) {
  try {
    const { consentGiven, isCollecting } = await chrome.storage.local.get(["consentGiven", "isCollecting"]);
    if (consentGiven !== true) {
      return;
    }
    if (isCollecting !== true) {
      return;
    }
    const { isLoggedIn } = await chrome.storage.local.get([STORAGE_KEYS.IS_LOGGED_IN]);
    const enrichedPayload = {
      ...payload,
      tabId: sender.tab?.id,
      capturedAt: Date.now()
    };
    if (payload.source !== "interaction") {
      enrichedPayload.url = sender.tab?.url;
    }
    if (isLoggedIn) {
      if (!encryptionEngine.hasKey()) {
        console.warn("[Daily Scrum] Encryption key not derived, initializing...");
        await initializeEncryption();
      }
      const { source, type, ...dataToEncrypt } = enrichedPayload;
      const encrypted = await encryptionEngine.encrypt(dataToEncrypt);
      const ingestItem = {
        source: source || type || "unknown",
        iv: JSON.stringify(encrypted.iv),
        ciphertext: JSON.stringify(encrypted.ciphertext),
        algorithm: encrypted.algorithm,
        timestamp: encrypted.timestamp,
        metadata: {}
      };
      await addToSendQueue(ingestItem);
    } else {
      await addToTempBuffer(enrichedPayload);
    }
  } catch (error) {
    console.error("[Daily Scrum] handleDataCaptured error:", error);
  }
}
async function addToSendQueue(payload) {
  const { sendQueue = [] } = await chrome.storage.local.get([STORAGE_KEYS.SEND_QUEUE]);
  sendQueue.push(payload);
  await chrome.storage.local.set({ [STORAGE_KEYS.SEND_QUEUE]: sendQueue });
}
async function addToTempBuffer(payload) {
  try {
    await tempBuffer.add(payload);
  } catch (error) {
    console.error("[Daily Scrum] addToTempBuffer error:", error);
  }
}
async function handleTabTransition(payload, sender) {
  try {
    const { type, hostname, at } = payload;
    const tabId = sender.tab?.id;
    if (type === "leave") {
      await chrome.storage.local.set({
        [STORAGE_KEYS.LAST_TRANSITION]: {
          type: "leave",
          hostname,
          at,
          tabId
        }
      });
    } else if (type === "enter") {
      const { lastTransition } = await chrome.storage.local.get([STORAGE_KEYS.LAST_TRANSITION]);
      if (lastTransition && lastTransition.type === "leave") {
        const transition = {
          from: lastTransition.hostname,
          to: hostname,
          leftAt: lastTransition.at,
          enteredAt: at,
          gap: at - lastTransition.at,
          timestamp: at
        };
        await handleDataCaptured({
          type: "DAILY_SCRUM_CAPTURE",
          source: "interaction",
          data: transition
        }, sender);
        await chrome.storage.local.remove(STORAGE_KEYS.LAST_TRANSITION);
      } else {
      }
    }
  } catch (error) {
    console.error("[Daily Scrum] handleTabTransition error:", error);
  }
}
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    const hostname = new URL(tab.url).hostname;
    await chrome.storage.local.set({
      [STORAGE_KEYS.ACTIVE_TAB_INFO]: {
        tabId: activeInfo.tabId,
        hostname,
        activatedAt: Date.now()
      }
    });
  } catch (error) {
  }
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "batchSend") {
    await processBatchSend();
  }
});
async function processBatchSend() {
  try {
    const { sendQueue = [], isLoggedIn } = await chrome.storage.local.get([
      STORAGE_KEYS.SEND_QUEUE,
      STORAGE_KEYS.IS_LOGGED_IN
    ]);
    if (!isLoggedIn) {
      return;
    }
    if (sendQueue.length === 0) {
      return;
    }
    const success = await sendToSupabase(sendQueue);
    if (success) {
      await chrome.storage.local.set({ [STORAGE_KEYS.SEND_QUEUE]: [] });
    } else {
      console.error("[Daily Scrum] Batch send failed after retries");
    }
  } catch (error) {
    console.error("[Daily Scrum] processBatchSend error:", error);
  }
}
chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE_KEYS.IS_LOGGED_IN]) {
    const { newValue } = changes[STORAGE_KEYS.IS_LOGGED_IN];
    console.log("[Daily Scrum] Login state changed:", newValue);
    if (newValue === true) {
      await initializeEncryption();
      await flushTempBufferToQueue();
    } else {
      encryptionEngine.clearKey();
    }
  }
});
async function flushTempBufferToQueue() {
  try {
    const count = await tempBuffer.getCount();
    if (count === 0) {
      return;
    }
    if (!encryptionEngine.hasKey()) {
      await initializeEncryption();
    }
    await tempBuffer.flushToServer(async (dataArray) => {
      const { sendQueue = [] } = await chrome.storage.local.get([STORAGE_KEYS.SEND_QUEUE]);
      const encryptedItems = [];
      for (const item of dataArray) {
        try {
          const { source, type, ...dataToEncrypt } = item;
          const encrypted = await encryptionEngine.encrypt(dataToEncrypt);
          const ingestItem = {
            source: source || type || "unknown",
            iv: JSON.stringify(encrypted.iv),
            // number[] → string
            ciphertext: JSON.stringify(encrypted.ciphertext),
            // number[] → string
            algorithm: encrypted.algorithm,
            timestamp: encrypted.timestamp,
            metadata: {}
          };
          encryptedItems.push(ingestItem);
        } catch (err) {
          console.error("[Daily Scrum] Failed to encrypt temp buffer item:", err);
        }
      }
      const mergedQueue = [...sendQueue, ...encryptedItems];
      await chrome.storage.local.set({ [STORAGE_KEYS.SEND_QUEUE]: mergedQueue });
    });
  } catch (error) {
    console.error("[Daily Scrum] flushTempBufferToQueue error:", error);
  }
}
async function getLoginState() {
  const { isLoggedIn, userId } = await chrome.storage.local.get([
    STORAGE_KEYS.IS_LOGGED_IN,
    STORAGE_KEYS.USER_ID
  ]);
  return { isLoggedIn: isLoggedIn || false, userId: userId || null };
}
async function setLoginState(isLoggedIn, userId = null) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.IS_LOGGED_IN]: isLoggedIn,
    [STORAGE_KEYS.USER_ID]: userId
  });
}
async function initializeEncryption() {
  try {
    const { userId, serverSalt, authToken } = await chrome.storage.local.get([
      STORAGE_KEYS.USER_ID,
      STORAGE_KEYS.SERVER_SALT,
      STORAGE_KEYS.AUTH_TOKEN
    ]);
    if (!userId) {
      throw new Error("User ID not found in storage");
    }
    let salt = serverSalt;
    let saltWasGenerated = false;
    if (!salt) {
      if (!authToken) {
        throw new Error("Cannot initialize encryption without auth token");
      }
      try {
        const existingSalt = await fetchSaltFromSupabase(userId, authToken);
        if (existingSalt) {
          salt = existingSalt;
          await chrome.storage.local.set({ [STORAGE_KEYS.SERVER_SALT]: salt });
          console.log("[Daily Scrum] \u2705 Downloaded existing salt from server (multi-device sync)");
        } else {
          salt = await generateServerSalt();
          saltWasGenerated = true;
          await chrome.storage.local.set({ [STORAGE_KEYS.SERVER_SALT]: salt });
          console.log("[Daily Scrum] \u2705 Generated new server salt (first login)");
        }
      } catch (error) {
        console.error("[Daily Scrum] \u274C Failed to fetch salt from server:", error.message);
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon-48.png",
          title: "Daily Scrum Connection Required",
          message: "Cannot verify encryption settings. Please check your internet connection and try again.",
          priority: 2
        });
        throw new Error("Cannot initialize encryption: server salt verification failed. This prevents data corruption.");
      }
    }
    await encryptionEngine.deriveKey(userId, salt);
    console.log("[Daily Scrum] \u2705 Encryption initialized");
    if (saltWasGenerated && authToken) {
      try {
        await saveSaltToSupabaseWithRetry(userId, salt, authToken);
        console.log("[Daily Scrum] \u2705 Salt saved to Supabase");
      } catch (error) {
        console.error("[Daily Scrum] \u274C Failed to save salt to Supabase after retries:", error);
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon-48.png",
          title: "Daily Scrum Setup Failed",
          message: "Cannot connect to server. Please check your internet connection and try logging in again.",
          priority: 2
        });
        encryptionEngine.clearKey();
        await chrome.storage.local.remove(STORAGE_KEYS.SERVER_SALT);
        throw new Error("Failed to save encryption salt - cannot proceed without server synchronization");
      }
    }
  } catch (error) {
    console.error("[Daily Scrum] \u274C Failed to initialize encryption:", error);
    throw error;
  }
}
async function saveSaltToSupabaseWithRetry(userId, salt, authToken) {
  const maxAttempts = 3;
  const baseBackoffMs = 1e3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/user_encryption_salts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${authToken}`,
          "apikey": SUPABASE_ANON_KEY,
          "Prefer": "resolution=ignore-duplicates"
          // 이미 있으면 무시
        },
        body: JSON.stringify({
          user_id: userId,
          salt
        })
      });
      if (response.ok || response.status === 409) {
        return;
      }
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    } catch (error) {
      console.error(`[Daily Scrum] Salt save attempt ${attempt}/${maxAttempts} failed:`, error.message);
      if (attempt >= maxAttempts) {
        throw new Error(`Failed to save salt after ${maxAttempts} attempts: ${error.message}`);
      }
      const backoffMs = baseBackoffMs * Math.pow(2, attempt - 1);
      console.log(`[Daily Scrum] Retrying in ${backoffMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}
async function fetchSaltFromSupabase(userId, authToken) {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/user_encryption_salts?user_id=eq.${userId}&select=salt`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${authToken}`,
          "apikey": SUPABASE_ANON_KEY
        }
      }
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    if (data && data.length > 0 && data[0].salt) {
      return data[0].salt;
    }
    return null;
  } catch (error) {
    console.error("[Daily Scrum] Failed to fetch salt from server:", error.message);
    throw error;
  }
}
async function generateServerSalt() {
  return crypto.randomUUID() + crypto.randomUUID();
}
async function sendToSupabase(encryptedItems) {
  const endpoint = `${SUPABASE_URL}/functions/v1/ingest-data`;
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const stored = await chrome.storage.local.get(["authToken"]);
      if (!stored.authToken) {
        console.error("[Daily Scrum] \u274C No auth token in storage");
        return false;
      }
      const payload = { items: encryptedItems };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${stored.authToken}`
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.error("[Daily Scrum] - Error response:", errorText);
        if (response.status === 401) {
          const newToken = await refreshAuthToken();
          if (newToken) {
            const retryResponse = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${newToken}`
              },
              body: JSON.stringify(payload)
            });
            if (retryResponse.ok) {
              return true;
            }
            const retryErrorText = await retryResponse.text();
            throw new Error(`HTTP ${retryResponse.status} after token refresh: ${retryErrorText}`);
          }
        }
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      return true;
    } catch (error) {
      console.error(`[Daily Scrum] Send attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS} failed:`, error.message);
      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }
  console.error("[Daily Scrum] Failed to send data after", MAX_RETRY_ATTEMPTS, "attempts");
  return false;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export {
  getLoginState,
  setLoginState
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vbGliL3RlbXAtYnVmZmVyLmpzIiwgIi4uL2xpYi9lbmNyeXB0aW9uLmpzIiwgIi4uL2xpYi9jb25maWcuanMiLCAiLi4vbGliL2dvb2dsZS1hcGktY2xpZW50LmpzIiwgIi4uL2JhY2tncm91bmQuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVGVtcEJ1ZmZlciAtIEluZGV4ZWREQiBcdUFFMzBcdUJDMTggXHVDNzg0XHVDMkRDIFx1QkM4NFx1RDM3Q1xuICpcbiAqIFx1QkU0NFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMwQzFcdUQwRENcdUM1RDBcdUMxMUMgXHVDMjE4XHVDOUQxXHVCNDFDIFx1QjM3MFx1Qzc3NFx1RDEzMFx1Qjk3QyBcdUM3ODRcdUMyREMgXHVDODAwXHVDN0E1XHVENTY5XHVCMkM4XHVCMkU0LlxuICogXHVCODVDXHVBREY4XHVDNzc4IFx1QzJEQyBmbHVzaFRvU2VydmVyKClcdUI4NUMgXHVDMTFDXHVCQzg0XHVDNUQwIFx1QzgwNFx1QzFBMSBcdUQ2QzQgXHVDMEFEXHVDODFDXHVCNDI5XHVCMkM4XHVCMkU0LlxuICpcbiAqIEBzZWUgcmVzZWFyY2gubWQgNC4yXHVDODA4XG4gKi9cblxuY29uc3QgREJfTkFNRSA9ICdkYWlseVNjcnVtQnVmZmVyJztcbmNvbnN0IERCX1ZFUlNJT04gPSAxO1xuY29uc3QgU1RPUkVfTkFNRSA9ICdjYXB0dXJlcyc7XG5jb25zdCBDTEVBTlVQX0FHRV9NUyA9IDMwICogNjAgKiAxMDAwOyAvLyAzMFx1QkQ4NFxuXG4vKipcbiAqIFRlbXBCdWZmZXIgXHVEMDc0XHVCNzk4XHVDMkE0XG4gKi9cbmV4cG9ydCBjbGFzcyBUZW1wQnVmZmVyIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgdGhpcy5kYiA9IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogSW5kZXhlZERCIFx1Q0QwOFx1QUUzMFx1RDY1NFxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxJREJEYXRhYmFzZT59XG4gICAqL1xuICBhc3luYyBfaW5pdERCKCkge1xuICAgIGlmICh0aGlzLmRiKSByZXR1cm4gdGhpcy5kYjtcblxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCByZXF1ZXN0ID0gaW5kZXhlZERCLm9wZW4oREJfTkFNRSwgREJfVkVSU0lPTik7XG5cbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHtcbiAgICAgICAgY29uc29sZS5lcnJvcignW1RlbXBCdWZmZXJdIEluZGV4ZWREQiBvcGVuIGVycm9yOicsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB9O1xuXG4gICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgICAgdGhpcy5kYiA9IHJlcXVlc3QucmVzdWx0O1xuICAgICAgICByZXNvbHZlKHRoaXMuZGIpO1xuICAgICAgfTtcblxuICAgICAgcmVxdWVzdC5vbnVwZ3JhZGVuZWVkZWQgPSAoZXZlbnQpID0+IHtcbiAgICAgICAgY29uc3QgZGIgPSBldmVudC50YXJnZXQucmVzdWx0O1xuXG4gICAgICAgIC8vIE9iamVjdCBTdG9yZSBcdUMwRERcdUMxMzFcbiAgICAgICAgaWYgKCFkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKFNUT1JFX05BTUUpKSB7XG4gICAgICAgICAgY29uc3Qgb2JqZWN0U3RvcmUgPSBkYi5jcmVhdGVPYmplY3RTdG9yZShTVE9SRV9OQU1FLCB7XG4gICAgICAgICAgICBrZXlQYXRoOiAnaWQnLFxuICAgICAgICAgICAgYXV0b0luY3JlbWVudDogdHJ1ZVxuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgLy8gXHVDNzc4XHVCMzcxXHVDMkE0IFx1QzBERFx1QzEzMTogdGltZXN0YW1wXHVCODVDIFx1QkU2MFx1Qjk3OCBcdUM4NzBcdUQ2OEMvXHVDODE1XHVCOUFDXG4gICAgICAgICAgb2JqZWN0U3RvcmUuY3JlYXRlSW5kZXgoJ3RpbWVzdGFtcCcsICd0aW1lc3RhbXAnLCB7IHVuaXF1ZTogZmFsc2UgfSk7XG5cbiAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgcmVxdWVzdC5vbmJsb2NrZWQgPSAoKSA9PiB7XG4gICAgICAgIGNvbnNvbGUud2FybignW1RlbXBCdWZmZXJdIEluZGV4ZWREQiBibG9ja2VkIGJ5IGFub3RoZXIgY29ubmVjdGlvbicpO1xuICAgICAgICByZWplY3QobmV3IEVycm9yKCdJbmRleGVkREIgYmxvY2tlZCcpKTtcbiAgICAgIH07XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogXHVCMzcwXHVDNzc0XHVEMTMwIFx1Q0Q5NFx1QUMwMFxuICAgKiBAcGFyYW0ge09iamVjdH0gZGF0YSAtIFx1QzgwMFx1QzdBNVx1RDU2MCBcdUIzNzBcdUM3NzRcdUQxMzBcbiAgICogQHJldHVybnMge1Byb21pc2U8bnVtYmVyPn0gLSBcdUNEOTRcdUFDMDBcdUI0MUMgXHVENTZEXHVCQUE5XHVDNzU4IElEXG4gICAqL1xuICBhc3luYyBhZGQoZGF0YSkge1xuICAgIHRyeSB7XG4gICAgICAvLyBcdUJBM0NcdUM4MDAgXHVDNjI0XHVCNzk4XHVCNDFDIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUM4MTVcdUI5QUNcbiAgICAgIGF3YWl0IHRoaXMuY2xlYW51cCgpO1xuXG4gICAgICBjb25zdCBkYiA9IGF3YWl0IHRoaXMuX2luaXREQigpO1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihbU1RPUkVfTkFNRV0sICdyZWFkd3JpdGUnKTtcbiAgICAgIGNvbnN0IHN0b3JlID0gdHJhbnNhY3Rpb24ub2JqZWN0U3RvcmUoU1RPUkVfTkFNRSk7XG5cbiAgICAgIC8vIHRpbWVzdGFtcCBcdUNEOTRcdUFDMDBcbiAgICAgIGNvbnN0IHJlY29yZCA9IHtcbiAgICAgICAgLi4uZGF0YSxcbiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpXG4gICAgICB9O1xuXG4gICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUuYWRkKHJlY29yZCk7XG5cbiAgICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgICAgcmVzb2x2ZShyZXF1ZXN0LnJlc3VsdCk7XG4gICAgICAgIH07XG5cbiAgICAgICAgcmVxdWVzdC5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBBZGQgZXJyb3I6JywgcmVxdWVzdC5lcnJvcik7XG4gICAgICAgICAgcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICB9O1xuXG4gICAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiB7XG4gICAgICAgIH07XG5cbiAgICAgICAgdHJhbnNhY3Rpb24ub25lcnJvciA9ICgpID0+IHtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gQWRkIHRyYW5zYWN0aW9uIGVycm9yOicsIHRyYW5zYWN0aW9uLmVycm9yKTtcbiAgICAgICAgICByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IpO1xuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBhZGQoKSBlcnJvcjonLCBlcnJvcik7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogMzBcdUJEODQgXHVDNzc0XHVDMEMxIFx1QjQxQyBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDMEFEXHVDODFDXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPG51bWJlcj59IC0gXHVDMEFEXHVDODFDXHVCNDFDIFx1RDU2RFx1QkFBOSBcdUMyMThcbiAgICovXG4gIGFzeW5jIGNsZWFudXAoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRiID0gYXdhaXQgdGhpcy5faW5pdERCKCk7XG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKFtTVE9SRV9OQU1FXSwgJ3JlYWR3cml0ZScpO1xuICAgICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShTVE9SRV9OQU1FKTtcbiAgICAgIGNvbnN0IGluZGV4ID0gc3RvcmUuaW5kZXgoJ3RpbWVzdGFtcCcpO1xuXG4gICAgICBjb25zdCBjdXRvZmZUaW1lID0gRGF0ZS5ub3coKSAtIENMRUFOVVBfQUdFX01TO1xuICAgICAgY29uc3QgcmFuZ2UgPSBJREJLZXlSYW5nZS51cHBlckJvdW5kKGN1dG9mZlRpbWUpO1xuXG4gICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBsZXQgZGVsZXRlZENvdW50ID0gMDtcbiAgICAgICAgY29uc3QgY3Vyc29yUmVxdWVzdCA9IGluZGV4Lm9wZW5DdXJzb3IocmFuZ2UpO1xuXG4gICAgICAgIGN1cnNvclJlcXVlc3Qub25zdWNjZXNzID0gKGV2ZW50KSA9PiB7XG4gICAgICAgICAgY29uc3QgY3Vyc29yID0gZXZlbnQudGFyZ2V0LnJlc3VsdDtcbiAgICAgICAgICBpZiAoY3Vyc29yKSB7XG4gICAgICAgICAgICBjdXJzb3IuZGVsZXRlKCk7XG4gICAgICAgICAgICBkZWxldGVkQ291bnQrKztcbiAgICAgICAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgfTtcblxuICAgICAgICBjdXJzb3JSZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcignW1RlbXBCdWZmZXJdIENsZWFudXAgY3Vyc29yIGVycm9yOicsIGN1cnNvclJlcXVlc3QuZXJyb3IpO1xuICAgICAgICAgIHJlamVjdChjdXJzb3JSZXF1ZXN0LmVycm9yKTtcbiAgICAgICAgfTtcblxuICAgICAgICB0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4ge1xuICAgICAgICAgIGlmIChkZWxldGVkQ291bnQgPiAwKSB7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJlc29sdmUoZGVsZXRlZENvdW50KTtcbiAgICAgICAgfTtcblxuICAgICAgICB0cmFuc2FjdGlvbi5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBDbGVhbnVwIHRyYW5zYWN0aW9uIGVycm9yOicsIHRyYW5zYWN0aW9uLmVycm9yKTtcbiAgICAgICAgICByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IpO1xuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBjbGVhbnVwKCkgZXJyb3I6JywgZXJyb3IpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFx1QzgwNFx1Q0NCNCBcdUIzNzBcdUM3NzRcdUQxMzBcdUI5N0MgXHVDMTFDXHVCQzg0XHVCODVDIGZsdXNoXG4gICAqIEBwYXJhbSB7RnVuY3Rpb259IGVuY3J5cHRBbmRTZW5kIC0gXHVDNTU0XHVENjM4XHVENjU0IFx1QkMwRiBcdUM4MDRcdUMxQTEgXHVDRjVDXHVCQzMxOiBhc3luYyAoZGF0YSkgPT4gdm9pZFxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxudW1iZXI+fSAtIFx1QzgwNFx1QzFBMVx1QjQxQyBcdUQ1NkRcdUJBQTkgXHVDMjE4XG4gICAqL1xuICBhc3luYyBmbHVzaFRvU2VydmVyKGVuY3J5cHRBbmRTZW5kKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRiID0gYXdhaXQgdGhpcy5faW5pdERCKCk7XG5cbiAgICAgIC8vIDEuIFx1QkFBOFx1QjRFMCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDNzdEXHVBRTMwXG4gICAgICBjb25zdCBhbGxEYXRhID0gYXdhaXQgdGhpcy5fZ2V0QWxsRGF0YShkYik7XG5cbiAgICAgIGlmIChhbGxEYXRhLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXR1cm4gMDtcbiAgICAgIH1cblxuXG4gICAgICAvLyAyLiBcdUNGNUNcdUJDMzFcdUM1RDAgXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzgwNFx1QjJFQyAoXHVDNTU0XHVENjM4XHVENjU0IFx1QkMwRiBcdUM4MDRcdUMxQTEpXG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBlbmNyeXB0QW5kU2VuZChhbGxEYXRhKTtcbiAgICAgIH0gY2F0Y2ggKHNlbmRFcnJvcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gZW5jcnlwdEFuZFNlbmQgY2FsbGJhY2sgZXJyb3I6Jywgc2VuZEVycm9yKTtcbiAgICAgICAgdGhyb3cgc2VuZEVycm9yO1xuICAgICAgfVxuXG4gICAgICAvLyAzLiBcdUM4MDRcdUMxQTEgXHVDMTMxXHVBQ0Y1IFx1QzJEQyBcdUJBQThcdUI0RTAgXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzBBRFx1QzgxQ1xuICAgICAgYXdhaXQgdGhpcy5fY2xlYXJBbGwoZGIpO1xuXG4gICAgICByZXR1cm4gYWxsRGF0YS5sZW5ndGg7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBmbHVzaFRvU2VydmVyKCkgZXJyb3I6JywgZXJyb3IpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFx1QkFBOFx1QjRFMCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDNzdEXHVBRTMwIChcdUIwQjRcdUJEODAgXHVENUVDXHVEMzdDKVxuICAgKiBAcGFyYW0ge0lEQkRhdGFiYXNlfSBkYlxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxBcnJheT59XG4gICAqL1xuICBhc3luYyBfZ2V0QWxsRGF0YShkYikge1xuICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oW1NUT1JFX05BTUVdLCAncmVhZG9ubHknKTtcbiAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKFNUT1JFX05BTUUpO1xuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5nZXRBbGwoKTtcblxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgIHJlc29sdmUocmVxdWVzdC5yZXN1bHQpO1xuICAgICAgfTtcblxuICAgICAgcmVxdWVzdC5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gZ2V0QWxsIGVycm9yOicsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB9O1xuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFx1QkFBOFx1QjRFMCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDMEFEXHVDODFDIChcdUIwQjRcdUJEODAgXHVENUVDXHVEMzdDKVxuICAgKiBAcGFyYW0ge0lEQkRhdGFiYXNlfSBkYlxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTx2b2lkPn1cbiAgICovXG4gIGFzeW5jIF9jbGVhckFsbChkYikge1xuICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oW1NUT1JFX05BTUVdLCAncmVhZHdyaXRlJyk7XG4gICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShTVE9SRV9OQU1FKTtcblxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUuY2xlYXIoKTtcblxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH07XG5cbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHtcbiAgICAgICAgY29uc29sZS5lcnJvcignW1RlbXBCdWZmZXJdIGNsZWFyIGVycm9yOicsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB9O1xuXG4gICAgICB0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4ge1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9O1xuXG4gICAgICB0cmFuc2FjdGlvbi5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gQ2xlYXIgdHJhbnNhY3Rpb24gZXJyb3I6JywgdHJhbnNhY3Rpb24uZXJyb3IpO1xuICAgICAgICByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IpO1xuICAgICAgfTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBcdUM4MDBcdUM3QTVcdUI0MUMgXHVENTZEXHVCQUE5IFx1QzIxOCBcdUM4NzBcdUQ2OEMgKFx1RDMxRFx1QzVDNSBcdUMwQzFcdUQwREMgXHVENDVDXHVDMkRDXHVDNkE5KVxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxudW1iZXI+fVxuICAgKi9cbiAgYXN5bmMgZ2V0Q291bnQoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRiID0gYXdhaXQgdGhpcy5faW5pdERCKCk7XG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKFtTVE9SRV9OQU1FXSwgJ3JlYWRvbmx5Jyk7XG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKFNUT1JFX05BTUUpO1xuXG4gICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUuY291bnQoKTtcblxuICAgICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgICAgICByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcbiAgICAgICAgfTtcblxuICAgICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcignW1RlbXBCdWZmZXJdIGNvdW50IGVycm9yOicsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICAgIHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gZ2V0Q291bnQoKSBlcnJvcjonLCBlcnJvcik7XG4gICAgICByZXR1cm4gMDsgLy8gXHVDNUQwXHVCN0VDIFx1QzJEQyAwIFx1QkMxOFx1RDY1OCAoVUlcdUFDMDAgXHVBRTY4XHVDOUMwXHVDOUMwIFx1QzU0QVx1QjNDNFx1Qjg1RClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogSW5kZXhlZERCIFx1QzVGMFx1QUNCMCBcdUIyRUJcdUFFMzBcbiAgICovXG4gIGNsb3NlKCkge1xuICAgIGlmICh0aGlzLmRiKSB7XG4gICAgICB0aGlzLmRiLmNsb3NlKCk7XG4gICAgICB0aGlzLmRiID0gbnVsbDtcbiAgICB9XG4gIH1cbn1cblxuLy8gXHVDMkYxXHVBRTAwXHVEMUE0IFx1Qzc3OFx1QzJBNFx1RDEzNFx1QzJBNCBleHBvcnRcbmV4cG9ydCBjb25zdCB0ZW1wQnVmZmVyID0gbmV3IFRlbXBCdWZmZXIoKTtcbiIsICIvKipcbiAqIEVuY3J5cHRpb24gRW5naW5lIGZvciBEYWlseSBTY3J1bSBFeHRlbnNpb25cbiAqXG4gKiBcdUJDRjRcdUM1NDggXHVCQUE4XHVCMzc4OiBUcmFuc2l0IEVuY3J5cHRpb24gKEUyRSBcdUM1NDRcdUIyRDgpXG4gKiAtIFx1QzExQ1x1QkM4NFx1QUMwMCB1c2VySWQgKyBzZXJ2ZXJTYWx0XHVCODVDIFx1RDBBNCBcdUM3QUNcdUQzMENcdUMwREQgXHVBQzAwXHVCMkE1XG4gKiAtIFx1QjEyNFx1RDJCOFx1QzZDQ1x1RDA2QyBcdUM4MDRcdUMxQTEgXHVDOTExIFx1QjNDNFx1Q0NBRCBcdUJDMjlcdUM5QzAgXHVCQUE5XHVDODAxXG4gKlxuICogQHNlZSBkb2NzL3Jlc2VhcmNoLm1kIDVcdUM4MDhcbiAqL1xuXG4vKipcbiAqIEFFUy1HQ00tMjU2IFx1QzU1NFx1RDYzOFx1RDY1NCBcdUM1RDRcdUM5QzRcbiAqXG4gKiBcdUQwQTQgXHVEMzBDXHVDMEREOiBQQktERjIgKFNIQS0yNTYsIDEwMCwwMDAgaXRlcmF0aW9ucylcbiAqIFx1QzU1NFx1RDYzOFx1RDY1NDogQUVTLUdDTS0yNTYgKFx1Qzc3OFx1Qzk5RFx1QjQxQyBcdUM1NTRcdUQ2MzhcdUQ2NTQpXG4gKiBJVjogMTJcdUJDMTRcdUM3NzRcdUQyQjggKDk2XHVCRTQ0XHVEMkI4KSBcdUI3OUNcdUIzNjQgXHVDMEREXHVDMTMxXG4gKlxuICogQGNsYXNzXG4gKi9cbmV4cG9ydCBjbGFzcyBFbmNyeXB0aW9uRW5naW5lIHtcbiAgLyoqXG4gICAqIEBwcml2YXRlXG4gICAqIEB0eXBlIHtDcnlwdG9LZXl8bnVsbH1cbiAgICovXG4gICNrZXkgPSBudWxsO1xuXG4gIC8qKlxuICAgKiBQQktERjIgaXRlcmF0aW9uIGNvdW50XG4gICAqIEBwcml2YXRlXG4gICAqIEBjb25zdGFudCB7bnVtYmVyfVxuICAgKi9cbiAgc3RhdGljICNQQktERjJfSVRFUkFUSU9OUyA9IDMwMDAwMDsgIC8vIFx1QURFMFx1RDYxNVx1QzdBMVx1RDc4QyBcdUJDRjRcdUM1NDgvXHVDMTMxXHVCMkE1IChPV0FTUCAyMDI2IFx1QUQ4Q1x1QzdBNTogNjAwLDAwMCspXG5cbiAgLyoqXG4gICAqIEFFUy1HQ00gSVYgbGVuZ3RoIChieXRlcylcbiAgICogQHByaXZhdGVcbiAgICogQGNvbnN0YW50IHtudW1iZXJ9XG4gICAqL1xuICBzdGF0aWMgI0lWX0xFTkdUSCA9IDEyOyAgLy8gOTYgYml0cyAoXHVENDVDXHVDOTAwIFx1QUQ4Q1x1QzdBNSlcblxuICAvKipcbiAgICogTWF4aW11bSBjaXBoZXJ0ZXh0IHNpemUgKGJ5dGVzKSAtIERvUyBcdUJDMjlcdUM5QzBcbiAgICogQHByaXZhdGVcbiAgICogQGNvbnN0YW50IHtudW1iZXJ9XG4gICAqL1xuICBzdGF0aWMgI01BWF9DSVBIRVJURVhUX1NJWkUgPSAxMCAqIDEwMjQgKiAxMDI0OyAgLy8gMTBNQlxuXG4gIC8qKlxuICAgKiBcdUM1NTRcdUQ2MzhcdUQ2NTQgXHVEMEE0IFx1RDMwQ1x1QzBERFxuICAgKlxuICAgKiBcdTI2QTBcdUZFMEYgXHVCQ0Y0XHVDNTQ4IFx1QUNCRFx1QUNFMDogdXNlcklkXHVCMjk0IFx1QzYwOFx1Q0UyMSBcdUFDMDBcdUIyQTVcdUQ1NThcdUJCQzBcdUI4NUMgXHVDOUM0XHVDODE1XHVENTVDIEUyRVx1QUMwMCBcdUM1NDRcdUIyRDhcbiAgICogXHVDMTFDXHVCQzg0XHVBQzAwIHVzZXJJZCArIHNlcnZlclNhbHRcdUI4NUMgXHVCM0Q5XHVDNzdDXHVENTVDIFx1RDBBNFx1Qjk3QyBcdUM3QUNcdUFENkNcdUMxMzFcdUQ1NjAgXHVDMjE4IFx1Qzc4OFx1Qzc0Q1xuICAgKlxuICAgKiBAcGFyYW0ge3N0cmluZ30gdXNlcklkIC0gU3VwYWJhc2UgdXNlciBJRCAoVVVJRClcbiAgICogQHBhcmFtIHtzdHJpbmd9IHNlcnZlclNhbHQgLSBcdUMxMUNcdUJDODRcdUM1RDBcdUMxMUMgXHVDODFDXHVBQ0Y1XHVENTVDIHNhbHRcbiAgICogQHRocm93cyB7RXJyb3J9IHVzZXJJZCBcdUI2MTBcdUIyOTQgc2VydmVyU2FsdFx1QUMwMCBcdUJFNDRcdUM1QjRcdUM3ODhcdUM3NDQgXHVBQ0JEXHVDNkIwXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fVxuICAgKi9cbiAgYXN5bmMgZGVyaXZlS2V5KHVzZXJJZCwgc2VydmVyU2FsdCkge1xuICAgIGlmICghdXNlcklkIHx8ICFzZXJ2ZXJTYWx0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ3VzZXJJZCBhbmQgc2VydmVyU2FsdCBhcmUgcmVxdWlyZWQnKTtcbiAgICB9XG5cbiAgICBjb25zdCBlbmMgPSBuZXcgVGV4dEVuY29kZXIoKTtcblxuICAgIC8vIDEuIEtleSBtYXRlcmlhbCBcdUMwRERcdUMxMzEgKHVzZXJJZCBcdUFFMzBcdUJDMTgpXG4gICAgY29uc3Qga2V5TWF0ZXJpYWwgPSBhd2FpdCBjcnlwdG8uc3VidGxlLmltcG9ydEtleShcbiAgICAgICdyYXcnLFxuICAgICAgZW5jLmVuY29kZSh1c2VySWQpLFxuICAgICAgJ1BCS0RGMicsXG4gICAgICBmYWxzZSwgIC8vIGV4dHJhY3RhYmxlOiBmYWxzZVxuICAgICAgWydkZXJpdmVLZXknXVxuICAgICk7XG5cbiAgICAvLyAyLiBQQktERjJcdUI4NUMgQUVTLUdDTSBcdUQwQTQgXHVEMzBDXHVDMEREXG4gICAgdGhpcy4ja2V5ID0gYXdhaXQgY3J5cHRvLnN1YnRsZS5kZXJpdmVLZXkoXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdQQktERjInLFxuICAgICAgICBzYWx0OiBlbmMuZW5jb2RlKHNlcnZlclNhbHQpLFxuICAgICAgICBpdGVyYXRpb25zOiBFbmNyeXB0aW9uRW5naW5lLiNQQktERjJfSVRFUkFUSU9OUyxcbiAgICAgICAgaGFzaDogJ1NIQS0yNTYnXG4gICAgICB9LFxuICAgICAga2V5TWF0ZXJpYWwsXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdBRVMtR0NNJyxcbiAgICAgICAgbGVuZ3RoOiAyNTYgIC8vIDI1Ni1iaXQga2V5XG4gICAgICB9LFxuICAgICAgZmFsc2UsICAvLyBleHRyYWN0YWJsZTogZmFsc2UgKFx1RDBBNFx1Qjk3QyBcdUJBNTRcdUJBQThcdUI5QUNcdUM1RDBcdUMxMUMgXHVDRDk0XHVDRDlDIFx1QkQ4OFx1QUMwMClcbiAgICAgIFsnZW5jcnlwdCcsICdkZWNyeXB0J11cbiAgICApO1xuXG4gICAgLy8gXHVBQzFDXHVCQzFDIFx1RDY1OFx1QUNCRFx1QzVEMFx1QzExQ1x1QjlDQyBcdUI4NUNcdUFFNDUgKFx1RDUwNFx1Qjg1Q1x1QjM1NVx1QzE1OCBcdUQwQTQgXHVCMTc4XHVDRDlDIFx1QkMyOVx1QzlDMClcbiAgICBpZiAodHlwZW9mIHByb2Nlc3MgIT09ICd1bmRlZmluZWQnICYmIHByb2Nlc3MuZW52Py5OT0RFX0VOViA9PT0gJ2RldmVsb3BtZW50Jykge1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDNTU0XHVENjM4XHVENjU0XG4gICAqXG4gICAqIEBwYXJhbSB7YW55fSBkYXRhIC0gXHVDNTU0XHVENjM4XHVENjU0XHVENTYwIFx1QjM3MFx1Qzc3NFx1RDEzMCAoSlNPTiBcdUM5QzFcdUI4MkNcdUQ2NTQgXHVBQzAwXHVCMkE1XHVENTc0XHVDNTdDIFx1RDU2OClcbiAgICogQHRocm93cyB7RXJyb3J9IFx1RDBBNFx1QUMwMCBcdUQzMENcdUMwRERcdUI0MThcdUM5QzAgXHVDNTRBXHVDNTU4XHVBQzcwXHVCMDk4IFx1QzU1NFx1RDYzOFx1RDY1NCBcdUMyRTRcdUQzMjggXHVDMkRDXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHtpdjogbnVtYmVyW10sIGNpcGhlcnRleHQ6IG51bWJlcltdLCBhbGdvcml0aG06IHN0cmluZywgdGltZXN0YW1wOiBudW1iZXJ9Pn1cbiAgICovXG4gIGFzeW5jIGVuY3J5cHQoZGF0YSkge1xuICAgIGlmICghdGhpcy4ja2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0VuY3J5cHRpb24ga2V5IG5vdCBkZXJpdmVkLiBDYWxsIGRlcml2ZUtleSgpIGZpcnN0LicpO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICAvLyAxLiBcdUI3OUNcdUIzNjQgSVYgXHVDMEREXHVDMTMxICgxMlx1QkMxNFx1Qzc3NFx1RDJCOCwgOTZcdUJFNDRcdUQyQjgpXG4gICAgICBjb25zdCBpdiA9IGNyeXB0by5nZXRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkoRW5jcnlwdGlvbkVuZ2luZS4jSVZfTEVOR1RIKSk7XG5cbiAgICAgIC8vIDIuIFx1QjM3MFx1Qzc3NFx1RDEzMCBKU09OIFx1QzlDMVx1QjgyQ1x1RDY1NFxuICAgICAgY29uc3QgcGxhaW50ZXh0ID0gSlNPTi5zdHJpbmdpZnkoZGF0YSk7XG4gICAgICBjb25zdCBwbGFpbnRleHRCdWZmZXIgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUocGxhaW50ZXh0KTtcblxuICAgICAgLy8gMy4gQUVTLUdDTSBcdUM1NTRcdUQ2MzhcdUQ2NTRcbiAgICAgIGNvbnN0IGNpcGhlcnRleHRCdWZmZXIgPSBhd2FpdCBjcnlwdG8uc3VidGxlLmVuY3J5cHQoXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnQUVTLUdDTScsXG4gICAgICAgICAgaXY6IGl2XG4gICAgICAgIH0sXG4gICAgICAgIHRoaXMuI2tleSxcbiAgICAgICAgcGxhaW50ZXh0QnVmZmVyXG4gICAgICApO1xuXG4gICAgICAvLyA0LiBcdUNEOUNcdUI4MjUgXHVENjE1XHVDMkREIFx1QkNDMFx1RDY1OCAoVWludDhBcnJheSBcdTIxOTIgbnVtYmVyW10pXG4gICAgICByZXR1cm4ge1xuICAgICAgICBpdjogQXJyYXkuZnJvbShpdiksXG4gICAgICAgIGNpcGhlcnRleHQ6IEFycmF5LmZyb20obmV3IFVpbnQ4QXJyYXkoY2lwaGVydGV4dEJ1ZmZlcikpLFxuICAgICAgICBhbGdvcml0aG06ICdBRVMtR0NNLTI1NicsXG4gICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKVxuICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgLy8gXHVEMEMwXHVDNzc0XHVCQzBEIFx1QUNGNVx1QUNBOSBcdUJDMjlcdUM5QzA6IFx1QzVEMFx1QjdFQyBcdUFDMURcdUNDQjQgXHVCODVDXHVBRTQ1IFx1QUUwOFx1QzlDMFxuICAgICAgY29uc29sZS5lcnJvcignW0VuY3J5cHRpb25dIEVuY3J5cHRpb24gZmFpbGVkJyk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0VuY3J5cHRpb24gZmFpbGVkJyk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUJDRjVcdUQ2MzhcdUQ2NTRcbiAgICpcbiAgICogXHVEMEMwXHVDNzc0XHVCQzBEIFx1QUNGNVx1QUNBOSBcdUJDMjlcdUM5QzA6IFx1QkFBOFx1QjRFMCBcdUM1RDBcdUI3RUNcdUI5N0MgXHVCM0Q5XHVDNzdDXHVENTVDIFx1QkE1NFx1QzJEQ1x1QzlDMFx1Qjg1QyBcdUJDMThcdUQ2NThcbiAgICpcbiAgICogQHBhcmFtIHt7aXY6IG51bWJlcltdLCBjaXBoZXJ0ZXh0OiBudW1iZXJbXSwgYWxnb3JpdGhtOiBzdHJpbmd9fSBlbmNyeXB0ZWREYXRhXG4gICAqIEB0aHJvd3Mge0Vycm9yfSBcdUQwQTRcdUFDMDAgXHVEMzBDXHVDMEREXHVCNDE4XHVDOUMwIFx1QzU0QVx1QzU1OFx1QUM3MFx1QjA5OCBcdUJDRjVcdUQ2MzhcdUQ2NTQgXHVDMkU0XHVEMzI4IFx1QzJEQ1xuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxhbnk+fSBcdUJDRjVcdUQ2MzhcdUQ2NTRcdUI0MUMgXHVDNkQwXHVCQ0Y4IFx1QjM3MFx1Qzc3NFx1RDEzMFxuICAgKi9cbiAgYXN5bmMgZGVjcnlwdChlbmNyeXB0ZWREYXRhKSB7XG4gICAgaWYgKCF0aGlzLiNrZXkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignRW5jcnlwdGlvbiBrZXkgbm90IGRlcml2ZWQuIENhbGwgZGVyaXZlS2V5KCkgZmlyc3QuJyk7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIC8vIDEuIFx1Qzc4NVx1QjgyNSBcdUFDODBcdUM5OURcbiAgICAgIGlmICghZW5jcnlwdGVkRGF0YS5pdiB8fCAhZW5jcnlwdGVkRGF0YS5jaXBoZXJ0ZXh0KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBlbmNyeXB0ZWQgZGF0YSBmb3JtYXQnKTtcbiAgICAgIH1cblxuICAgICAgLy8gSVYgXHVBRTM4XHVDNzc0IFx1QUM4MFx1Qzk5RCAobWFsZm9ybWVkIGRhdGEgXHVBQ0Y1XHVBQ0E5IFx1QkMyOVx1QzlDMClcbiAgICAgIGlmIChlbmNyeXB0ZWREYXRhLml2Lmxlbmd0aCAhPT0gRW5jcnlwdGlvbkVuZ2luZS4jSVZfTEVOR1RIKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBlbmNyeXB0ZWQgZGF0YSBmb3JtYXQnKTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2lwaGVydGV4dCBcdUQwNkNcdUFFMzAgXHVDODFDXHVENTVDIChEb1MgdmlhIG1lbW9yeSBleGhhdXN0aW9uIFx1QkMyOVx1QzlDMClcbiAgICAgIGlmIChlbmNyeXB0ZWREYXRhLmNpcGhlcnRleHQubGVuZ3RoID4gRW5jcnlwdGlvbkVuZ2luZS4jTUFYX0NJUEhFUlRFWFRfU0laRSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgZW5jcnlwdGVkIGRhdGEgZm9ybWF0Jyk7XG4gICAgICB9XG5cbiAgICAgIC8vIDIuIG51bWJlcltdIFx1MjE5MiBVaW50OEFycmF5IFx1QkNDMFx1RDY1OFxuICAgICAgY29uc3QgaXYgPSBuZXcgVWludDhBcnJheShlbmNyeXB0ZWREYXRhLml2KTtcbiAgICAgIGNvbnN0IGNpcGhlcnRleHQgPSBuZXcgVWludDhBcnJheShlbmNyeXB0ZWREYXRhLmNpcGhlcnRleHQpO1xuXG4gICAgICAvLyAzLiBBRVMtR0NNIFx1QkNGNVx1RDYzOFx1RDY1NFxuICAgICAgY29uc3QgcGxhaW50ZXh0QnVmZmVyID0gYXdhaXQgY3J5cHRvLnN1YnRsZS5kZWNyeXB0KFxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ0FFUy1HQ00nLFxuICAgICAgICAgIGl2OiBpdlxuICAgICAgICB9LFxuICAgICAgICB0aGlzLiNrZXksXG4gICAgICAgIGNpcGhlcnRleHRcbiAgICAgICk7XG5cbiAgICAgIC8vIDQuIFx1QkM4NFx1RDM3QyBcdTIxOTIgXHVCQjM4XHVDNzkwXHVDNUY0IFx1MjE5MiBKU09OIFx1RDMwQ1x1QzJGMVxuICAgICAgY29uc3QgcGxhaW50ZXh0ID0gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHBsYWludGV4dEJ1ZmZlcik7XG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShwbGFpbnRleHQpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAvLyBcdUQwQzBcdUM3NzRcdUJDMEQgXHVBQ0Y1XHVBQ0E5IFx1QkMyOVx1QzlDMDogXHVDNUQwXHVCN0VDIFx1RDBDMFx1Qzc4NSBcdUIxNzhcdUNEOUMgXHVBRTA4XHVDOUMwXG4gICAgICAvLyAoQUVTLUdDTSBcdUM3NzhcdUM5OUQgXHVDMkU0XHVEMzI4LCBKU09OIFx1RDMwQ1x1QzJGMSBcdUM1RDBcdUI3RUMgXHVCQUE4XHVCNDUwIFx1QjNEOVx1Qzc3Q1x1RDU1QyBcdUM1RDBcdUI3RUMpXG4gICAgICBjb25zb2xlLmVycm9yKCdbRW5jcnlwdGlvbl0gRGVjcnlwdGlvbiBmYWlsZWQnKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcignRGVjcnlwdGlvbiBmYWlsZWQnKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogXHVEMEE0IFx1RDMwQ1x1QzBERCBcdUM1RUNcdUJEODAgXHVENjU1XHVDNzc4XG4gICAqXG4gICAqIEByZXR1cm5zIHtib29sZWFufVxuICAgKi9cbiAgaGFzS2V5KCkge1xuICAgIHJldHVybiB0aGlzLiNrZXkgIT09IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogXHVEMEE0IFx1RDNEMFx1QUUzMCAoXHVCODVDXHVBREY4XHVDNTQ0XHVDNkMzIFx1QzJEQyBcdUQ2MzhcdUNEOUMpXG4gICAqXG4gICAqIFx1MjZBMFx1RkUwRiBcdUM4RkNcdUM3NTg6IFx1RDBBNFx1QjI5NCBleHRyYWN0YWJsZTogZmFsc2VcdUM3NzRcdUJCQzBcdUI4NUMgXHVDN0FDXHVEMzBDXHVDMEREIFx1RDU0NFx1QzY5NFxuICAgKi9cbiAgY2xlYXJLZXkoKSB7XG4gICAgdGhpcy4ja2V5ID0gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIFx1QzJGMVx1QUUwMFx1RDFBNCBcdUM3NzhcdUMyQTRcdUQxMzRcdUMyQTQgKFx1QzEyMFx1RDBERFx1QzgwMSBcdUMwQUNcdUM2QTkpXG4gKlxuICogXHVDMEFDXHVDNkE5IFx1QzYwODpcbiAqIGltcG9ydCB7IGVuY3J5cHRpb25FbmdpbmUgfSBmcm9tICcuL2xpYi9lbmNyeXB0aW9uLmpzJztcbiAqIGF3YWl0IGVuY3J5cHRpb25FbmdpbmUuZGVyaXZlS2V5KHVzZXJJZCwgc2VydmVyU2FsdCk7XG4gKiBjb25zdCBlbmNyeXB0ZWQgPSBhd2FpdCBlbmNyeXB0aW9uRW5naW5lLmVuY3J5cHQoZGF0YSk7XG4gKi9cbmV4cG9ydCBjb25zdCBlbmNyeXB0aW9uRW5naW5lID0gbmV3IEVuY3J5cHRpb25FbmdpbmUoKTtcbiIsICIvKipcbiAqIENvbmZpZ3VyYXRpb24gZm9yIERhaWx5IFNjcnVtIEV4dGVuc2lvblxuICpcbiAqIFN1cGFiYXNlIFx1RDY1OFx1QUNCRCBcdUJDQzBcdUMyMTggXHVBRDAwXHVCOUFDXG4gKiBcdUQ1MDRcdUI4NUNcdUIzNTVcdUMxNTggXHVCQzMwXHVEM0VDIFx1QzJEQyBcdUQ2NThcdUFDQkQgXHVCQ0MwXHVDMjE4XHVCODVDIFx1QzhGQ1x1Qzc4NVx1RDU1OFx1QUM3MFx1QjA5OCBcdUJDQzRcdUIzQzQgXHVDMTI0XHVDODE1IFx1RDMwQ1x1Qzc3Q1x1Qjg1QyBcdUFEMDBcdUI5QUNcbiAqXG4gKiBAc2VlIGRvY3MvcmVzZWFyY2gubWQgNC4xXHVDODA4XG4gKi9cblxuLyoqXG4gKiBTdXBhYmFzZSBcdUQ1MDRcdUI4NUNcdUM4MURcdUQyQjggVVJMXG4gKiBAY29uc3RhbnQge3N0cmluZ31cbiAqL1xuZXhwb3J0IGNvbnN0IFNVUEFCQVNFX1VSTCA9IGltcG9ydC5tZXRhLmVudj8uVklURV9TVVBBQkFTRV9VUkwgfHwgJ2h0dHBzOi8vem9xdHZyY3JxbmFhdGtkd21haWwuc3VwYWJhc2UuY28nO1xuXG5cbi8qKlxuICogU3VwYWJhc2UgQW5vbnltb3VzIEtleSAoXHVBQ0Y1XHVBQzFDIFx1QUMwMFx1QjJBNSlcbiAqIEBjb25zdGFudCB7c3RyaW5nfVxuICovXG5leHBvcnQgY29uc3QgU1VQQUJBU0VfQU5PTl9LRVkgPSBpbXBvcnQubWV0YS5lbnY/LlZJVEVfU1VQQUJBU0VfQU5PTl9LRVkgfHwgJ2V5SmhiR2NpT2lKSVV6STFOaUlzSW5SNWNDSTZJa3BYVkNKOS5leUpwYzNNaU9pSnpkWEJoWW1GelpTSXNJbkpsWmlJNklucHZjWFIyY21OeWNXNWhZWFJyWkhkdFlXbHNJaXdpY205c1pTSTZJbUZ1YjI0aUxDSnBZWFFpT2pFM05qazBNRGc1T0Rrc0ltVjRjQ0k2TWpBNE5EazRORGs0T1gwLmoyTk5DNTdqbVdQQU5qR3VmZExaYjBGUHo4bGhPZGFxOVYzMkZ2MHpacEUnO1xuXG4vLyBEZWJ1ZzogTG9nIGNvbmZpZ3VyYXRpb24gdmFsdWVzXG5cbi8qKlxuICogR29vZ2xlIE9BdXRoIFx1RDA3NFx1Qjc3Q1x1Qzc3NFx1QzVCOFx1RDJCOCBJRCAoQ2hyb21lIEV4dGVuc2lvbiBcdUQwQzBcdUM3ODUpXG4gKiBHb29nbGUgV29ya3NwYWNlIEFQSVx1QzZBOSAtIGNocm9tZS5pZGVudGl0eS5nZXRBdXRoVG9rZW4oKVx1QzVEMFx1QzExQyBcdUMwQUNcdUM2QTlcbiAqIEBjb25zdGFudCB7c3RyaW5nfVxuICovXG5leHBvcnQgY29uc3QgR09PR0xFX0NMSUVOVF9JRCA9IGltcG9ydC5tZXRhLmVudj8uVklURV9HT09HTEVfQ0xJRU5UX0lEIHx8ICcxNjcyOTA5MDIxMDQtaW1ocnF0bjMxb3JxNnRubzU1Y2VvZG84ZzRiNDU0NzguYXBwcy5nb29nbGV1c2VyY29udGVudC5jb20nO1xuXG4vKipcbiAqIEdvb2dsZSBPQXV0aCBcdUQwNzRcdUI3N0NcdUM3NzRcdUM1QjhcdUQyQjggSUQgKFx1QzZGOSBcdUM1NjBcdUQ1MENcdUI5QUNcdUNGMDBcdUM3NzRcdUMxNTggXHVEMEMwXHVDNzg1KVxuICogU3VwYWJhc2UgXHVDNzc4XHVDOTlEXHVDNkE5IC0gY2hyb21lLmlkZW50aXR5LmxhdW5jaFdlYkF1dGhGbG93KClcdUM1RDBcdUMxMUMgXHVDMEFDXHVDNkE5XG4gKiBAY29uc3RhbnQge3N0cmluZ31cbiAqL1xuZXhwb3J0IGNvbnN0IEdPT0dMRV9BVVRIX0NMSUVOVF9JRCA9IGltcG9ydC5tZXRhLmVudj8uVklURV9HT09HTEVfQVVUSF9DTElFTlRfSUQgfHwgJzE2NzI5MDkwMjEwNC1tMzF2MWxpbW85cWplYzlzN2Y5cjlrOWx0dTRuMjViMy5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbSc7XG5cbi8qKlxuICogR29vZ2xlIE9BdXRoIFJlZGlyZWN0IFVSSVxuICogY2hyb21lLmlkZW50aXR5LmxhdW5jaFdlYkF1dGhGbG93XHVDNUQwXHVDMTFDIFx1QzBBQ1x1QzZBOVxuICogQHJldHVybnMge3N0cmluZ30gUmVkaXJlY3QgVVJJXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRHb29nbGVSZWRpcmVjdFVSSSgpIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYGh0dHBzOi8vJHtjaHJvbWUucnVudGltZS5pZH0uY2hyb21pdW1hcHAub3JnL2A7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignW0NvbmZpZ10gRmFpbGVkIHRvIGdldCBjaHJvbWUucnVudGltZS5pZDonLCBlcnJvcik7XG4gICAgcmV0dXJuICdodHRwczovL3Vua25vd24uY2hyb21pdW1hcHAub3JnLyc7XG4gIH1cbn1cbiIsICIvKipcbiAqIEdvb2dsZSBXb3Jrc3BhY2UgQVBJIENsaWVudFxuICpcbiAqIEdvb2dsZSBEb2NzLCBTaGVldHMsIFNsaWRlcywgRHJpdmUgQVBJIFx1QzgxMVx1QURGQ1x1Qzc0NCBcdUM3MDRcdUQ1NUMgT0F1dGgyIFx1RDA3NFx1Qjc3Q1x1Qzc3NFx1QzVCOFx1RDJCOFxuICpcbiAqIE9BdXRoIEZsb3c6XG4gKiAxLiBjaHJvbWUuaWRlbnRpdHkubGF1bmNoV2ViQXV0aEZsb3dcdUI4NUMgXHVDNzc4XHVDOTlEXG4gKiAyLiBhY2Nlc3NfdG9rZW4gXHVENjhEXHVCNEREIChHb29nbGUgV29ya3NwYWNlIEFQSVx1QzZBOSlcbiAqIDMuIFJFU1QgQVBJIFx1RDYzOFx1Q0Q5Q1xuICpcbiAqIEBzZWUgaHR0cHM6Ly9kZXZlbG9wZXJzLmdvb2dsZS5jb20vZG9jcy9hcGkvcmVmZXJlbmNlL3Jlc3RcbiAqIEBzZWUgaHR0cHM6Ly9kZXZlbG9wZXJzLmdvb2dsZS5jb20vc2hlZXRzL2FwaS9yZWZlcmVuY2UvcmVzdFxuICogQHNlZSBodHRwczovL2RldmVsb3BlcnMuZ29vZ2xlLmNvbS9zbGlkZXMvYXBpL3JlZmVyZW5jZS9yZXN0XG4gKi9cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gT0F1dGgyIFx1Qzc3OFx1Qzk5RCAoY2hyb21lLmlkZW50aXR5LmdldEF1dGhUb2tlbiBcdUJDMjlcdUMyREQpXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogR29vZ2xlIFdvcmtzcGFjZSBBUEkgXHVDODExXHVBREZDXHVDNzQ0IFx1QzcwNFx1RDU1QyBPQXV0aDIgXHVDNzc4XHVDOTlEXG4gKiBjaHJvbWUuaWRlbnRpdHkuZ2V0QXV0aFRva2VuKClcdUM3NDQgXHVDMEFDXHVDNkE5XHVENTU4XHVDNUVDIENocm9tZVx1Qzc3NCBcdUQxQTBcdUQwNzAgXHVBRDAwXHVCOUFDXG4gKlxuICogQHBhcmFtIHtib29sZWFufSBpbnRlcmFjdGl2ZSAtIFx1QzBBQ1x1QzZBOVx1Qzc5MCBcdUMwQzFcdUQ2MzhcdUM3OTFcdUM2QTkgXHVENUM4XHVDNkE5IFx1QzVFQ1x1QkQ4MFxuICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nPn0gQWNjZXNzIHRva2VuXG4gKiBAdGhyb3dzIHtFcnJvcn0gXHVDNzc4XHVDOTlEIFx1QzJFNFx1RDMyOCBcdUMyRENcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGF1dGhvcml6ZUdvb2dsZVdvcmtzcGFjZShpbnRlcmFjdGl2ZSA9IHRydWUpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblxuICAgIGNocm9tZS5pZGVudGl0eS5nZXRBdXRoVG9rZW4oeyBpbnRlcmFjdGl2ZSB9LCAodG9rZW4pID0+IHtcbiAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcignW0dvb2dsZSBBUEldIE9BdXRoIGZsb3cgZXJyb3I6JywgY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yKTtcbiAgICAgICAgcmV0dXJuIHJlamVjdChuZXcgRXJyb3IoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yLm1lc3NhZ2UpKTtcbiAgICAgIH1cblxuICAgICAgaWYgKCF0b2tlbikge1xuICAgICAgICByZXR1cm4gcmVqZWN0KG5ldyBFcnJvcignTm8gdG9rZW4gcmVjZWl2ZWQnKSk7XG4gICAgICB9XG5cbiAgICAgIHJlc29sdmUodG9rZW4pO1xuICAgIH0pO1xuICB9KTtcbn1cblxuLyoqXG4gKiBcdUM4MDBcdUM3QTVcdUI0MUMgYWNjZXNzIHRva2VuIFx1QUMwMFx1QzgzOFx1QzYyNFx1QUUzMCAoXHVDRTkwXHVDMkRDXHVCNDFDIFx1RDFBMFx1RDA3MCBcdUJDMThcdUQ2NTgpXG4gKiBDaHJvbWVcdUM3NzQgXHVEMUEwXHVEMDcwIFx1QjlDQ1x1QjhDQ1x1Qjk3QyBcdUM3OTBcdUIzRDkgXHVBRDAwXHVCOUFDXG4gKlxuICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nfG51bGw+fSBBY2Nlc3MgdG9rZW4gb3IgbnVsbFxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0QWNjZXNzVG9rZW4oKSB7XG4gIHRyeSB7XG4gICAgLy8gaW50ZXJhY3RpdmU6IGZhbHNlXHVCODVDIFx1Q0U5MFx1QzJEQ1x1QjQxQyBcdUQxQTBcdUQwNzBcdUI5Q0MgXHVENjU1XHVDNzc4XG4gICAgY29uc3QgdG9rZW4gPSBhd2FpdCBhdXRob3JpemVHb29nbGVXb3Jrc3BhY2UoZmFsc2UpO1xuICAgIHJldHVybiB0b2tlbjtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIFx1RDFBMFx1RDA3MCBcdUM3MjBcdUQ2QThcdUMxMzEgXHVENjU1XHVDNzc4IFx1QkMwRiBcdUM3OTBcdUIzRDkgXHVDN0FDXHVDNzc4XHVDOTlEXG4gKlxuICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nPn0gVmFsaWQgYWNjZXNzIHRva2VuXG4gKiBAdGhyb3dzIHtFcnJvcn0gXHVDN0FDXHVDNzc4XHVDOTlEIFx1QzJFNFx1RDMyOCBcdUMyRENcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZW5zdXJlVmFsaWRUb2tlbigpIHtcbiAgLy8gaW50ZXJhY3RpdmU6IHRydWVcdUI4NUMgXHVENTQ0XHVDNjk0XHVDMkRDIFx1QzBBQ1x1QzZBOVx1Qzc5MFx1QzVEMFx1QUM4QyBcdUM3NzhcdUM5OUQgXHVDNjk0XHVDQ0FEXG4gIHJldHVybiBhd2FpdCBhdXRob3JpemVHb29nbGVXb3Jrc3BhY2UodHJ1ZSk7XG59XG5cbi8qKlxuICogXHVDRTkwXHVDMkRDXHVCNDFDIFx1RDFBMFx1RDA3MCBcdUM4MUNcdUFDNzAgKFx1Qjg1Q1x1QURGOFx1QzU0NFx1QzZDMyBcdUI2MTBcdUIyOTQgXHVEMUEwXHVEMDcwIFx1QUMzMVx1QzJFMCBcdUQ1NDRcdUM2OTQgXHVDMkRDKVxuICpcbiAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmV2b2tlVG9rZW4oKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY2hyb21lLmlkZW50aXR5LmdldEF1dGhUb2tlbih7IGludGVyYWN0aXZlOiBmYWxzZSB9LCAodG9rZW4pID0+IHtcbiAgICAgIGlmICh0b2tlbikge1xuICAgICAgICBjaHJvbWUuaWRlbnRpdHkucmVtb3ZlQ2FjaGVkQXV0aFRva2VuKHsgdG9rZW4gfSwgKCkgPT4ge1xuICAgICAgICAgIHJlc29sdmUoKTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBHb29nbGUgRG9jcyBBUElcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBHb29nbGUgRG9jcyBcdUJCMzhcdUMxMUMgXHVCMEI0XHVDNkE5IFx1QUMwMFx1QzgzOFx1QzYyNFx1QUUzMFxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSBkb2N1bWVudElkIC0gXHVCQjM4XHVDMTFDIElEXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxPYmplY3Q+fSBEb2N1bWVudCBvYmplY3RcbiAqIEB0aHJvd3Mge0Vycm9yfSBBUEkgXHVENjM4XHVDRDlDIFx1QzJFNFx1RDMyOCBcdUMyRENcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldERvY3VtZW50KGRvY3VtZW50SWQpIHtcbiAgY29uc3QgdG9rZW4gPSBhd2FpdCBlbnN1cmVWYWxpZFRva2VuKCk7XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcbiAgICBgaHR0cHM6Ly9kb2NzLmdvb2dsZWFwaXMuY29tL3YxL2RvY3VtZW50cy8ke2RvY3VtZW50SWR9YCxcbiAgICB7XG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3Rva2VufWBcbiAgICAgIH1cbiAgICB9XG4gICk7XG5cbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIGNvbnN0IGVycm9yID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgIHRocm93IG5ldyBFcnJvcihgRG9jcyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAtICR7ZXJyb3J9YCk7XG4gIH1cblxuICByZXR1cm4gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xufVxuXG4vKipcbiAqIEdvb2dsZSBEb2NzIFx1QkIzOFx1QzExQ1x1QzVEMFx1QzExQyBcdUQxNERcdUMyQTRcdUQyQjggXHVDRDk0XHVDRDlDXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IGRvY3VtZW50SWQgLSBcdUJCMzhcdUMxMUMgSURcbiAqIEByZXR1cm5zIHtQcm9taXNlPHN0cmluZz59IFx1QkIzOFx1QzExQyBcdUQxNERcdUMyQTRcdUQyQjhcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldERvY3VtZW50VGV4dChkb2N1bWVudElkKSB7XG4gIGNvbnN0IGRvYyA9IGF3YWl0IGdldERvY3VtZW50KGRvY3VtZW50SWQpO1xuXG4gIGxldCB0ZXh0ID0gJyc7XG5cbiAgLy8gRG9jdW1lbnQgYm9keSBcdUMyMUNcdUQ2OENcdUQ1NThcdUJBNzAgXHVEMTREXHVDMkE0XHVEMkI4IFx1Q0Q5NFx1Q0Q5Q1xuICBpZiAoZG9jLmJvZHkgJiYgZG9jLmJvZHkuY29udGVudCkge1xuICAgIGZvciAoY29uc3QgZWxlbWVudCBvZiBkb2MuYm9keS5jb250ZW50KSB7XG4gICAgICBpZiAoZWxlbWVudC5wYXJhZ3JhcGgpIHtcbiAgICAgICAgZm9yIChjb25zdCBlbCBvZiBlbGVtZW50LnBhcmFncmFwaC5lbGVtZW50cyB8fCBbXSkge1xuICAgICAgICAgIGlmIChlbC50ZXh0UnVuICYmIGVsLnRleHRSdW4uY29udGVudCkge1xuICAgICAgICAgICAgdGV4dCArPSBlbC50ZXh0UnVuLmNvbnRlbnQ7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHRleHQ7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEdvb2dsZSBTaGVldHMgQVBJXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogR29vZ2xlIFNoZWV0cyBcdUMyQTRcdUQ1MDRcdUI4MDhcdUI0RENcdUMyRENcdUQyQjggXHVCQTU0XHVEMEMwXHVCMzcwXHVDNzc0XHVEMTMwIFx1QUMwMFx1QzgzOFx1QzYyNFx1QUUzMFxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSBzcHJlYWRzaGVldElkIC0gXHVDMkE0XHVENTA0XHVCODA4XHVCNERDXHVDMkRDXHVEMkI4IElEXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxPYmplY3Q+fSBTcHJlYWRzaGVldCBvYmplY3RcbiAqIEB0aHJvd3Mge0Vycm9yfSBBUEkgXHVENjM4XHVDRDlDIFx1QzJFNFx1RDMyOCBcdUMyRENcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFNwcmVhZHNoZWV0KHNwcmVhZHNoZWV0SWQpIHtcbiAgY29uc3QgdG9rZW4gPSBhd2FpdCBlbnN1cmVWYWxpZFRva2VuKCk7XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcbiAgICBgaHR0cHM6Ly9zaGVldHMuZ29vZ2xlYXBpcy5jb20vdjQvc3ByZWFkc2hlZXRzLyR7c3ByZWFkc2hlZXRJZH1gLFxuICAgIHtcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7dG9rZW59YFxuICAgICAgfVxuICAgIH1cbiAgKTtcblxuICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgY29uc3QgZXJyb3IgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBTaGVldHMgQVBJIGVycm9yOiAke3Jlc3BvbnNlLnN0YXR1c30gLSAke2Vycm9yfWApO1xuICB9XG5cbiAgcmV0dXJuIGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcbn1cblxuLyoqXG4gKiBHb29nbGUgU2hlZXRzIFx1RDJCOVx1QzgxNSBcdUJDOTRcdUM3MDQgXHVCMzcwXHVDNzc0XHVEMTMwIFx1QUMwMFx1QzgzOFx1QzYyNFx1QUUzMFxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSBzcHJlYWRzaGVldElkIC0gXHVDMkE0XHVENTA0XHVCODA4XHVCNERDXHVDMkRDXHVEMkI4IElEXG4gKiBAcGFyYW0ge3N0cmluZ30gcmFuZ2UgLSBcdUJDOTRcdUM3MDQgKFx1QzYwODogJ1NoZWV0MSFBMTpEMTAnKVxuICogQHJldHVybnMge1Byb21pc2U8QXJyYXk8QXJyYXk8c3RyaW5nPj4+fSAyRCBcdUJDMzBcdUM1RjQgXHVCMzcwXHVDNzc0XHVEMTMwXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRTaGVldFZhbHVlcyhzcHJlYWRzaGVldElkLCByYW5nZSkge1xuICBjb25zdCB0b2tlbiA9IGF3YWl0IGVuc3VyZVZhbGlkVG9rZW4oKTtcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFxuICAgIGBodHRwczovL3NoZWV0cy5nb29nbGVhcGlzLmNvbS92NC9zcHJlYWRzaGVldHMvJHtzcHJlYWRzaGVldElkfS92YWx1ZXMvJHtlbmNvZGVVUklDb21wb25lbnQocmFuZ2UpfWAsXG4gICAge1xuICAgICAgaGVhZGVyczoge1xuICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHt0b2tlbn1gXG4gICAgICB9XG4gICAgfVxuICApO1xuXG4gIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICBjb25zdCBlcnJvciA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFNoZWV0cyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAtICR7ZXJyb3J9YCk7XG4gIH1cblxuICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xuICByZXR1cm4gZGF0YS52YWx1ZXMgfHwgW107XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEdvb2dsZSBTbGlkZXMgQVBJXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogR29vZ2xlIFNsaWRlcyBcdUQ1MDRcdUI4MDhcdUM4MjBcdUQxNENcdUM3NzRcdUMxNTggXHVBQzAwXHVDODM4XHVDNjI0XHVBRTMwXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IHByZXNlbnRhdGlvbklkIC0gXHVENTA0XHVCODA4XHVDODIwXHVEMTRDXHVDNzc0XHVDMTU4IElEXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxPYmplY3Q+fSBQcmVzZW50YXRpb24gb2JqZWN0XG4gKiBAdGhyb3dzIHtFcnJvcn0gQVBJIFx1RDYzOFx1Q0Q5QyBcdUMyRTRcdUQzMjggXHVDMkRDXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRQcmVzZW50YXRpb24ocHJlc2VudGF0aW9uSWQpIHtcbiAgY29uc3QgdG9rZW4gPSBhd2FpdCBlbnN1cmVWYWxpZFRva2VuKCk7XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcbiAgICBgaHR0cHM6Ly9zbGlkZXMuZ29vZ2xlYXBpcy5jb20vdjEvcHJlc2VudGF0aW9ucy8ke3ByZXNlbnRhdGlvbklkfWAsXG4gICAge1xuICAgICAgaGVhZGVyczoge1xuICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHt0b2tlbn1gXG4gICAgICB9XG4gICAgfVxuICApO1xuXG4gIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICBjb25zdCBlcnJvciA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFNsaWRlcyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAtICR7ZXJyb3J9YCk7XG4gIH1cblxuICByZXR1cm4gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xufVxuXG4vKipcbiAqIEdvb2dsZSBTbGlkZXMgXHVENTA0XHVCODA4XHVDODIwXHVEMTRDXHVDNzc0XHVDMTU4XHVDNUQwXHVDMTFDIFx1RDE0RFx1QzJBNFx1RDJCOCBcdUNEOTRcdUNEOUNcbiAqXG4gKiBAcGFyYW0ge3N0cmluZ30gcHJlc2VudGF0aW9uSWQgLSBcdUQ1MDRcdUI4MDhcdUM4MjBcdUQxNENcdUM3NzRcdUMxNTggSURcbiAqIEByZXR1cm5zIHtQcm9taXNlPHtzbGlkZXM6IEFycmF5PHtzbGlkZU51bWJlcjogbnVtYmVyLCB0ZXh0OiBzdHJpbmd9PiwgZnVsbFRleHQ6IHN0cmluZ30+fVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0UHJlc2VudGF0aW9uVGV4dChwcmVzZW50YXRpb25JZCkge1xuICBjb25zdCBwcmVzZW50YXRpb24gPSBhd2FpdCBnZXRQcmVzZW50YXRpb24ocHJlc2VudGF0aW9uSWQpO1xuXG4gIGNvbnN0IHNsaWRlcyA9IFtdO1xuICBsZXQgZnVsbFRleHQgPSAnJztcblxuICBpZiAocHJlc2VudGF0aW9uLnNsaWRlcykge1xuICAgIHByZXNlbnRhdGlvbi5zbGlkZXMuZm9yRWFjaCgoc2xpZGUsIGluZGV4KSA9PiB7XG4gICAgICBsZXQgc2xpZGVUZXh0ID0gJyc7XG5cbiAgICAgIC8vIFx1QzJBQ1x1Qjc3Q1x1Qzc3NFx1QjREQ1x1Qzc1OCBcdUJBQThcdUI0RTAgXHVDNjk0XHVDMThDIFx1QzIxQ1x1RDY4Q1xuICAgICAgaWYgKHNsaWRlLnBhZ2VFbGVtZW50cykge1xuICAgICAgICBmb3IgKGNvbnN0IGVsZW1lbnQgb2Ygc2xpZGUucGFnZUVsZW1lbnRzKSB7XG4gICAgICAgICAgLy8gU2hhcGUgXHVDNjk0XHVDMThDXHVDNzU4IFx1RDE0RFx1QzJBNFx1RDJCOCBcdUNEOTRcdUNEOUNcbiAgICAgICAgICBpZiAoZWxlbWVudC5zaGFwZSAmJiBlbGVtZW50LnNoYXBlLnRleHQpIHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdGV4dEVsZW1lbnQgb2YgZWxlbWVudC5zaGFwZS50ZXh0LnRleHRFbGVtZW50cyB8fCBbXSkge1xuICAgICAgICAgICAgICBpZiAodGV4dEVsZW1lbnQudGV4dFJ1biAmJiB0ZXh0RWxlbWVudC50ZXh0UnVuLmNvbnRlbnQpIHtcbiAgICAgICAgICAgICAgICBzbGlkZVRleHQgKz0gdGV4dEVsZW1lbnQudGV4dFJ1bi5jb250ZW50O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChzbGlkZVRleHQudHJpbSgpKSB7XG4gICAgICAgIHNsaWRlcy5wdXNoKHtcbiAgICAgICAgICBzbGlkZU51bWJlcjogaW5kZXggKyAxLFxuICAgICAgICAgIHRleHQ6IHNsaWRlVGV4dC50cmltKClcbiAgICAgICAgfSk7XG4gICAgICAgIGZ1bGxUZXh0ICs9IHNsaWRlVGV4dCArICdcXG4nO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHsgc2xpZGVzLCBmdWxsVGV4dDogZnVsbFRleHQudHJpbSgpIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEdvb2dsZSBEcml2ZSBBUElcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBHb29nbGUgRHJpdmUgXHVEMzBDXHVDNzdDIFx1QkE1NFx1RDBDMFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUFDMDBcdUM4MzhcdUM2MjRcdUFFMzBcbiAqXG4gKiBAcGFyYW0ge3N0cmluZ30gZmlsZUlkIC0gXHVEMzBDXHVDNzdDIElEXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxPYmplY3Q+fSBGaWxlIG1ldGFkYXRhXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRGaWxlTWV0YWRhdGEoZmlsZUlkKSB7XG4gIGNvbnN0IHRva2VuID0gYXdhaXQgZW5zdXJlVmFsaWRUb2tlbigpO1xuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXG4gICAgYGh0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL2RyaXZlL3YzL2ZpbGVzLyR7ZmlsZUlkfT9maWVsZHM9aWQsbmFtZSxtaW1lVHlwZSxtb2RpZmllZFRpbWUsb3duZXJzYCxcbiAgICB7XG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3Rva2VufWBcbiAgICAgIH1cbiAgICB9XG4gICk7XG5cbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIGNvbnN0IGVycm9yID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgIHRocm93IG5ldyBFcnJvcihgRHJpdmUgQVBJIGVycm9yOiAke3Jlc3BvbnNlLnN0YXR1c30gLSAke2Vycm9yfWApO1xuICB9XG5cbiAgcmV0dXJuIGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcbn1cblxuIiwgIi8qKlxuICogQmFja2dyb3VuZCBTZXJ2aWNlIFdvcmtlciAoTWFuaWZlc3QgVjMpXG4gKlxuICogXHVDNUVEXHVENTYwOlxuICogMS4gQ29udGVudCBzY3JpcHRcdUI4NUNcdUJEODBcdUQxMzAgXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzIxOFx1QzJFMCAoREFUQV9DQVBUVVJFRCwgVEFCX1RSQU5TSVRJT04pXG4gKiAyLiBUYWIgdHJhbnNpdGlvbiBcdUI5RTRcdUNFNkQgKGZyb20vdG8gXHVDMzBEIFx1QzBERFx1QzEzMSlcbiAqIDMuIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUJDODRcdUQzN0NcdUI5QzEgXHVCQzBGIDVcdUJEODQgXHVBQzA0XHVBQ0E5IFx1QkMzMFx1Q0U1OCBcdUM4MDRcdUMxQTFcbiAqIDQuIFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMwQzFcdUQwREMgXHVBRDAwXHVCOUFDXG4gKlxuICogQHNlZSByZXNlYXJjaC5tZCA0LjNcdUM4MDhcbiAqL1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBJbXBvcnRcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW1wb3J0IHsgdGVtcEJ1ZmZlciB9IGZyb20gJy4vbGliL3RlbXAtYnVmZmVyLmpzJztcbmltcG9ydCB7IGVuY3J5cHRpb25FbmdpbmUgfSBmcm9tICcuL2xpYi9lbmNyeXB0aW9uLmpzJztcbmltcG9ydCB7IFNVUEFCQVNFX1VSTCwgU1VQQUJBU0VfQU5PTl9LRVkgfSBmcm9tICcuL2xpYi9jb25maWcuanMnO1xuaW1wb3J0IHtcbiAgYXV0aG9yaXplR29vZ2xlV29ya3NwYWNlLFxuICBnZXRBY2Nlc3NUb2tlbixcbiAgZ2V0RG9jdW1lbnRUZXh0LFxuICBnZXRTcHJlYWRzaGVldCxcbiAgZ2V0UHJlc2VudGF0aW9uVGV4dFxufSBmcm9tICcuL2xpYi9nb29nbGUtYXBpLWNsaWVudC5qcyc7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1QzBDMVx1QzIxOFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5jb25zdCBCQVRDSF9TRU5EX0lOVEVSVkFMID0gMTsgLy8gMVx1QkQ4NCAoY2hyb21lLmFsYXJtcyBcdUNENUNcdUMxOEMgXHVDOEZDXHVBRTMwKVxuY29uc3QgTUFYX1JFVFJZX0FUVEVNUFRTID0gMzsgLy8gXHVDN0FDXHVDMkRDXHVCM0M0IFx1RDY5Rlx1QzIxOFxuY29uc3QgSU5JVElBTF9SRVRSWV9ERUxBWSA9IDEwMDA7IC8vIFx1Q0QwOFx1QUUzMCBcdUM3QUNcdUMyRENcdUIzQzQgXHVDOUMwXHVDNUYwIChtcylcblxuY29uc3QgU1RPUkFHRV9LRVlTID0ge1xuICBDT05TRU5UX0dJVkVOOiAnY29uc2VudEdpdmVuJyxcbiAgSVNfTE9HR0VEX0lOOiAnaXNMb2dnZWRJbicsXG4gIFVTRVJfSUQ6ICd1c2VySWQnLFxuICBTRU5EX1FVRVVFOiAnc2VuZFF1ZXVlJyxcbiAgTEFTVF9UUkFOU0lUSU9OOiAnbGFzdFRyYW5zaXRpb24nLFxuICBBQ1RJVkVfVEFCX0lORk86ICdhY3RpdmVUYWJJbmZvJyxcbiAgU0VSVkVSX1NBTFQ6ICdzZXJ2ZXJTYWx0JyxcbiAgQVVUSF9UT0tFTjogJ2F1dGhUb2tlbicsXG4gIFJFRlJFU0hfVE9LRU46ICdyZWZyZXNoVG9rZW4nLFxuICBJU19DT0xMRUNUSU5HOiAnaXNDb2xsZWN0aW5nJyxcbiAgQ09MTEVDVElPTl9TVEFSVF9USU1FOiAnY29sbGVjdGlvblN0YXJ0VGltZScsXG4gIENPTExFQ1RJT05fU1RPUF9USU1FOiAnY29sbGVjdGlvblN0b3BUaW1lJyxcbiAgTEFTVF9HRU5FUkFURURfUkFOR0U6ICdsYXN0R2VuZXJhdGVkUmFuZ2UnXG59O1xuXG4vLyBDb250ZW50IHNjcmlwdCBcdUI5RTRcdUQ1NTEgKG1hbmlmZXN0Lmpzb25cdUM3NTggY29udGVudF9zY3JpcHRzXHVDNjQwIFx1QjNEOVx1QUUzMFx1RDY1NClcbmNvbnN0IENPTlRFTlRfU0NSSVBUX01BUFBJTkcgPSBbXG4gIHtcbiAgICBwYXR0ZXJuczogWydodHRwczovL2NoYXRncHQuY29tLyonLCAnaHR0cHM6Ly9jaGF0Lm9wZW5haS5jb20vKicsICdodHRwczovL2NsYXVkZS5haS8qJywgJ2h0dHBzOi8vZ2VtaW5pLmdvb2dsZS5jb20vKiddLFxuICAgIHNjcmlwdHM6IFsnY29udGVudC1zY3JpcHRzL2xsbS1jYXB0dXJlLmpzJywgJ2NvbnRlbnQtc2NyaXB0cy9pbnRlcmFjdGlvbi10cmFja2VyLmpzJ11cbiAgfSxcbiAge1xuICAgIHBhdHRlcm5zOiBbJ2h0dHBzOi8vd3d3Lm5vdGlvbi5zby8qJywgJ2h0dHBzOi8vYXBwLnNsYWNrLmNvbS8qJ10sXG4gICAgc2NyaXB0czogWydjb250ZW50LXNjcmlwdHMvY29sbGFiLWNhcHR1cmUuanMnLCAnY29udGVudC1zY3JpcHRzL2ludGVyYWN0aW9uLXRyYWNrZXIuanMnXVxuICB9LFxuICB7XG4gICAgcGF0dGVybnM6IFsnaHR0cHM6Ly9kb2NzLmdvb2dsZS5jb20vKicsICdodHRwczovL3NoZWV0cy5nb29nbGUuY29tLyonLCAnaHR0cHM6Ly9zbGlkZXMuZ29vZ2xlLmNvbS8qJywgJ2h0dHBzOi8vZHJpdmUuZ29vZ2xlLmNvbS8qJ10sXG4gICAgc2NyaXB0czogWydjb250ZW50LXNjcmlwdHMvZ29vZ2xlLWNhcHR1cmUuanMnLCAnY29udGVudC1zY3JpcHRzL2ludGVyYWN0aW9uLXRyYWNrZXIuanMnXVxuICB9LFxuICB7XG4gICAgcGF0dGVybnM6IFsnaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvKicsICdodHRwczovL3N0YWNrb3ZlcmZsb3cuY29tLyonLCAnaHR0cHM6Ly9naXRodWIuY29tLyonLCAnaHR0cHM6Ly9tZWRpdW0uY29tLyonLCAnaHR0cHM6Ly9kZXYudG8vKiddLFxuICAgIHNjcmlwdHM6IFsnY29udGVudC1zY3JpcHRzL3dlYi1yZWZlcmVuY2UtdHJhY2tlci5qcyddXG4gIH1cbl07XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFRva2VuIFJlZnJlc2ggTG9naWMgKFNlcnZpY2UgV29ya2VyIFx1QzdBQ1x1QzJEQ1x1Qzc5MSBcdUIzMDBcdUM3NTEpXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogU3VwYWJhc2UgcmVmcmVzaCB0b2tlblx1Qzc0NCBcdUMwQUNcdUM2QTlcdUQ1NzRcdUMxMUMgXHVDMEM4XHVCODVDXHVDNkI0IGFjY2VzcyB0b2tlbiBcdUQ2OERcdUI0RERcbiAqIFNlcnZpY2UgV29ya2VyXHVBQzAwIFx1QkU0NFx1RDY1Q1x1QzEzMVx1RDY1NFx1QjQxOFx1QzVDOFx1QjJFNFx1QUMwMCBcdUM3QUNcdUQ2NUNcdUMxMzFcdUQ2NTRcdUI0MjAgXHVCNTRDIFx1RDU0NFx1QzY5NFxuICpcbiAqIEByZXR1cm5zIHtQcm9taXNlPHN0cmluZ3xudWxsPn0gXHVDMEM4IGFjY2VzcyB0b2tlbiBcdUI2MTBcdUIyOTQgbnVsbCAoXHVDMkU0XHVEMzI4IFx1QzJEQylcbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVmcmVzaEF1dGhUb2tlbigpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoWydyZWZyZXNoVG9rZW4nXSk7XG5cbiAgICBpZiAoIXN0b3JlZC5yZWZyZXNoVG9rZW4pIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gXHUyNzRDIE5vIHJlZnJlc2ggdG9rZW4gaW4gc3RvcmFnZScpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gXHVEODNEXHVERDA0IFJlZnJlc2hpbmcgYXV0aCB0b2tlbi4uLicpO1xuXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgJHtTVVBBQkFTRV9VUkx9L2F1dGgvdjEvdG9rZW4/Z3JhbnRfdHlwZT1yZWZyZXNoX3Rva2VuYCwge1xuICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgICdhcGlrZXknOiBTVVBBQkFTRV9BTk9OX0tFWVxuICAgICAgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcmVmcmVzaF90b2tlbjogc3RvcmVkLnJlZnJlc2hUb2tlblxuICAgICAgfSlcbiAgICB9KTtcblxuICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgIGNvbnN0IGVycm9yVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gXHUyNzRDIFRva2VuIHJlZnJlc2ggZmFpbGVkOicsIGVycm9yVGV4dCk7XG5cbiAgICAgIC8vIHJlZnJlc2ggdG9rZW5cdUIzQzQgXHVCOUNDXHVCOENDXHVCNDFDIFx1QUNCRFx1QzZCMCBcdUI4NUNcdUFERjhcdUM1NDRcdUM2QzMgXHVDQzk4XHVCOUFDXG4gICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MDAgfHwgcmVzcG9uc2Uuc3RhdHVzID09PSA0MDEpIHtcbiAgICAgICAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gXHVEODNEXHVERDEyIFNlc3Npb24gZXhwaXJlZCwgY2xlYXJpbmcgYXV0aCBzdGF0ZS4uLicpO1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoe1xuICAgICAgICAgIGlzTG9nZ2VkSW46IGZhbHNlLFxuICAgICAgICAgIGF1dGhUb2tlbjogbnVsbCxcbiAgICAgICAgICByZWZyZXNoVG9rZW46IG51bGxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xuXG4gICAgLy8gXHVDMEM4IFx1RDFBMFx1RDA3MCBcdUM4MDBcdUM3QTVcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoe1xuICAgICAgYXV0aFRva2VuOiBkYXRhLmFjY2Vzc190b2tlbixcbiAgICAgIHJlZnJlc2hUb2tlbjogZGF0YS5yZWZyZXNoX3Rva2VuLCAvLyByZWZyZXNoIHRva2VuXHVCM0M0IFx1QUMzMVx1QzJFMFx1QjQyOFxuICAgICAgaXNMb2dnZWRJbjogdHJ1ZVxuICAgIH0pO1xuXG4gICAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gXHUyNzA1IEF1dGggdG9rZW4gcmVmcmVzaGVkIHN1Y2Nlc3NmdWxseScpO1xuICAgIHJldHVybiBkYXRhLmFjY2Vzc190b2tlbjtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIFx1Mjc0QyBUb2tlbiByZWZyZXNoIGVycm9yOicsIGVycm9yKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBcdUNEMDhcdUFFMzBcdUQ2NTRcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBTZXJ2aWNlIFdvcmtlciBcdUMxMjRcdUNFNTggXHVDMkRDXG4gKi9cbmNocm9tZS5ydW50aW1lLm9uSW5zdGFsbGVkLmFkZExpc3RlbmVyKGFzeW5jIChkZXRhaWxzKSA9PiB7XG4gIGNvbnNvbGUubG9nKCdbRGFpbHkgU2NydW1dIFNlcnZpY2UgV29ya2VyIGluc3RhbGxlZDonLCBkZXRhaWxzLnJlYXNvbik7XG5cbiAgLy8gXHVCQzMwXHVDRTU4IFx1QzgwNFx1QzFBMSBcdUM1NENcdUI3OEMgXHVDMTI0XHVDODE1IChjaHJvbWUuYWxhcm1zIFx1Q0Q1Q1x1QzE4QyAxXHVCRDg0KVxuICBjaHJvbWUuYWxhcm1zLmNyZWF0ZSgnYmF0Y2hTZW5kJywge1xuICAgIHBlcmlvZEluTWludXRlczogQkFUQ0hfU0VORF9JTlRFUlZBTFxuICB9KTtcblxuICAvLyBcdUNEMDhcdUFFMzAgXHVDMEMxXHVEMERDIFx1QzEyNFx1QzgxNVxuICBjb25zdCBzdG9yYWdlID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtcbiAgICBTVE9SQUdFX0tFWVMuQ09OU0VOVF9HSVZFTixcbiAgICBTVE9SQUdFX0tFWVMuSVNfTE9HR0VEX0lOXG4gIF0pO1xuXG4gIC8vIFx1Q0Q1Q1x1Q0QwOCBcdUMxMjRcdUNFNTggXHVDMkRDXHVDNUQwXHVCOUNDIFx1Q0QwOFx1QUUzMFx1QUMxMiBcdUMxMjRcdUM4MTVcbiAgaWYgKHN0b3JhZ2VbU1RPUkFHRV9LRVlTLklTX0xPR0dFRF9JTl0gPT09IHVuZGVmaW5lZCkge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7XG4gICAgICBbU1RPUkFHRV9LRVlTLklTX0xPR0dFRF9JTl06IGZhbHNlLFxuICAgICAgW1NUT1JBR0VfS0VZUy5TRU5EX1FVRVVFXTogW11cbiAgICB9KTtcbiAgfVxuXG4gIC8vIGNvbnNlbnRHaXZlblx1Qzc0MCBcdUJBODVcdUMyRENcdUM4MDFcdUM3M0NcdUI4NUMgXHVDRDA4XHVBRTMwXHVENjU0XHVENTU4XHVDOUMwIFx1QzU0QVx1Qzc0QyAodW5kZWZpbmVkID0gXHVDNTQ0XHVDOUMxIFx1QjNEOVx1Qzc1OCBcdUM1NDhcdUQ1NjgpXG5cbiAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gQWxhcm1zIGNvbmZpZ3VyZWQ6IGJhdGNoU2VuZCBldmVyeScsIEJBVENIX1NFTkRfSU5URVJWQUwsICdtaW51dGUocyknKTtcblxuICAvLyBcdUMxMjRcdUNFNTggXHVCNjEwXHVCMjk0IFx1QzVDNVx1QjM3MFx1Qzc3NFx1RDJCOCBcdUMyREMgXHVBRTMwXHVDODc0IFx1RDBFRFx1QzVEMCBjb250ZW50IHNjcmlwdCBcdUM4RkNcdUM3ODVcbiAgaWYgKGRldGFpbHMucmVhc29uID09PSAnaW5zdGFsbCcgfHwgZGV0YWlscy5yZWFzb24gPT09ICd1cGRhdGUnKSB7XG4gICAgYXdhaXQgaW5qZWN0Q29udGVudFNjcmlwdHNUb0V4aXN0aW5nVGFicygpO1xuICB9XG59KTtcblxuLyoqXG4gKiBcdUFFMzBcdUM4NzQgXHVEMEVEXHVDNUQwIGNvbnRlbnQgc2NyaXB0IFx1QzhGQ1x1Qzc4NVxuICpcbiAqIFx1RDY1NVx1QzdBNSBcdUQ1MDRcdUI4NUNcdUFERjhcdUI3QTggXHVDMTI0XHVDRTU4L1x1QzVDNVx1QjM3MFx1Qzc3NFx1RDJCOCBcdUMyREMgXHVDNzc0XHVCQkY4IFx1QzVGNFx1QjgyNFx1Qzc4OFx1QjI5NCBcdUQwRURcdUM1RDAgY29udGVudCBzY3JpcHRcdUI5N0MgXHVDOEZDXHVDNzg1XHVENTU4XHVDNUVDXG4gKiBcdUMwQUNcdUM2QTlcdUM3OTBcdUFDMDAgXHVDMEM4XHVCODVDXHVBQ0UwXHVDRTY4IFx1QzVDNlx1Qzc3NCBcdUM5ODlcdUMyREMgXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzIxOFx1QzlEMVx1Qzc0NCBcdUMyRENcdUM3OTFcdUQ1NjAgXHVDMjE4IFx1Qzc4OFx1QjNDNFx1Qjg1RCBcdUQ1NjhcbiAqL1xuYXN5bmMgZnVuY3Rpb24gaW5qZWN0Q29udGVudFNjcmlwdHNUb0V4aXN0aW5nVGFicygpIHtcbiAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gSW5qZWN0aW5nIGNvbnRlbnQgc2NyaXB0cyB0byBleGlzdGluZyB0YWJzLi4uJyk7XG5cbiAgZm9yIChjb25zdCBtYXBwaW5nIG9mIENPTlRFTlRfU0NSSVBUX01BUFBJTkcpIHtcbiAgICB0cnkge1xuICAgICAgLy8gXHVCOUU0XHVDRTZEXHVCNDE4XHVCMjk0IFVSTFx1Qzc1OCBcdUQwRUQgXHVDODcwXHVENjhDXG4gICAgICBjb25zdCB0YWJzID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyB1cmw6IG1hcHBpbmcucGF0dGVybnMgfSk7XG5cbiAgICAgIGZvciAoY29uc3QgdGFiIG9mIHRhYnMpIHtcbiAgICAgICAgLy8gXHVDNzIwXHVENkE4XHVENTU4XHVDOUMwIFx1QzU0QVx1Qzc0MCBcdUQwRUQgXHVDMkE0XHVEMEI1XG4gICAgICAgIGlmICghdGFiLmlkIHx8IHRhYi5pZCA9PT0gY2hyb21lLnRhYnMuVEFCX0lEX05PTkUpIGNvbnRpbnVlO1xuXG4gICAgICAgIGZvciAoY29uc3Qgc2NyaXB0IG9mIG1hcHBpbmcuc2NyaXB0cykge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCBjaHJvbWUuc2NyaXB0aW5nLmV4ZWN1dGVTY3JpcHQoe1xuICAgICAgICAgICAgICB0YXJnZXQ6IHsgdGFiSWQ6IHRhYi5pZCB9LFxuICAgICAgICAgICAgICBmaWxlczogW3NjcmlwdF1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29uc29sZS5sb2coYFtEYWlseSBTY3J1bV0gSW5qZWN0ZWQgJHtzY3JpcHR9IGludG8gdGFiICR7dGFiLmlkfSAoJHt0YWIudXJsfSlgKTtcbiAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIC8vIFx1QUQ4Q1x1RDU1QyBcdUM1QzZcdUFDNzBcdUIwOTggXHVDOEZDXHVDNzg1IFx1QkQ4OFx1QUMwMFx1QjJBNVx1RDU1QyBcdUQzOThcdUM3NzRcdUM5QzAgKFx1QzgxNVx1QzBDMSBcdUNGMDBcdUM3NzRcdUMyQTQpXG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgW0RhaWx5IFNjcnVtXSBDb3VsZCBub3QgaW5qZWN0ICR7c2NyaXB0fSBpbnRvIHRhYiAke3RhYi5pZH06YCwgZXJyLm1lc3NhZ2UpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBUYWIgcXVlcnkgZmFpbGVkIGZvciBwYXR0ZXJucycsIG1hcHBpbmcucGF0dGVybnMsICc6JywgZXJyKTtcbiAgICB9XG4gIH1cblxuICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBDb250ZW50IHNjcmlwdCBpbmplY3Rpb24gY29tcGxldGVkJyk7XG59XG5cbi8qKlxuICogU2VydmljZSBXb3JrZXIgXHVDMkRDXHVDNzkxIFx1QzJEQ1xuICovXG5jaHJvbWUucnVudGltZS5vblN0YXJ0dXAuYWRkTGlzdGVuZXIoKCkgPT4ge1xuICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBTZXJ2aWNlIFdvcmtlciBzdGFydGVkJyk7XG59KTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHVCQTU0XHVDMkRDXHVDOUMwIFx1Qjc3Q1x1QzZCMFx1RDMwNVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIENvbnRlbnQgc2NyaXB0XHVCODVDXHVCRDgwXHVEMTMwIFx1QkE1NFx1QzJEQ1x1QzlDMCBcdUMyMThcdUMyRTBcbiAqL1xuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlLCBzZW5kZXIsIHNlbmRSZXNwb25zZSkgPT4ge1xuICAvLyBNZXNzYWdlIHJvdXRpbmcgKHByb2R1Y3Rpb24gbW9kZSlcblxuICBpZiAobWVzc2FnZS5hY3Rpb24gPT09ICdEQVRBX0NBUFRVUkVEJykge1xuICAgIGhhbmRsZURhdGFDYXB0dXJlZChtZXNzYWdlLnBheWxvYWQsIHNlbmRlcik7XG4gICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KTtcbiAgfSBlbHNlIGlmIChtZXNzYWdlLmFjdGlvbiA9PT0gJ1RBQl9UUkFOU0lUSU9OJykge1xuICAgIGhhbmRsZVRhYlRyYW5zaXRpb24obWVzc2FnZS5wYXlsb2FkLCBzZW5kZXIpO1xuICAgIHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IHRydWUgfSk7XG4gIH0gZWxzZSBpZiAobWVzc2FnZS5hY3Rpb24gPT09ICdHT09HTEVfQVBJX1JFUVVFU1QnKSB7XG4gICAgLy8gR29vZ2xlIEFQSSBcdUM2OTRcdUNDQUQgKFx1QkU0NFx1QjNEOVx1QUUzMCBcdUNDOThcdUI5QUMpXG4gICAgaGFuZGxlR29vZ2xlQXBpUmVxdWVzdChtZXNzYWdlLnBheWxvYWQpXG4gICAgICAudGhlbihyZXN1bHQgPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSwgZGF0YTogcmVzdWx0IH0pKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZXJyb3IubWVzc2FnZSB9KSk7XG4gICAgcmV0dXJuIHRydWU7IC8vIFx1QkU0NFx1QjNEOVx1QUUzMCBcdUM3NTFcdUIyRjVcbiAgfSBlbHNlIGlmIChtZXNzYWdlLmFjdGlvbiA9PT0gJ0FVVEhPUklaRV9HT09HTEVfV09SS1NQQUNFJykge1xuICAgIC8vIEdvb2dsZSBXb3Jrc3BhY2UgT0F1dGggXHVDNzc4XHVDOTlEXG4gICAgYXV0aG9yaXplR29vZ2xlV29ya3NwYWNlKClcbiAgICAgIC50aGVuKHRva2VuID0+IHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IHRydWUsIHRva2VuIH0pKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZXJyb3IubWVzc2FnZSB9KSk7XG4gICAgcmV0dXJuIHRydWU7IC8vIFx1QkU0NFx1QjNEOVx1QUUzMCBcdUM3NTFcdUIyRjVcbiAgfSBlbHNlIGlmIChtZXNzYWdlLmFjdGlvbiA9PT0gJ1NUQVJUX0NPTExFQ1RJT04nKSB7XG4gICAgLy8gXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzIxOFx1QzlEMSBcdUMyRENcdUM3OTFcbiAgICBoYW5kbGVTdGFydENvbGxlY3Rpb24oKVxuICAgICAgLnRoZW4ocmVzdWx0ID0+IHNlbmRSZXNwb25zZShyZXN1bHQpKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZXJyb3IubWVzc2FnZSB9KSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gZWxzZSBpZiAobWVzc2FnZS5hY3Rpb24gPT09ICdTVE9QX0NPTExFQ1RJT04nKSB7XG4gICAgLy8gXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzIxOFx1QzlEMSBcdUM5MTFcdUM5QzBcbiAgICBoYW5kbGVTdG9wQ29sbGVjdGlvbigpXG4gICAgICAudGhlbihyZXN1bHQgPT4gc2VuZFJlc3BvbnNlKHJlc3VsdCkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlcnJvci5tZXNzYWdlIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBlbHNlIGlmIChtZXNzYWdlLmFjdGlvbiA9PT0gJ0ZPUkNFX0ZMVVNIJykge1xuICAgIC8vIFx1QkFBOFx1QjRFMCBcdUQwRURcdUM1RDAgRkxVU0hfTk9XIFx1QkUwQ1x1Qjg1Q1x1QjREQ1x1Q0U5MFx1QzJBNFx1RDJCOCBcdUQ2QzQgXHVCQzMwXHVDRTU4IFx1QzgwNFx1QzFBMVxuICAgIGhhbmRsZUZvcmNlRmx1c2goKVxuICAgICAgLnRoZW4ocmVzdWx0ID0+IHNlbmRSZXNwb25zZShyZXN1bHQpKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZXJyb3IubWVzc2FnZSB9KSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gZWxzZSBpZiAobWVzc2FnZS5hY3Rpb24gPT09ICdHRVRfQ09MTEVDVElPTl9TVEFURScpIHtcbiAgICAvLyBcdUQ2MDRcdUM3QUMgXHVDMjE4XHVDOUQxIFx1QzBDMVx1RDBEQyBcdUM4NzBcdUQ2OENcbiAgICBoYW5kbGVHZXRDb2xsZWN0aW9uU3RhdGUoKVxuICAgICAgLnRoZW4ocmVzdWx0ID0+IHNlbmRSZXNwb25zZShyZXN1bHQpKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZXJyb3IubWVzc2FnZSB9KSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gZWxzZSB7XG4gICAgY29uc29sZS53YXJuKCdbRGFpbHkgU2NydW1dIFVua25vd24gYWN0aW9uOicsIG1lc3NhZ2UuYWN0aW9uKTtcbiAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6ICdVbmtub3duIGFjdGlvbicgfSk7XG4gIH1cblxuICByZXR1cm4gdHJ1ZTsgLy8gXHVCRTQ0XHVCM0Q5XHVBRTMwIHNlbmRSZXNwb25zZSBcdUM3MjBcdUM5QzBcbn0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBHb29nbGUgQVBJIFx1RDU3OFx1QjRFNFx1QjdFQ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIEdvb2dsZSBBUEkgXHVDNjk0XHVDQ0FEIFx1Q0M5OFx1QjlBQ1xuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBwYXlsb2FkIC0geyBhcGlUeXBlOiAnZG9jcyd8J3NoZWV0cyd8J3NsaWRlcycsIGRvY3VtZW50SWQ6IHN0cmluZyB9XG4gKiBAcmV0dXJucyB7UHJvbWlzZTxPYmplY3Q+fSBBUEkgXHVDNzUxXHVCMkY1IFx1QjM3MFx1Qzc3NFx1RDEzMFxuICovXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVHb29nbGVBcGlSZXF1ZXN0KHBheWxvYWQpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IGFwaVR5cGUsIGRvY3VtZW50SWQgfSA9IHBheWxvYWQ7XG5cbiAgICAvLyBcdUQxQTBcdUQwNzAgXHVENjU1XHVDNzc4IChcdUM1QzZcdUM3M0NcdUJBNzQgXHVDNzkwXHVCM0Q5IFx1Qzc3OFx1Qzk5RCBcdUMyRENcdUIzQzQpXG4gICAgbGV0IHRva2VuID0gYXdhaXQgZ2V0QWNjZXNzVG9rZW4oKTtcbiAgICBpZiAoIXRva2VuKSB7XG4gICAgICAvLyBSZXF1ZXN0aW5nIEdvb2dsZSBBUEkgYXV0aG9yaXphdGlvblxuICAgICAgdG9rZW4gPSBhd2FpdCBhdXRob3JpemVHb29nbGVXb3Jrc3BhY2UoKTtcbiAgICB9XG5cbiAgICAvLyBBUEkgXHVEMEMwXHVDNzg1XHVCQ0M0IFx1Q0M5OFx1QjlBQ1xuICAgIHN3aXRjaCAoYXBpVHlwZSkge1xuICAgICAgY2FzZSAnZG9jcyc6XG4gICAgICAgIGNvbnN0IGRvY1RleHQgPSBhd2FpdCBnZXREb2N1bWVudFRleHQoZG9jdW1lbnRJZCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgZG9jdW1lbnRJZCxcbiAgICAgICAgICB0ZXh0OiBkb2NUZXh0LFxuICAgICAgICAgIHR5cGU6ICdkb2NzJ1xuICAgICAgICB9O1xuXG4gICAgICBjYXNlICdzaGVldHMnOlxuICAgICAgICBjb25zdCBzcHJlYWRzaGVldCA9IGF3YWl0IGdldFNwcmVhZHNoZWV0KGRvY3VtZW50SWQpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGRvY3VtZW50SWQsXG4gICAgICAgICAgdGl0bGU6IHNwcmVhZHNoZWV0LnByb3BlcnRpZXM/LnRpdGxlLFxuICAgICAgICAgIHNoZWV0czogc3ByZWFkc2hlZXQuc2hlZXRzPy5tYXAocyA9PiBzLnByb3BlcnRpZXM/LnRpdGxlKSxcbiAgICAgICAgICB0eXBlOiAnc2hlZXRzJ1xuICAgICAgICB9O1xuXG4gICAgICBjYXNlICdzbGlkZXMnOlxuICAgICAgICBjb25zdCBwcmVzZW50YXRpb24gPSBhd2FpdCBnZXRQcmVzZW50YXRpb25UZXh0KGRvY3VtZW50SWQpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGRvY3VtZW50SWQsXG4gICAgICAgICAgc2xpZGVzOiBwcmVzZW50YXRpb24uc2xpZGVzLFxuICAgICAgICAgIGZ1bGxUZXh0OiBwcmVzZW50YXRpb24uZnVsbFRleHQsXG4gICAgICAgICAgdHlwZTogJ3NsaWRlcydcbiAgICAgICAgfTtcblxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIEFQSSB0eXBlOiAke2FwaVR5cGV9YCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gR29vZ2xlIEFQSSByZXF1ZXN0IGVycm9yOicsIGVycm9yKTtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBcdUMyMThcdUM5RDEgXHVDMEMxXHVEMERDIFx1QUQwMFx1QjlBQyBcdUQ1NzhcdUI0RTRcdUI3RUNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDMjE4XHVDOUQxIFx1QzJEQ1x1Qzc5MVxuICovXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVTdGFydENvbGxlY3Rpb24oKSB7XG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG4gIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7XG4gICAgW1NUT1JBR0VfS0VZUy5JU19DT0xMRUNUSU5HXTogdHJ1ZSxcbiAgICBbU1RPUkFHRV9LRVlTLkNPTExFQ1RJT05fU1RBUlRfVElNRV06IHN0YXJ0VGltZSxcbiAgICBbU1RPUkFHRV9LRVlTLkNPTExFQ1RJT05fU1RPUF9USU1FXTogbnVsbFxuICB9KTtcbiAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gXHUyNUI2IENvbGxlY3Rpb24gc3RhcnRlZCBhdCcsIG5ldyBEYXRlKHN0YXJ0VGltZSkudG9JU09TdHJpbmcoKSk7XG4gIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUsIHN0YXJ0VGltZSB9O1xufVxuXG4vKipcbiAqIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUMyMThcdUM5RDEgXHVDOTExXHVDOUMwXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVN0b3BDb2xsZWN0aW9uKCkge1xuICBjb25zdCBzdG9wVGltZSA9IERhdGUubm93KCk7XG4gIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7XG4gICAgW1NUT1JBR0VfS0VZUy5JU19DT0xMRUNUSU5HXTogZmFsc2UsXG4gICAgW1NUT1JBR0VfS0VZUy5DT0xMRUNUSU9OX1NUT1BfVElNRV06IHN0b3BUaW1lXG4gIH0pO1xuICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBcdTIzRjkgQ29sbGVjdGlvbiBzdG9wcGVkIGF0JywgbmV3IERhdGUoc3RvcFRpbWUpLnRvSVNPU3RyaW5nKCkpO1xuICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCBzdG9wVGltZSB9O1xufVxuXG4vKipcbiAqIFx1QkFBOFx1QjRFMCBcdUQwRURcdUM1RDAgRkxVU0hfTk9XIFx1QkUwQ1x1Qjg1Q1x1QjREQ1x1Q0U5MFx1QzJBNFx1RDJCOCBcdUQ2QzQgXHVCQzMwXHVDRTU4IFx1QzgwNFx1QzFBMVxuICovXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVGb3JjZUZsdXNoKCkge1xuICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBcdUQ4M0RcdUREMDQgRm9yY2UgZmx1c2hpbmcgYWxsIHRhYnMuLi4nKTtcblxuICB0cnkge1xuICAgIC8vIFx1QkFBOFx1QjRFMCBcdUQwRURcdUM1RDAgRkxVU0hfTk9XIFx1QkE1NFx1QzJEQ1x1QzlDMCBcdUJFMENcdUI4NUNcdUI0RENcdUNFOTBcdUMyQTRcdUQyQjhcbiAgICBjb25zdCB0YWJzID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoe30pO1xuICAgIGNvbnN0IGZsdXNoUHJvbWlzZXMgPSB0YWJzLm1hcCh0YWIgPT4ge1xuICAgICAgaWYgKCF0YWIuaWQgfHwgdGFiLmlkID09PSBjaHJvbWUudGFicy5UQUJfSURfTk9ORSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuXG4gICAgICByZXR1cm4gY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiLmlkLCB7IGFjdGlvbjogJ0ZMVVNIX05PVycgfSlcbiAgICAgICAgLmNhdGNoKCgpID0+IHtcbiAgICAgICAgICAvLyBDb250ZW50IHNjcmlwdFx1QUMwMCBcdUM1QzZcdUIyOTQgXHVEMEVEXHVDNzQwIFx1QkIzNFx1QzJEQ1xuICAgICAgICB9KTtcbiAgICB9KTtcblxuICAgIGF3YWl0IFByb21pc2UuYWxsKGZsdXNoUHJvbWlzZXMpO1xuICAgIGNvbnNvbGUubG9nKCdbRGFpbHkgU2NydW1dIFx1MjcwNSBGTFVTSF9OT1cgYnJvYWRjYXN0IGNvbXBsZXRlZCcpO1xuXG4gICAgLy8gXHVDN0EwXHVDMkRDIFx1QjMwMFx1QUUzMCBcdUQ2QzQgXHVCQzMwXHVDRTU4IFx1QzgwNFx1QzFBMSAoY29udGVudCBzY3JpcHRcdUI0RTRcdUM3NzQgXHVCMzcwXHVDNzc0XHVEMTMwXHVCOTdDIFx1QkNGNFx1QjBCQyBcdUMyRENcdUFDMDQpXG4gICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDUwMCkpO1xuXG4gICAgLy8gXHVCQzMwXHVDRTU4IFx1QzgwNFx1QzFBMSBcdUMyRTRcdUQ1ODlcbiAgICBhd2FpdCBwcm9jZXNzQmF0Y2hTZW5kKCk7XG4gICAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gXHUyNzA1IEZvcmNlIGJhdGNoIHNlbmQgY29tcGxldGVkJyk7XG5cbiAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBcdTI3NEMgRm9yY2UgZmx1c2ggZmFpbGVkOicsIGVycm9yKTtcbiAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfTtcbiAgfVxufVxuXG4vKipcbiAqIFx1RDYwNFx1QzdBQyBcdUMyMThcdUM5RDEgXHVDMEMxXHVEMERDIFx1Qzg3MFx1RDY4Q1xuICovXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVHZXRDb2xsZWN0aW9uU3RhdGUoKSB7XG4gIGNvbnN0IHN0b3JhZ2UgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1xuICAgIFNUT1JBR0VfS0VZUy5JU19DT0xMRUNUSU5HLFxuICAgIFNUT1JBR0VfS0VZUy5DT0xMRUNUSU9OX1NUQVJUX1RJTUUsXG4gICAgU1RPUkFHRV9LRVlTLkNPTExFQ1RJT05fU1RPUF9USU1FLFxuICAgIFNUT1JBR0VfS0VZUy5MQVNUX0dFTkVSQVRFRF9SQU5HRSxcbiAgICBTVE9SQUdFX0tFWVMuU0VORF9RVUVVRVxuICBdKTtcblxuICByZXR1cm4ge1xuICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgaXNDb2xsZWN0aW5nOiBzdG9yYWdlW1NUT1JBR0VfS0VZUy5JU19DT0xMRUNUSU5HXSB8fCBmYWxzZSxcbiAgICBzdGFydFRpbWU6IHN0b3JhZ2VbU1RPUkFHRV9LRVlTLkNPTExFQ1RJT05fU1RBUlRfVElNRV0gfHwgbnVsbCxcbiAgICBzdG9wVGltZTogc3RvcmFnZVtTVE9SQUdFX0tFWVMuQ09MTEVDVElPTl9TVE9QX1RJTUVdIHx8IG51bGwsXG4gICAgbGFzdEdlbmVyYXRlZFJhbmdlOiBzdG9yYWdlW1NUT1JBR0VfS0VZUy5MQVNUX0dFTkVSQVRFRF9SQU5HRV0gfHwgbnVsbCxcbiAgICBxdWV1ZUxlbmd0aDogc3RvcmFnZVtTVE9SQUdFX0tFWVMuU0VORF9RVUVVRV0/Lmxlbmd0aCB8fCAwXG4gIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUMyMThcdUM5RDEgXHVENTc4XHVCNEU0XHVCN0VDXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogREFUQV9DQVBUVVJFRCBcdUM1NjFcdUMxNTggXHVDQzk4XHVCOUFDXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZURhdGFDYXB0dXJlZChwYXlsb2FkLCBzZW5kZXIpIHtcbiAgdHJ5IHtcbiAgICAvLyBcdUIzRDlcdUM3NTggXHVENjU1XHVDNzc4IChcdUNENUNcdUM2QjBcdUMxMjApXG4gICAgY29uc3QgeyBjb25zZW50R2l2ZW4sIGlzQ29sbGVjdGluZyB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFsnY29uc2VudEdpdmVuJywgJ2lzQ29sbGVjdGluZyddKTtcbiAgICBpZiAoY29uc2VudEdpdmVuICE9PSB0cnVlKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gXHVDMjE4XHVDOUQxIFx1QzBDMVx1RDBEQyBcdUQ2NTVcdUM3NzggLSBcdUMyMThcdUM5RDEgXHVDOTExXHVDNzc0IFx1QzU0NFx1QjJDOFx1QkE3NCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVCQjM0XHVDMkRDXG4gICAgaWYgKGlzQ29sbGVjdGluZyAhPT0gdHJ1ZSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHsgaXNMb2dnZWRJbiB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtTVE9SQUdFX0tFWVMuSVNfTE9HR0VEX0lOXSk7XG5cbiAgICAvLyBcdUJBNTRcdUQwQzBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDRDk0XHVBQzAwXG4gICAgY29uc3QgZW5yaWNoZWRQYXlsb2FkID0ge1xuICAgICAgLi4ucGF5bG9hZCxcbiAgICAgIHRhYklkOiBzZW5kZXIudGFiPy5pZCxcbiAgICAgIGNhcHR1cmVkQXQ6IERhdGUubm93KClcbiAgICB9O1xuXG4gICAgLy8gVGFiIHRyYW5zaXRpb24gKGludGVyYWN0aW9uIHNvdXJjZSlcdUM3NDAgXHVDNzc0XHVCQkY4IGZyb20vdG8gaG9zdG5hbWVcdUM3NzQgXHVDNzg4XHVDNzNDXHVCQkMwXHVCODVDXG4gICAgLy8gc2VuZGVyLnRhYj8udXJsIFx1Q0Q5NFx1QUMwMFx1RDU1OFx1QzlDMCBcdUM1NEFcdUM3NEMgKFx1QjJFNFx1Qjk3OCBcdUQwRUQgVVJMXHVDNzc0IFx1QjRFNFx1QzVCNFx1QUMwOCBcdUMyMTggXHVDNzg4XHVDNzRDKVxuICAgIC8vIFx1QjJFNFx1Qjk3OCBcdUMxOENcdUMyQTRcdUI0RTRcdUM3NDAgXHVENjA0XHVDN0FDIFx1RDBFRFx1Qzc1OCBVUkwgXHVDRDk0XHVBQzAwXG4gICAgaWYgKHBheWxvYWQuc291cmNlICE9PSAnaW50ZXJhY3Rpb24nKSB7XG4gICAgICBlbnJpY2hlZFBheWxvYWQudXJsID0gc2VuZGVyLnRhYj8udXJsO1xuICAgIH1cblxuICAgIGlmIChpc0xvZ2dlZEluKSB7XG4gICAgICAvLyBcdUI4NUNcdUFERjhcdUM3NzggXHVDMEMxXHVEMERDOiBcdUM1NTRcdUQ2MzhcdUQ2NTQgXHVENkM0IFx1QzgwNFx1QzFBMSBcdUQwNTBcdUM1RDAgXHVDRDk0XHVBQzAwXG4gICAgICBpZiAoIWVuY3J5cHRpb25FbmdpbmUuaGFzS2V5KCkpIHtcbiAgICAgICAgY29uc29sZS53YXJuKCdbRGFpbHkgU2NydW1dIEVuY3J5cHRpb24ga2V5IG5vdCBkZXJpdmVkLCBpbml0aWFsaXppbmcuLi4nKTtcbiAgICAgICAgYXdhaXQgaW5pdGlhbGl6ZUVuY3J5cHRpb24oKTtcbiAgICAgIH1cblxuICAgICAgLy8gc291cmNlIFx1RDU0NFx1QjREQ1x1Qjk3QyBcdUM1NTRcdUQ2MzhcdUQ2NTQgXHVDODA0XHVDNUQwIFx1QkQ4NFx1QjlBQyAoaW5nZXN0IGVuZHBvaW50XHVDNUQwXHVDMTFDIFx1QkNDNFx1QjNDNCBcdUQ1NDRcdUI0RENcdUI4NUMgXHVENTQ0XHVDNjk0KVxuICAgICAgY29uc3QgeyBzb3VyY2UsIHR5cGUsIC4uLmRhdGFUb0VuY3J5cHQgfSA9IGVucmljaGVkUGF5bG9hZDtcbiAgICAgIGNvbnN0IGVuY3J5cHRlZCA9IGF3YWl0IGVuY3J5cHRpb25FbmdpbmUuZW5jcnlwdChkYXRhVG9FbmNyeXB0KTtcblxuICAgICAgLy8gaW5nZXN0IGVuZHBvaW50IFx1RDYxNVx1QzJERFx1QzVEMCBcdUI5REVcdUFDOEMgXHVCQ0MwXHVENjU4XG4gICAgICBjb25zdCBpbmdlc3RJdGVtID0ge1xuICAgICAgICBzb3VyY2U6IHNvdXJjZSB8fCB0eXBlIHx8ICd1bmtub3duJyxcbiAgICAgICAgaXY6IEpTT04uc3RyaW5naWZ5KGVuY3J5cHRlZC5pdiksXG4gICAgICAgIGNpcGhlcnRleHQ6IEpTT04uc3RyaW5naWZ5KGVuY3J5cHRlZC5jaXBoZXJ0ZXh0KSxcbiAgICAgICAgYWxnb3JpdGhtOiBlbmNyeXB0ZWQuYWxnb3JpdGhtLFxuICAgICAgICB0aW1lc3RhbXA6IGVuY3J5cHRlZC50aW1lc3RhbXAsXG4gICAgICAgIG1ldGFkYXRhOiB7fVxuICAgICAgfTtcblxuICAgICAgYXdhaXQgYWRkVG9TZW5kUXVldWUoaW5nZXN0SXRlbSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFx1QkU0NFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMwQzFcdUQwREM6IFx1Qzc4NFx1QzJEQyBcdUJDODRcdUQzN0NcdUM1RDAgXHVDODAwXHVDN0E1IChcdUQzQzlcdUJCMzgpXG4gICAgICBhd2FpdCBhZGRUb1RlbXBCdWZmZXIoZW5yaWNoZWRQYXlsb2FkKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBoYW5kbGVEYXRhQ2FwdHVyZWQgZXJyb3I6JywgZXJyb3IpO1xuICB9XG59XG5cbi8qKlxuICogXHVDODA0XHVDMUExIFx1RDA1MFx1QzVEMCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDRDk0XHVBQzAwXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGFkZFRvU2VuZFF1ZXVlKHBheWxvYWQpIHtcbiAgY29uc3QgeyBzZW5kUXVldWUgPSBbXSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtTVE9SQUdFX0tFWVMuU0VORF9RVUVVRV0pO1xuICBzZW5kUXVldWUucHVzaChwYXlsb2FkKTtcbiAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW1NUT1JBR0VfS0VZUy5TRU5EX1FVRVVFXTogc2VuZFF1ZXVlIH0pO1xufVxuXG4vKipcbiAqIFx1Qzc4NFx1QzJEQyBcdUJDODRcdUQzN0NcdUM1RDAgXHVCMzcwXHVDNzc0XHVEMTMwIFx1Q0Q5NFx1QUMwMCAoSW5kZXhlZERCKVxuICovXG5hc3luYyBmdW5jdGlvbiBhZGRUb1RlbXBCdWZmZXIocGF5bG9hZCkge1xuICB0cnkge1xuICAgIGF3YWl0IHRlbXBCdWZmZXIuYWRkKHBheWxvYWQpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gYWRkVG9UZW1wQnVmZmVyIGVycm9yOicsIGVycm9yKTtcbiAgfVxufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUYWIgVHJhbnNpdGlvbiBcdUI5RTRcdUNFNkRcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBUQUJfVFJBTlNJVElPTiBcdUM1NjFcdUMxNTggXHVDQzk4XHVCOUFDXG4gKiBpbnRlcmFjdGlvbi10cmFja2VyLmpzXHVDNUQwXHVDMTFDIHZpc2liaWxpdHljaGFuZ2UgXHVDNzc0XHVCQ0E0XHVEMkI4XHVCODVDIFx1QzgwNFx1QzFBMVxuICovXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVUYWJUcmFuc2l0aW9uKHBheWxvYWQsIHNlbmRlcikge1xuICB0cnkge1xuICAgIGNvbnN0IHsgdHlwZSwgaG9zdG5hbWUsIGF0IH0gPSBwYXlsb2FkO1xuICAgIGNvbnN0IHRhYklkID0gc2VuZGVyLnRhYj8uaWQ7XG5cbiAgICBpZiAodHlwZSA9PT0gJ2xlYXZlJykge1xuICAgICAgLy8gXHVEMEVEXHVDNzQ0IFx1QjVBMFx1QjBBMCBcdUI1NEM6IGxhc3RUcmFuc2l0aW9uIFx1QzgwMFx1QzdBNVxuICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHtcbiAgICAgICAgW1NUT1JBR0VfS0VZUy5MQVNUX1RSQU5TSVRJT05dOiB7XG4gICAgICAgICAgdHlwZTogJ2xlYXZlJyxcbiAgICAgICAgICBob3N0bmFtZSxcbiAgICAgICAgICBhdCxcbiAgICAgICAgICB0YWJJZFxuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIC8vIFRhYiBsZWZ0XG4gICAgfSBlbHNlIGlmICh0eXBlID09PSAnZW50ZXInKSB7XG4gICAgICAvLyBcdUQwRURcdUM1RDAgXHVDOUM0XHVDNzg1XHVENTYwIFx1QjU0QzogXHVDNzc0XHVDODA0IGxlYXZlXHVDNjQwIFx1QjlFNFx1Q0U2RFxuICAgICAgY29uc3QgeyBsYXN0VHJhbnNpdGlvbiB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtTVE9SQUdFX0tFWVMuTEFTVF9UUkFOU0lUSU9OXSk7XG5cbiAgICAgIGlmIChsYXN0VHJhbnNpdGlvbiAmJiBsYXN0VHJhbnNpdGlvbi50eXBlID09PSAnbGVhdmUnKSB7XG4gICAgICAgIC8vIFRyYW5zaXRpb24gXHVDMzBEIFx1QzBERFx1QzEzMVxuICAgICAgICBjb25zdCB0cmFuc2l0aW9uID0ge1xuICAgICAgICAgIGZyb206IGxhc3RUcmFuc2l0aW9uLmhvc3RuYW1lLFxuICAgICAgICAgIHRvOiBob3N0bmFtZSxcbiAgICAgICAgICBsZWZ0QXQ6IGxhc3RUcmFuc2l0aW9uLmF0LFxuICAgICAgICAgIGVudGVyZWRBdDogYXQsXG4gICAgICAgICAgZ2FwOiBhdCAtIGxhc3RUcmFuc2l0aW9uLmF0LFxuICAgICAgICAgIHRpbWVzdGFtcDogYXRcbiAgICAgICAgfTtcblxuICAgICAgICAvLyBUcmFuc2l0aW9uXHVDNzQ0IFx1QjM3MFx1Qzc3NFx1RDEzMFx1Qjg1QyBcdUM4MDBcdUM3QTVcbiAgICAgICAgYXdhaXQgaGFuZGxlRGF0YUNhcHR1cmVkKHtcbiAgICAgICAgICB0eXBlOiAnREFJTFlfU0NSVU1fQ0FQVFVSRScsXG4gICAgICAgICAgc291cmNlOiAnaW50ZXJhY3Rpb24nLFxuICAgICAgICAgIGRhdGE6IHRyYW5zaXRpb25cbiAgICAgICAgfSwgc2VuZGVyKTtcblxuICAgICAgICAvLyBsYXN0VHJhbnNpdGlvbiBcdUNEMDhcdUFFMzBcdUQ2NTRcbiAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwucmVtb3ZlKFNUT1JBR0VfS0VZUy5MQVNUX1RSQU5TSVRJT04pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gVGFiIGVudGVyZWQgd2l0aG91dCBtYXRjaGluZyBsZWF2ZVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIGhhbmRsZVRhYlRyYW5zaXRpb24gZXJyb3I6JywgZXJyb3IpO1xuICB9XG59XG5cbi8qKlxuICogY2hyb21lLnRhYnMub25BY3RpdmF0ZWRcdUI4NUMgXHVENjVDXHVDMTMxIFx1RDBFRCBcdUNEOTRcdUM4MDFcbiAqIChcdUNEOTRcdUFDMDBcdUM4MDFcdUM3NzggXHVEMEVEIFx1QzgwNFx1RDY1OCBcdUFDMTBcdUM5QzApXG4gKi9cbmNocm9tZS50YWJzLm9uQWN0aXZhdGVkLmFkZExpc3RlbmVyKGFzeW5jIChhY3RpdmVJbmZvKSA9PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgdGFiID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KGFjdGl2ZUluZm8udGFiSWQpO1xuICAgIGNvbnN0IGhvc3RuYW1lID0gbmV3IFVSTCh0YWIudXJsKS5ob3N0bmFtZTtcblxuICAgIC8vIFx1RDY1Q1x1QzEzMSBcdUQwRUQgXHVDODE1XHVCQ0Y0IFx1QzgwMFx1QzdBNVxuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7XG4gICAgICBbU1RPUkFHRV9LRVlTLkFDVElWRV9UQUJfSU5GT106IHtcbiAgICAgICAgdGFiSWQ6IGFjdGl2ZUluZm8udGFiSWQsXG4gICAgICAgIGhvc3RuYW1lLFxuICAgICAgICBhY3RpdmF0ZWRBdDogRGF0ZS5ub3coKVxuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gVGFiIGFjdGl2YXRlZFxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIGNocm9tZTovLyBcdUI0RjEgXHVDODExXHVBREZDIFx1QkQ4OFx1QUMwMCBVUkxcdUM3NDAgXHVCQjM0XHVDMkRDXG4gIH1cbn0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBcdUJDMzBcdUNFNTggXHVDODA0XHVDMUExXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogXHVCQzMwXHVDRTU4IFx1QzgwNFx1QzFBMSBcdUM1NENcdUI3OEMgXHVCOUFDXHVDMkE0XHVCMTA4XG4gKi9cbmNocm9tZS5hbGFybXMub25BbGFybS5hZGRMaXN0ZW5lcihhc3luYyAoYWxhcm0pID0+IHtcbiAgaWYgKGFsYXJtLm5hbWUgPT09ICdiYXRjaFNlbmQnKSB7XG4gICAgYXdhaXQgcHJvY2Vzc0JhdGNoU2VuZCgpO1xuICB9XG59KTtcblxuLyoqXG4gKiBcdUJDMzBcdUNFNTggXHVDODA0XHVDMUExIFx1Q0M5OFx1QjlBQ1xuICovXG5hc3luYyBmdW5jdGlvbiBwcm9jZXNzQmF0Y2hTZW5kKCkge1xuICB0cnkge1xuICAgIGNvbnN0IHsgc2VuZFF1ZXVlID0gW10sIGlzTG9nZ2VkSW4gfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXG4gICAgICBTVE9SQUdFX0tFWVMuU0VORF9RVUVVRSxcbiAgICAgIFNUT1JBR0VfS0VZUy5JU19MT0dHRURfSU5cbiAgICBdKTtcblxuICAgIGlmICghaXNMb2dnZWRJbikge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChzZW5kUXVldWUubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gU3VwYWJhc2UgRWRnZSBGdW5jdGlvblx1QzczQ1x1Qjg1QyBcdUM4MDRcdUMxQTFcbiAgICBjb25zdCBzdWNjZXNzID0gYXdhaXQgc2VuZFRvU3VwYWJhc2Uoc2VuZFF1ZXVlKTtcblxuICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAvLyBcdUM4MDRcdUMxQTEgXHVDMTMxXHVBQ0Y1IFx1QzJEQyBcdUQwNTAgXHVCRTQ0XHVDNkIwXHVBRTMwXG4gICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbU1RPUkFHRV9LRVlTLlNFTkRfUVVFVUVdOiBbXSB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBCYXRjaCBzZW5kIGZhaWxlZCBhZnRlciByZXRyaWVzJyk7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gcHJvY2Vzc0JhdGNoU2VuZCBlcnJvcjonLCBlcnJvcik7XG4gIH1cbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHVCODVDXHVBREY4XHVDNzc4IFx1QzBDMVx1RDBEQyBcdUFEMDBcdUI5QUNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBjaHJvbWUuc3RvcmFnZSBcdUJDQzBcdUFDQkQgXHVBQzEwXHVDOUMwIChcdUI4NUNcdUFERjhcdUM3NzggXHVDMEMxXHVEMERDIFx1QjRGMSlcbiAqL1xuY2hyb21lLnN0b3JhZ2Uub25DaGFuZ2VkLmFkZExpc3RlbmVyKGFzeW5jIChjaGFuZ2VzLCBhcmVhTmFtZSkgPT4ge1xuICBpZiAoYXJlYU5hbWUgIT09ICdsb2NhbCcpIHJldHVybjtcblxuICAvLyBcdUI4NUNcdUFERjhcdUM3NzggXHVDMEMxXHVEMERDIFx1QkNDMFx1QUNCRCBcdUFDMTBcdUM5QzBcbiAgaWYgKGNoYW5nZXNbU1RPUkFHRV9LRVlTLklTX0xPR0dFRF9JTl0pIHtcbiAgICBjb25zdCB7IG5ld1ZhbHVlIH0gPSBjaGFuZ2VzW1NUT1JBR0VfS0VZUy5JU19MT0dHRURfSU5dO1xuICAgIGNvbnNvbGUubG9nKCdbRGFpbHkgU2NydW1dIExvZ2luIHN0YXRlIGNoYW5nZWQ6JywgbmV3VmFsdWUpO1xuXG4gICAgaWYgKG5ld1ZhbHVlID09PSB0cnVlKSB7XG4gICAgICAvLyBcdUI4NUNcdUFERjhcdUM3NzggXHVDMkRDOiBcdUM1NTRcdUQ2MzhcdUQ2NTQgXHVEMEE0IFx1Q0QwOFx1QUUzMFx1RDY1NCBcdUQ2QzQgXHVDNzg0XHVDMkRDIFx1QkM4NFx1RDM3QyBcdUQ1MENcdUI3RUNcdUMyRENcbiAgICAgIGF3YWl0IGluaXRpYWxpemVFbmNyeXB0aW9uKCk7XG4gICAgICBhd2FpdCBmbHVzaFRlbXBCdWZmZXJUb1F1ZXVlKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFx1Qjg1Q1x1QURGOFx1QzU0NFx1QzZDMyBcdUMyREM6IFx1QzU1NFx1RDYzOFx1RDY1NCBcdUQwQTQgXHVEM0QwXHVBRTMwXG4gICAgICBlbmNyeXB0aW9uRW5naW5lLmNsZWFyS2V5KCk7XG4gICAgfVxuICB9XG59KTtcblxuLyoqXG4gKiBcdUM3ODRcdUMyREMgXHVCQzg0XHVEMzdDIFx1QjM3MFx1Qzc3NFx1RDEzMFx1Qjk3QyBcdUM1NTRcdUQ2MzhcdUQ2NTRcdUQ1NThcdUM1RUMgXHVDODA0XHVDMUExIFx1RDA1MFx1Qjg1QyBcdUM3NzRcdUIzRDlcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZmx1c2hUZW1wQnVmZmVyVG9RdWV1ZSgpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjb3VudCA9IGF3YWl0IHRlbXBCdWZmZXIuZ2V0Q291bnQoKTtcblxuICAgIGlmIChjb3VudCA9PT0gMCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFx1QzU1NFx1RDYzOFx1RDY1NCBcdUQwQTQgXHVDRDA4XHVBRTMwXHVENjU0IChcdUI4NUNcdUFERjhcdUM3NzggXHVDOUMxXHVENkM0IFx1RDYzOFx1Q0Q5Q1x1QjQxOFx1QkJDMFx1Qjg1QyBcdUQ1NDRcdUMyMTgpXG4gICAgaWYgKCFlbmNyeXB0aW9uRW5naW5lLmhhc0tleSgpKSB7XG4gICAgICBhd2FpdCBpbml0aWFsaXplRW5jcnlwdGlvbigpO1xuICAgIH1cblxuICAgIC8vIEluZGV4ZWREQlx1QzVEMFx1QzExQyBcdUIzNzBcdUM3NzRcdUQxMzBcdUI5N0MgXHVDNTU0XHVENjM4XHVENjU0XHVENTU4XHVDNUVDIFx1QzgwNFx1QzFBMSBcdUQwNTBcdUI4NUMgXHVDNzc0XHVCM0Q5XG4gICAgYXdhaXQgdGVtcEJ1ZmZlci5mbHVzaFRvU2VydmVyKGFzeW5jIChkYXRhQXJyYXkpID0+IHtcbiAgICAgIGNvbnN0IHsgc2VuZFF1ZXVlID0gW10gfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbU1RPUkFHRV9LRVlTLlNFTkRfUVVFVUVdKTtcblxuICAgICAgLy8gXHVBQzAxIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUM1NTRcdUQ2MzhcdUQ2NTRcbiAgICAgIGNvbnN0IGVuY3J5cHRlZEl0ZW1zID0gW107XG4gICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgZGF0YUFycmF5KSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgLy8gc291cmNlIFx1RDU0NFx1QjREQ1x1Qjk3QyBcdUM1NTRcdUQ2MzhcdUQ2NTQgXHVDODA0XHVDNUQwIFx1QkQ4NFx1QjlBQ1xuICAgICAgICAgIGNvbnN0IHsgc291cmNlLCB0eXBlLCAuLi5kYXRhVG9FbmNyeXB0IH0gPSBpdGVtO1xuICAgICAgICAgIGNvbnN0IGVuY3J5cHRlZCA9IGF3YWl0IGVuY3J5cHRpb25FbmdpbmUuZW5jcnlwdChkYXRhVG9FbmNyeXB0KTtcblxuICAgICAgICAgIC8vIGluZ2VzdCBlbmRwb2ludCBcdUQ2MTVcdUMyRERcdUM1RDAgXHVCOURFXHVBQzhDIFx1QkNDMFx1RDY1OFxuICAgICAgICAgIGNvbnN0IGluZ2VzdEl0ZW0gPSB7XG4gICAgICAgICAgICBzb3VyY2U6IHNvdXJjZSB8fCB0eXBlIHx8ICd1bmtub3duJyxcbiAgICAgICAgICAgIGl2OiBKU09OLnN0cmluZ2lmeShlbmNyeXB0ZWQuaXYpLCAgICAgLy8gbnVtYmVyW10gXHUyMTkyIHN0cmluZ1xuICAgICAgICAgICAgY2lwaGVydGV4dDogSlNPTi5zdHJpbmdpZnkoZW5jcnlwdGVkLmNpcGhlcnRleHQpLCAvLyBudW1iZXJbXSBcdTIxOTIgc3RyaW5nXG4gICAgICAgICAgICBhbGdvcml0aG06IGVuY3J5cHRlZC5hbGdvcml0aG0sXG4gICAgICAgICAgICB0aW1lc3RhbXA6IGVuY3J5cHRlZC50aW1lc3RhbXAsXG4gICAgICAgICAgICBtZXRhZGF0YToge31cbiAgICAgICAgICB9O1xuXG4gICAgICAgICAgZW5jcnlwdGVkSXRlbXMucHVzaChpbmdlc3RJdGVtKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBGYWlsZWQgdG8gZW5jcnlwdCB0ZW1wIGJ1ZmZlciBpdGVtOicsIGVycik7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY29uc3QgbWVyZ2VkUXVldWUgPSBbLi4uc2VuZFF1ZXVlLCAuLi5lbmNyeXB0ZWRJdGVtc107XG4gICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbU1RPUkFHRV9LRVlTLlNFTkRfUVVFVUVdOiBtZXJnZWRRdWV1ZSB9KTtcbiAgICB9KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIGZsdXNoVGVtcEJ1ZmZlclRvUXVldWUgZXJyb3I6JywgZXJyb3IpO1xuICB9XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1QzcyMFx1RDJGOFx1QjlBQ1x1RDJGMFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMwQzFcdUQwREMgXHVENjU1XHVDNzc4IChcdUIyRTRcdUI5NzggXHVCQUE4XHVCNEM4XHVDNUQwXHVDMTFDIFx1RDYzOFx1Q0Q5QyBcdUFDMDBcdUIyQTUpXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRMb2dpblN0YXRlKCkge1xuICBjb25zdCB7IGlzTG9nZ2VkSW4sIHVzZXJJZCB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtcbiAgICBTVE9SQUdFX0tFWVMuSVNfTE9HR0VEX0lOLFxuICAgIFNUT1JBR0VfS0VZUy5VU0VSX0lEXG4gIF0pO1xuICByZXR1cm4geyBpc0xvZ2dlZEluOiBpc0xvZ2dlZEluIHx8IGZhbHNlLCB1c2VySWQ6IHVzZXJJZCB8fCBudWxsIH07XG59XG5cbi8qKlxuICogXHVCODVDXHVBREY4XHVDNzc4IFx1QzEyNFx1QzgxNSAocG9wdXBcdUM3NzRcdUIwOTggXHVCMkU0XHVCOTc4IFx1QkFBOFx1QjRDOFx1QzVEMFx1QzExQyBcdUQ2MzhcdUNEOUMpXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZXRMb2dpblN0YXRlKGlzTG9nZ2VkSW4sIHVzZXJJZCA9IG51bGwpIHtcbiAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHtcbiAgICBbU1RPUkFHRV9LRVlTLklTX0xPR0dFRF9JTl06IGlzTG9nZ2VkSW4sXG4gICAgW1NUT1JBR0VfS0VZUy5VU0VSX0lEXTogdXNlcklkXG4gIH0pO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBcdUM1NTRcdUQ2MzhcdUQ2NTQgXHVDRDA4XHVBRTMwXHVENjU0XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogXHVDNTU0XHVENjM4XHVENjU0IFx1RDBBNCBcdUQzMENcdUMwREQgKFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMyREMgXHVENjM4XHVDRDlDKVxuICpcbiAqIHVzZXJJZFx1QzY0MCBzZXJ2ZXJTYWx0XHVCOTdDIFx1QzBBQ1x1QzZBOVx1RDU1OFx1QzVFQyBQQktERjJcdUI4NUMgXHVEMEE0IFx1RDMwQ1x1QzBERFxuICovXG5hc3luYyBmdW5jdGlvbiBpbml0aWFsaXplRW5jcnlwdGlvbigpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHVzZXJJZCwgc2VydmVyU2FsdCwgYXV0aFRva2VuIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1xuICAgICAgU1RPUkFHRV9LRVlTLlVTRVJfSUQsXG4gICAgICBTVE9SQUdFX0tFWVMuU0VSVkVSX1NBTFQsXG4gICAgICBTVE9SQUdFX0tFWVMuQVVUSF9UT0tFTlxuICAgIF0pO1xuXG4gICAgaWYgKCF1c2VySWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignVXNlciBJRCBub3QgZm91bmQgaW4gc3RvcmFnZScpO1xuICAgIH1cblxuICAgIC8vIFNhbHQgXHVCM0Q5XHVBRTMwXHVENjU0IFx1Qjg1Q1x1QzlDMSAoXHVCMkU0XHVDOTExIFx1QjUxNFx1QkMxNFx1Qzc3NFx1QzJBNCBcdUM5QzBcdUM2RDApXG4gICAgLy8gQ1JJVElDQUw6IFNhbHQgXHVCRDg4XHVDNzdDXHVDRTU4IFx1QkMyOVx1QzlDMCAtIFx1QzExQ1x1QkM4NCBcdUM4NzBcdUQ2OEMgXHVDMkU0XHVEMzI4IFx1QzJEQyBcdUMwQzggc2FsdCBcdUMwRERcdUMxMzEgXHVBRTA4XHVDOUMwXG4gICAgbGV0IHNhbHQgPSBzZXJ2ZXJTYWx0O1xuICAgIGxldCBzYWx0V2FzR2VuZXJhdGVkID0gZmFsc2U7XG5cbiAgICBpZiAoIXNhbHQpIHtcbiAgICAgIGlmICghYXV0aFRva2VuKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IGluaXRpYWxpemUgZW5jcnlwdGlvbiB3aXRob3V0IGF1dGggdG9rZW4nKTtcbiAgICAgIH1cblxuICAgICAgLy8gU3RlcCAxOiBcdUMxMUNcdUJDODRcdUM1RDBcdUMxMUMgc2FsdCBcdUM4NzBcdUQ2OEMgKFx1RDU0NFx1QzIxOCAtIFx1QzJFNFx1RDMyOCBcdUMyREMgXHVDOTExXHVCMkU4KVxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZXhpc3RpbmdTYWx0ID0gYXdhaXQgZmV0Y2hTYWx0RnJvbVN1cGFiYXNlKHVzZXJJZCwgYXV0aFRva2VuKTtcbiAgICAgICAgaWYgKGV4aXN0aW5nU2FsdCkge1xuICAgICAgICAgIC8vIFx1QzExQ1x1QkM4NFx1QzVEMCBcdUM3NzRcdUJCRjggc2FsdCBcdUM4NzRcdUM3QUMgXHUyMTkyIFx1QjJFNFx1QzZCNFx1Qjg1Q1x1QjREQ1x1RDU1OFx1QzVFQyBcdUMwQUNcdUM2QTlcbiAgICAgICAgICBzYWx0ID0gZXhpc3RpbmdTYWx0O1xuICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtTVE9SQUdFX0tFWVMuU0VSVkVSX1NBTFRdOiBzYWx0IH0pO1xuICAgICAgICAgIGNvbnNvbGUubG9nKCdbRGFpbHkgU2NydW1dIFx1MjcwNSBEb3dubG9hZGVkIGV4aXN0aW5nIHNhbHQgZnJvbSBzZXJ2ZXIgKG11bHRpLWRldmljZSBzeW5jKScpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFN0ZXAgMjogXHVDMTFDXHVCQzg0XHVDNUQwIHNhbHQgXHVDNUM2XHVDNzRDIFx1MjE5MiBcdUMwQzhcdUI4NUMgXHVDMEREXHVDMTMxIChcdUNENUNcdUNEMDggXHVCODVDXHVBREY4XHVDNzc4XHVCOUNDKVxuICAgICAgICAgIHNhbHQgPSBhd2FpdCBnZW5lcmF0ZVNlcnZlclNhbHQoKTtcbiAgICAgICAgICBzYWx0V2FzR2VuZXJhdGVkID0gdHJ1ZTtcbiAgICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbU1RPUkFHRV9LRVlTLlNFUlZFUl9TQUxUXTogc2FsdCB9KTtcbiAgICAgICAgICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBcdTI3MDUgR2VuZXJhdGVkIG5ldyBzZXJ2ZXIgc2FsdCAoZmlyc3QgbG9naW4pJyk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIC8vIENSSVRJQ0FMOiBcdUMxMUNcdUJDODQgXHVDODcwXHVENjhDIFx1QzJFNFx1RDMyOCBcdUMyREMgXHVDMEM4IHNhbHQgXHVDMEREXHVDMTMxIFx1QUUwOFx1QzlDMCAoXHVCMzcwXHVDNzc0XHVEMTMwIFx1QkIzNFx1QUNCMFx1QzEzMSBcdUJDRjRcdUQ2MzgpXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gXHUyNzRDIEZhaWxlZCB0byBmZXRjaCBzYWx0IGZyb20gc2VydmVyOicsIGVycm9yLm1lc3NhZ2UpO1xuXG4gICAgICAgIGNocm9tZS5ub3RpZmljYXRpb25zLmNyZWF0ZSh7XG4gICAgICAgICAgdHlwZTogJ2Jhc2ljJyxcbiAgICAgICAgICBpY29uVXJsOiAnaWNvbnMvaWNvbi00OC5wbmcnLFxuICAgICAgICAgIHRpdGxlOiAnRGFpbHkgU2NydW0gQ29ubmVjdGlvbiBSZXF1aXJlZCcsXG4gICAgICAgICAgbWVzc2FnZTogJ0Nhbm5vdCB2ZXJpZnkgZW5jcnlwdGlvbiBzZXR0aW5ncy4gUGxlYXNlIGNoZWNrIHlvdXIgaW50ZXJuZXQgY29ubmVjdGlvbiBhbmQgdHJ5IGFnYWluLicsXG4gICAgICAgICAgcHJpb3JpdHk6IDJcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgaW5pdGlhbGl6ZSBlbmNyeXB0aW9uOiBzZXJ2ZXIgc2FsdCB2ZXJpZmljYXRpb24gZmFpbGVkLiBUaGlzIHByZXZlbnRzIGRhdGEgY29ycnVwdGlvbi4nKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBcdUM1NTRcdUQ2MzhcdUQ2NTQgXHVEMEE0IFx1RDMwQ1x1QzBERFxuICAgIGF3YWl0IGVuY3J5cHRpb25FbmdpbmUuZGVyaXZlS2V5KHVzZXJJZCwgc2FsdCk7XG4gICAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gXHUyNzA1IEVuY3J5cHRpb24gaW5pdGlhbGl6ZWQnKTtcblxuICAgIC8vIFx1QzBDOFx1Qjg1QyBcdUMwRERcdUMxMzFcdUI0MUMgc2FsdFx1Qjk3QyBTdXBhYmFzZVx1QzVEMCBcdUM4MDBcdUM3QTUgKFx1Q0Q1Q1x1Q0QwOCBcdUI4NUNcdUFERjhcdUM3NzggXHVDMkRDXHVCOUNDKVxuICAgIGlmIChzYWx0V2FzR2VuZXJhdGVkICYmIGF1dGhUb2tlbikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgc2F2ZVNhbHRUb1N1cGFiYXNlV2l0aFJldHJ5KHVzZXJJZCwgc2FsdCwgYXV0aFRva2VuKTtcbiAgICAgICAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gXHUyNzA1IFNhbHQgc2F2ZWQgdG8gU3VwYWJhc2UnKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIC8vIENSSVRJQ0FMOiBTYWx0IFx1QzgwMFx1QzdBNSBcdUMyRTRcdUQzMjggXHVDMkRDIFx1QzU1NFx1RDYzOFx1RDY1NCBcdUNEMDhcdUFFMzBcdUQ2NTQgXHVDREU4XHVDMThDXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gXHUyNzRDIEZhaWxlZCB0byBzYXZlIHNhbHQgdG8gU3VwYWJhc2UgYWZ0ZXIgcmV0cmllczonLCBlcnJvcik7XG5cbiAgICAgICAgLy8gXHVDMEFDXHVDNkE5XHVDNzkwXHVDNUQwXHVBQzhDIFx1QzU0Q1x1QjlCQ1xuICAgICAgICBjaHJvbWUubm90aWZpY2F0aW9ucy5jcmVhdGUoe1xuICAgICAgICAgIHR5cGU6ICdiYXNpYycsXG4gICAgICAgICAgaWNvblVybDogJ2ljb25zL2ljb24tNDgucG5nJyxcbiAgICAgICAgICB0aXRsZTogJ0RhaWx5IFNjcnVtIFNldHVwIEZhaWxlZCcsXG4gICAgICAgICAgbWVzc2FnZTogJ0Nhbm5vdCBjb25uZWN0IHRvIHNlcnZlci4gUGxlYXNlIGNoZWNrIHlvdXIgaW50ZXJuZXQgY29ubmVjdGlvbiBhbmQgdHJ5IGxvZ2dpbmcgaW4gYWdhaW4uJyxcbiAgICAgICAgICBwcmlvcml0eTogMlxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBcdUM1NTRcdUQ2MzhcdUQ2NTQgXHVDMEMxXHVEMERDIFx1Q0QwOFx1QUUzMFx1RDY1NCAoZGVncmFkZWQgbW9kZSBcdUJDMjlcdUM5QzApXG4gICAgICAgIGVuY3J5cHRpb25FbmdpbmUuY2xlYXJLZXkoKTtcbiAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwucmVtb3ZlKFNUT1JBR0VfS0VZUy5TRVJWRVJfU0FMVCk7XG5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdGYWlsZWQgdG8gc2F2ZSBlbmNyeXB0aW9uIHNhbHQgLSBjYW5ub3QgcHJvY2VlZCB3aXRob3V0IHNlcnZlciBzeW5jaHJvbml6YXRpb24nKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBcdTI3NEMgRmFpbGVkIHRvIGluaXRpYWxpemUgZW5jcnlwdGlvbjonLCBlcnJvcik7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn1cblxuLyoqXG4gKiBTYWx0XHVCOTdDIFN1cGFiYXNlXHVDNUQwIFx1QzgwMFx1QzdBNSAoXHVDN0FDXHVDMkRDXHVCM0M0IFx1Qjg1Q1x1QzlDMSBcdUQzRUNcdUQ1NjgpXG4gKlxuICogQ1JJVElDQUw6IFNhbHQgXHVDODAwXHVDN0E1IFx1QzJFNFx1RDMyOCBcdUMyREMgXHVDNTU0XHVENjM4XHVENjU0XHVCNDFDIFx1QjM3MFx1Qzc3NFx1RDEzMFx1Qjk3QyBcdUMxMUNcdUJDODRcdUM1RDBcdUMxMUMgXHVCQ0Y1XHVENjM4XHVENjU0XHVENTYwIFx1QzIxOCBcdUM1QzZcdUM3M0NcdUJCQzBcdUI4NUMsXG4gKiBcdUJDMThcdUI0RENcdUMyREMgXHVDMTMxXHVBQ0Y1XHVENTc0XHVDNTdDIFx1RDU2OVx1QjJDOFx1QjJFNC4gM1x1RDY4QyBcdUM3QUNcdUMyRENcdUIzQzQgXHVENkM0IFx1QzJFNFx1RDMyOFx1RDU1OFx1QkE3NCBcdUM2MDhcdUM2NzhcdUI5N0MgXHVCMzU4XHVDOUQxXHVCMkM4XHVCMkU0LlxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSB1c2VySWQgLSBVc2VyIElEXG4gKiBAcGFyYW0ge3N0cmluZ30gc2FsdCAtIEdlbmVyYXRlZCBzYWx0XG4gKiBAcGFyYW0ge3N0cmluZ30gYXV0aFRva2VuIC0gU3VwYWJhc2UgYXV0aCB0b2tlblxuICogQHRocm93cyB7RXJyb3J9IDNcdUQ2OEMgXHVDN0FDXHVDMkRDXHVCM0M0IFx1RDZDNFx1QzVEMFx1QjNDNCBcdUMyRTRcdUQzMjggXHVDMkRDXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNhdmVTYWx0VG9TdXBhYmFzZVdpdGhSZXRyeSh1c2VySWQsIHNhbHQsIGF1dGhUb2tlbikge1xuICBjb25zdCBtYXhBdHRlbXB0cyA9IDM7XG4gIGNvbnN0IGJhc2VCYWNrb2ZmTXMgPSAxMDAwOyAvLyAxXHVDRDA4XG5cbiAgZm9yIChsZXQgYXR0ZW1wdCA9IDE7IGF0dGVtcHQgPD0gbWF4QXR0ZW1wdHM7IGF0dGVtcHQrKykge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGAke1NVUEFCQVNFX1VSTH0vcmVzdC92MS91c2VyX2VuY3J5cHRpb25fc2FsdHNgLCB7XG4gICAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHthdXRoVG9rZW59YCxcbiAgICAgICAgICAnYXBpa2V5JzogU1VQQUJBU0VfQU5PTl9LRVksXG4gICAgICAgICAgJ1ByZWZlcic6ICdyZXNvbHV0aW9uPWlnbm9yZS1kdXBsaWNhdGVzJyAvLyBcdUM3NzRcdUJCRjggXHVDNzg4XHVDNzNDXHVCQTc0IFx1QkIzNFx1QzJEQ1xuICAgICAgICB9LFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgdXNlcl9pZDogdXNlcklkLFxuICAgICAgICAgIHNhbHQ6IHNhbHRcbiAgICAgICAgfSlcbiAgICAgIH0pO1xuXG4gICAgICBpZiAocmVzcG9uc2Uub2sgfHwgcmVzcG9uc2Uuc3RhdHVzID09PSA0MDkpIHtcbiAgICAgICAgLy8gXHVDMTMxXHVBQ0Y1ICgyMDEgQ3JlYXRlZCkgXHVCNjEwXHVCMjk0IFx1Qzc3NFx1QkJGOCBcdUM4NzRcdUM3QUNcdUQ1NjggKDQwOSBDb25mbGljdClcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICAvLyA0eHgvNXh4IFx1QzVEMFx1QjdFQ1xuICAgICAgY29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfTogJHtlcnJvclRleHR9YCk7XG5cbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc29sZS5lcnJvcihgW0RhaWx5IFNjcnVtXSBTYWx0IHNhdmUgYXR0ZW1wdCAke2F0dGVtcHR9LyR7bWF4QXR0ZW1wdHN9IGZhaWxlZDpgLCBlcnJvci5tZXNzYWdlKTtcblxuICAgICAgaWYgKGF0dGVtcHQgPj0gbWF4QXR0ZW1wdHMpIHtcbiAgICAgICAgLy8gXHVDRDVDXHVDODg1IFx1QzJFNFx1RDMyOFxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBzYXZlIHNhbHQgYWZ0ZXIgJHttYXhBdHRlbXB0c30gYXR0ZW1wdHM6ICR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgIH1cblxuICAgICAgLy8gRXhwb25lbnRpYWwgYmFja29mZjogMVx1Q0QwOCwgMlx1Q0QwOCwgNFx1Q0QwOFxuICAgICAgY29uc3QgYmFja29mZk1zID0gYmFzZUJhY2tvZmZNcyAqIE1hdGgucG93KDIsIGF0dGVtcHQgLSAxKTtcbiAgICAgIGNvbnNvbGUubG9nKGBbRGFpbHkgU2NydW1dIFJldHJ5aW5nIGluICR7YmFja29mZk1zfW1zLi4uYCk7XG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgYmFja29mZk1zKSk7XG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogU3VwYWJhc2VcdUM1RDBcdUMxMUMgXHVBRTMwXHVDODc0IHNhbHQgXHVDODcwXHVENjhDIChcdUIyRTRcdUM5MTEgXHVCNTE0XHVCQzE0XHVDNzc0XHVDMkE0IFx1QzlDMFx1QzZEMClcbiAqXG4gKiBcdUIyRTRcdUI5NzggXHVCNTE0XHVCQzE0XHVDNzc0XHVDMkE0XHVDNUQwXHVDMTFDIFx1Qzc3NFx1QkJGOCBzYWx0XHVCOTdDIFx1QzBERFx1QzEzMVx1RDU4OFx1Qzc0NCBcdUMyMTggXHVDNzg4XHVDNzNDXHVCQkMwXHVCODVDLFxuICogXHVDMEM4IHNhbHRcdUI5N0MgXHVDMEREXHVDMTMxXHVENTU4XHVBRTMwIFx1QzgwNFx1QzVEMCBcdUMxMUNcdUJDODRcdUM1RDAgXHVBRTMwXHVDODc0IHNhbHRcdUFDMDAgXHVDNzg4XHVCMjk0XHVDOUMwIFx1RDY1NVx1Qzc3OFx1RDU2OVx1QjJDOFx1QjJFNC5cbiAqXG4gKiBAcGFyYW0ge3N0cmluZ30gdXNlcklkIC0gVXNlciBJRFxuICogQHBhcmFtIHtzdHJpbmd9IGF1dGhUb2tlbiAtIFN1cGFiYXNlIGF1dGggdG9rZW5cbiAqIEByZXR1cm5zIHtQcm9taXNlPHN0cmluZ3xudWxsPn0gXHVDMTFDXHVCQzg0XHVDNUQwIFx1QzgwMFx1QzdBNVx1QjQxQyBzYWx0LCBcdUM1QzZcdUM3M0NcdUJBNzQgbnVsbFxuICovXG5hc3luYyBmdW5jdGlvbiBmZXRjaFNhbHRGcm9tU3VwYWJhc2UodXNlcklkLCBhdXRoVG9rZW4pIHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFxuICAgICAgYCR7U1VQQUJBU0VfVVJMfS9yZXN0L3YxL3VzZXJfZW5jcnlwdGlvbl9zYWx0cz91c2VyX2lkPWVxLiR7dXNlcklkfSZzZWxlY3Q9c2FsdGAsXG4gICAgICB7XG4gICAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHthdXRoVG9rZW59YCxcbiAgICAgICAgICAnYXBpa2V5JzogU1VQQUJBU0VfQU5PTl9LRVlcbiAgICAgICAgfVxuICAgICAgfVxuICAgICk7XG5cbiAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9OiAke2F3YWl0IHJlc3BvbnNlLnRleHQoKX1gKTtcbiAgICB9XG5cbiAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xuXG4gICAgaWYgKGRhdGEgJiYgZGF0YS5sZW5ndGggPiAwICYmIGRhdGFbMF0uc2FsdCkge1xuICAgICAgcmV0dXJuIGRhdGFbMF0uc2FsdDtcbiAgICB9XG5cbiAgICByZXR1cm4gbnVsbDsgLy8gU2FsdCBub3QgZm91bmQgb24gc2VydmVyXG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBGYWlsZWQgdG8gZmV0Y2ggc2FsdCBmcm9tIHNlcnZlcjonLCBlcnJvci5tZXNzYWdlKTtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG4vKipcbiAqIFx1QzExQ1x1QkM4NCBTYWx0IFx1QzBERFx1QzEzMSAoXHVDRDVDXHVDMThDIDE2XHVCQzE0XHVDNzc0XHVEMkI4LCBDU1BSTkcpXG4gKlxuICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nPn1cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2VuZXJhdGVTZXJ2ZXJTYWx0KCkge1xuICAvLyAyXHVBQzFDXHVDNzU4IFVVSUQgXHVBQ0IwXHVENTY5IFx1MjE5MiAzMlx1QkMxNFx1Qzc3NFx1RDJCOCAoMjU2XHVCRTQ0XHVEMkI4KVxuICByZXR1cm4gY3J5cHRvLnJhbmRvbVVVSUQoKSArIGNyeXB0by5yYW5kb21VVUlEKCk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFN1cGFiYXNlIFx1QzgwNFx1QzFBMVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFx1QzU1NFx1RDYzOFx1RDY1NFx1QjQxQyBcdUIzNzBcdUM3NzRcdUQxMzBcdUI5N0MgU3VwYWJhc2UgRWRnZSBGdW5jdGlvblx1QzVEMCBcdUM4MDRcdUMxQTFcbiAqXG4gKiBcdUM3QUNcdUMyRENcdUIzQzQgXHVCODVDXHVDOUMxOiBcdUNENUNcdUIzMDAgM1x1RDY4QywgZXhwb25lbnRpYWwgYmFja29mZlxuICpcbiAqIEBwYXJhbSB7QXJyYXk8e2l2OiBudW1iZXJbXSwgY2lwaGVydGV4dDogbnVtYmVyW10sIGFsZ29yaXRobTogc3RyaW5nLCB0aW1lc3RhbXA6IG51bWJlcn0+fSBlbmNyeXB0ZWRJdGVtc1xuICogQHJldHVybnMge1Byb21pc2U8Ym9vbGVhbj59IFx1QzEzMVx1QUNGNSBcdUM1RUNcdUJEODBcbiAqL1xuYXN5bmMgZnVuY3Rpb24gc2VuZFRvU3VwYWJhc2UoZW5jcnlwdGVkSXRlbXMpIHtcbiAgY29uc3QgZW5kcG9pbnQgPSBgJHtTVVBBQkFTRV9VUkx9L2Z1bmN0aW9ucy92MS9pbmdlc3QtZGF0YWA7XG5cbiAgLy8gU2VuZGluZyBiYXRjaCB0byBTdXBhYmFzZVxuXG4gIGZvciAobGV0IGF0dGVtcHQgPSAwOyBhdHRlbXB0IDwgTUFYX1JFVFJZX0FUVEVNUFRTOyBhdHRlbXB0KyspIHtcbiAgICB0cnkge1xuICAgICAgLy8gY2hyb21lLnN0b3JhZ2VcdUM1RDBcdUMxMUMgYXV0aFRva2VuIFx1QUMwMFx1QzgzOFx1QzYyNFx1QUUzMCAoU2VydmljZSBXb3JrZXJcdUIyOTQgc3RhdGVsZXNzKVxuICAgICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFsnYXV0aFRva2VuJ10pO1xuXG4gICAgICBpZiAoIXN0b3JlZC5hdXRoVG9rZW4pIHtcbiAgICAgICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBcdTI3NEMgTm8gYXV0aCB0b2tlbiBpbiBzdG9yYWdlJyk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH1cblxuICAgICAgLy8gUE9TVCBcdUM2OTRcdUNDQURcbiAgICAgIGNvbnN0IHBheWxvYWQgPSB7IGl0ZW1zOiBlbmNyeXB0ZWRJdGVtcyB9O1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChlbmRwb2ludCwge1xuICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7c3RvcmVkLmF1dGhUb2tlbn1gXG4gICAgICAgIH0sXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHBheWxvYWQpXG4gICAgICB9KTtcblxuICAgICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgICBjb25zdCBlcnJvclRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gLSBFcnJvciByZXNwb25zZTonLCBlcnJvclRleHQpO1xuXG4gICAgICAgIC8vIDQwMSBcdUM1RDBcdUI3RUM6IFx1RDFBMFx1RDA3MCBcdUI5Q0NcdUI4Q0MgXHUyMTkyIFx1QUMzMVx1QzJFMCBcdUMyRENcdUIzQzQgXHVENkM0IFx1QzdBQ1x1QzJEQ1x1QjNDNFxuICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MDEpIHtcbiAgICAgICAgICBjb25zdCBuZXdUb2tlbiA9IGF3YWl0IHJlZnJlc2hBdXRoVG9rZW4oKTtcblxuICAgICAgICAgIGlmIChuZXdUb2tlbikge1xuICAgICAgICAgICAgLy8gXHVEMUEwXHVEMDcwIFx1QUMzMVx1QzJFMCBcdUMxMzFcdUFDRjUgXHUyMTkyIFx1QUMxOVx1Qzc0MCBhdHRlbXB0XHVDNUQwXHVDMTFDIFx1QzdBQ1x1QzJEQ1x1QjNDNFxuICAgICAgICAgICAgY29uc3QgcmV0cnlSZXNwb25zZSA9IGF3YWl0IGZldGNoKGVuZHBvaW50LCB7XG4gICAgICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHtuZXdUb2tlbn1gXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHBheWxvYWQpXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKHJldHJ5UmVzcG9uc2Uub2spIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHJldHJ5RXJyb3JUZXh0ID0gYXdhaXQgcmV0cnlSZXNwb25zZS50ZXh0KCk7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXRyeVJlc3BvbnNlLnN0YXR1c30gYWZ0ZXIgdG9rZW4gcmVmcmVzaDogJHtyZXRyeUVycm9yVGV4dH1gKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9OiAke2Vycm9yVGV4dH1gKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoYFtEYWlseSBTY3J1bV0gU2VuZCBhdHRlbXB0ICR7YXR0ZW1wdCArIDF9LyR7TUFYX1JFVFJZX0FUVEVNUFRTfSBmYWlsZWQ6YCwgZXJyb3IubWVzc2FnZSk7XG5cbiAgICAgIC8vIFx1QjlDOFx1QzlDMFx1QjlDOSBcdUMyRENcdUIzQzRcdUFDMDAgXHVDNTQ0XHVCMkM4XHVCQTc0IFx1QzdBQ1x1QzJEQ1x1QjNDNFxuICAgICAgaWYgKGF0dGVtcHQgPCBNQVhfUkVUUllfQVRURU1QVFMgLSAxKSB7XG4gICAgICAgIC8vIEV4cG9uZW50aWFsIGJhY2tvZmY6IDFcdUNEMDgsIDJcdUNEMDgsIDRcdUNEMDhcbiAgICAgICAgY29uc3QgZGVsYXkgPSBJTklUSUFMX1JFVFJZX0RFTEFZICogTWF0aC5wb3coMiwgYXR0ZW1wdCk7XG4gICAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIEZhaWxlZCB0byBzZW5kIGRhdGEgYWZ0ZXInLCBNQVhfUkVUUllfQVRURU1QVFMsICdhdHRlbXB0cycpO1xuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKlxuICogU2xlZXAgXHVDNzIwXHVEMkY4XHVCOUFDXHVEMkYwXG4gKlxuICogQHBhcmFtIHtudW1iZXJ9IG1zIC0gXHVCQzAwXHVCOUFDXHVDRDA4XG4gKiBAcmV0dXJucyB7UHJvbWlzZTx2b2lkPn1cbiAqL1xuZnVuY3Rpb24gc2xlZXAobXMpIHtcbiAgcmV0dXJuIG5l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O0FBQ3hELGVBQU87QUFBQSxNQUNUO0FBR0EsWUFBTSxVQUFVLEVBQUUsT0FBTyxlQUFlO0FBQ3hDLFlBQU0sV0FBVyxNQUFNLE1BQU0sVUFBVTtBQUFBLFFBQ3JDLFFBQVE7QUFBQSxRQUNSLFNBQVM7QUFBQSxVQUNQLGdCQUFnQjtBQUFBLFVBQ2hCLGlCQUFpQixVQUFVLE9BQU8sU0FBUztBQUFBLFFBQzdDO0FBQUEsUUFDQSxNQUFNLEtBQUssVUFBVSxPQUFPO0FBQUEsTUFDOUIsQ0FBQztBQUVELFVBQUksQ0FBQyxTQUFTLElBQUk7QUFDaEIsY0FBTSxZQUFZLE1BQU0sU0FBUyxLQUFLO0FBQ3RDLGdCQUFRLE1BQU0sbUNBQW1DLFNBQVM7QUFHMUQsWUFBSSxTQUFTLFdBQVcsS0FBSztBQUMzQixnQkFBTSxXQUFXLE1BQU0saUJBQWlCO0FBRXhDLGNBQUksVUFBVTtBQUVaLGtCQUFNLGdCQUFnQixNQUFNLE1BQU0sVUFBVTtBQUFBLGNBQzFDLFFBQVE7QUFBQSxjQUNSLFNBQVM7QUFBQSxnQkFDUCxnQkFBZ0I7QUFBQSxnQkFDaEIsaUJBQWlCLFVBQVUsUUFBUTtBQUFBLGNBQ3JDO0FBQUEsY0FDQSxNQUFNLEtBQUssVUFBVSxPQUFPO0FBQUEsWUFDOUIsQ0FBQztBQUVELGdCQUFJLGNBQWMsSUFBSTtBQUNwQixxQkFBTztBQUFBLFlBQ1Q7QUFFQSxrQkFBTSxpQkFBaUIsTUFBTSxjQUFjLEtBQUs7QUFDaEQsa0JBQU0sSUFBSSxNQUFNLFFBQVEsY0FBYyxNQUFNLHlCQUF5QixjQUFjLEVBQUU7QUFBQSxVQUN2RjtBQUFBLFFBQ0Y7QUFFQSxjQUFNLElBQUksTUFBTSxRQUFRLFNBQVMsTUFBTSxLQUFLLFNBQVMsRUFBRTtBQUFBLE1BQ3pEO0FBRUEsYUFBTztBQUFBLElBQ1QsU0FBUyxPQUFPO0FBQ2QsY0FBUSxNQUFNLDhCQUE4QixVQUFVLENBQUMsSUFBSSxrQkFBa0IsWUFBWSxNQUFNLE9BQU87QUFHdEcsVUFBSSxVQUFVLHFCQUFxQixHQUFHO0FBRXBDLGNBQU0sUUFBUSxzQkFBc0IsS0FBSyxJQUFJLEdBQUcsT0FBTztBQUN2RCxjQUFNLE1BQU0sS0FBSztBQUFBLE1BQ25CO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxVQUFRLE1BQU0sMkNBQTJDLG9CQUFvQixVQUFVO0FBQ3ZGLFNBQU87QUFDVDtBQVFBLFNBQVMsTUFBTSxJQUFJO0FBQ2pCLFNBQU8sSUFBSSxRQUFRLGFBQVcsV0FBVyxTQUFTLEVBQUUsQ0FBQztBQUN2RDsiLAogICJuYW1lcyI6IFtdCn0K
