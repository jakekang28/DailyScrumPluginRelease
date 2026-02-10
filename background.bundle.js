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
var API_URL = import.meta.env?.VITE_API_URL || "https://api-production-890f.up.railway.app";
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
      const hasPermission = await chrome.permissions.contains({
        origins: mapping.patterns
      });
      if (!hasPermission) {
        continue;
      }
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
chrome.permissions.onAdded.addListener(async (permissions) => {
  if (!permissions.origins || permissions.origins.length === 0) return;
  console.log("[Daily Scrum] Permissions granted:", permissions.origins);
  const grantedOrigins = new Set(permissions.origins);
  for (const mapping of CONTENT_SCRIPT_MAPPING) {
    const matchingPatterns = mapping.patterns.filter((p) => grantedOrigins.has(p));
    if (matchingPatterns.length === 0) continue;
    try {
      const tabs = await chrome.tabs.query({ url: matchingPatterns });
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
      console.error("[Daily Scrum] Tab query failed for granted patterns:", err);
    }
  }
});
chrome.runtime.onStartup.addListener(() => {
  console.log("[Daily Scrum] Service Worker started");
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vbGliL3RlbXAtYnVmZmVyLmpzIiwgIi4uL2xpYi9lbmNyeXB0aW9uLmpzIiwgIi4uL2xpYi9jb25maWcuanMiLCAiLi4vbGliL2dvb2dsZS1hcGktY2xpZW50LmpzIiwgIi4uL2JhY2tncm91bmQuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVGVtcEJ1ZmZlciAtIEluZGV4ZWREQiBcdUFFMzBcdUJDMTggXHVDNzg0XHVDMkRDIFx1QkM4NFx1RDM3Q1xuICpcbiAqIFx1QkU0NFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMwQzFcdUQwRENcdUM1RDBcdUMxMUMgXHVDMjE4XHVDOUQxXHVCNDFDIFx1QjM3MFx1Qzc3NFx1RDEzMFx1Qjk3QyBcdUM3ODRcdUMyREMgXHVDODAwXHVDN0E1XHVENTY5XHVCMkM4XHVCMkU0LlxuICogXHVCODVDXHVBREY4XHVDNzc4IFx1QzJEQyBmbHVzaFRvU2VydmVyKClcdUI4NUMgXHVDMTFDXHVCQzg0XHVDNUQwIFx1QzgwNFx1QzFBMSBcdUQ2QzQgXHVDMEFEXHVDODFDXHVCNDI5XHVCMkM4XHVCMkU0LlxuICpcbiAqIEBzZWUgcmVzZWFyY2gubWQgNC4yXHVDODA4XG4gKi9cblxuY29uc3QgREJfTkFNRSA9ICdkYWlseVNjcnVtQnVmZmVyJztcbmNvbnN0IERCX1ZFUlNJT04gPSAxO1xuY29uc3QgU1RPUkVfTkFNRSA9ICdjYXB0dXJlcyc7XG5jb25zdCBDTEVBTlVQX0FHRV9NUyA9IDMwICogNjAgKiAxMDAwOyAvLyAzMFx1QkQ4NFxuXG4vKipcbiAqIFRlbXBCdWZmZXIgXHVEMDc0XHVCNzk4XHVDMkE0XG4gKi9cbmV4cG9ydCBjbGFzcyBUZW1wQnVmZmVyIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgdGhpcy5kYiA9IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogSW5kZXhlZERCIFx1Q0QwOFx1QUUzMFx1RDY1NFxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxJREJEYXRhYmFzZT59XG4gICAqL1xuICBhc3luYyBfaW5pdERCKCkge1xuICAgIGlmICh0aGlzLmRiKSByZXR1cm4gdGhpcy5kYjtcblxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCByZXF1ZXN0ID0gaW5kZXhlZERCLm9wZW4oREJfTkFNRSwgREJfVkVSU0lPTik7XG5cbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHtcbiAgICAgICAgY29uc29sZS5lcnJvcignW1RlbXBCdWZmZXJdIEluZGV4ZWREQiBvcGVuIGVycm9yOicsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB9O1xuXG4gICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgICAgdGhpcy5kYiA9IHJlcXVlc3QucmVzdWx0O1xuICAgICAgICByZXNvbHZlKHRoaXMuZGIpO1xuICAgICAgfTtcblxuICAgICAgcmVxdWVzdC5vbnVwZ3JhZGVuZWVkZWQgPSAoZXZlbnQpID0+IHtcbiAgICAgICAgY29uc3QgZGIgPSBldmVudC50YXJnZXQucmVzdWx0O1xuXG4gICAgICAgIC8vIE9iamVjdCBTdG9yZSBcdUMwRERcdUMxMzFcbiAgICAgICAgaWYgKCFkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKFNUT1JFX05BTUUpKSB7XG4gICAgICAgICAgY29uc3Qgb2JqZWN0U3RvcmUgPSBkYi5jcmVhdGVPYmplY3RTdG9yZShTVE9SRV9OQU1FLCB7XG4gICAgICAgICAgICBrZXlQYXRoOiAnaWQnLFxuICAgICAgICAgICAgYXV0b0luY3JlbWVudDogdHJ1ZVxuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgLy8gXHVDNzc4XHVCMzcxXHVDMkE0IFx1QzBERFx1QzEzMTogdGltZXN0YW1wXHVCODVDIFx1QkU2MFx1Qjk3OCBcdUM4NzBcdUQ2OEMvXHVDODE1XHVCOUFDXG4gICAgICAgICAgb2JqZWN0U3RvcmUuY3JlYXRlSW5kZXgoJ3RpbWVzdGFtcCcsICd0aW1lc3RhbXAnLCB7IHVuaXF1ZTogZmFsc2UgfSk7XG5cbiAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgcmVxdWVzdC5vbmJsb2NrZWQgPSAoKSA9PiB7XG4gICAgICAgIGNvbnNvbGUud2FybignW1RlbXBCdWZmZXJdIEluZGV4ZWREQiBibG9ja2VkIGJ5IGFub3RoZXIgY29ubmVjdGlvbicpO1xuICAgICAgICByZWplY3QobmV3IEVycm9yKCdJbmRleGVkREIgYmxvY2tlZCcpKTtcbiAgICAgIH07XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogXHVCMzcwXHVDNzc0XHVEMTMwIFx1Q0Q5NFx1QUMwMFxuICAgKiBAcGFyYW0ge09iamVjdH0gZGF0YSAtIFx1QzgwMFx1QzdBNVx1RDU2MCBcdUIzNzBcdUM3NzRcdUQxMzBcbiAgICogQHJldHVybnMge1Byb21pc2U8bnVtYmVyPn0gLSBcdUNEOTRcdUFDMDBcdUI0MUMgXHVENTZEXHVCQUE5XHVDNzU4IElEXG4gICAqL1xuICBhc3luYyBhZGQoZGF0YSkge1xuICAgIHRyeSB7XG4gICAgICAvLyBcdUJBM0NcdUM4MDAgXHVDNjI0XHVCNzk4XHVCNDFDIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUM4MTVcdUI5QUNcbiAgICAgIGF3YWl0IHRoaXMuY2xlYW51cCgpO1xuXG4gICAgICBjb25zdCBkYiA9IGF3YWl0IHRoaXMuX2luaXREQigpO1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihbU1RPUkVfTkFNRV0sICdyZWFkd3JpdGUnKTtcbiAgICAgIGNvbnN0IHN0b3JlID0gdHJhbnNhY3Rpb24ub2JqZWN0U3RvcmUoU1RPUkVfTkFNRSk7XG5cbiAgICAgIC8vIHRpbWVzdGFtcCBcdUNEOTRcdUFDMDBcbiAgICAgIGNvbnN0IHJlY29yZCA9IHtcbiAgICAgICAgLi4uZGF0YSxcbiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpXG4gICAgICB9O1xuXG4gICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUuYWRkKHJlY29yZCk7XG5cbiAgICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgICAgcmVzb2x2ZShyZXF1ZXN0LnJlc3VsdCk7XG4gICAgICAgIH07XG5cbiAgICAgICAgcmVxdWVzdC5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBBZGQgZXJyb3I6JywgcmVxdWVzdC5lcnJvcik7XG4gICAgICAgICAgcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICB9O1xuXG4gICAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiB7XG4gICAgICAgIH07XG5cbiAgICAgICAgdHJhbnNhY3Rpb24ub25lcnJvciA9ICgpID0+IHtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gQWRkIHRyYW5zYWN0aW9uIGVycm9yOicsIHRyYW5zYWN0aW9uLmVycm9yKTtcbiAgICAgICAgICByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IpO1xuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBhZGQoKSBlcnJvcjonLCBlcnJvcik7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogMzBcdUJEODQgXHVDNzc0XHVDMEMxIFx1QjQxQyBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDMEFEXHVDODFDXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPG51bWJlcj59IC0gXHVDMEFEXHVDODFDXHVCNDFDIFx1RDU2RFx1QkFBOSBcdUMyMThcbiAgICovXG4gIGFzeW5jIGNsZWFudXAoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRiID0gYXdhaXQgdGhpcy5faW5pdERCKCk7XG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKFtTVE9SRV9OQU1FXSwgJ3JlYWR3cml0ZScpO1xuICAgICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShTVE9SRV9OQU1FKTtcbiAgICAgIGNvbnN0IGluZGV4ID0gc3RvcmUuaW5kZXgoJ3RpbWVzdGFtcCcpO1xuXG4gICAgICBjb25zdCBjdXRvZmZUaW1lID0gRGF0ZS5ub3coKSAtIENMRUFOVVBfQUdFX01TO1xuICAgICAgY29uc3QgcmFuZ2UgPSBJREJLZXlSYW5nZS51cHBlckJvdW5kKGN1dG9mZlRpbWUpO1xuXG4gICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBsZXQgZGVsZXRlZENvdW50ID0gMDtcbiAgICAgICAgY29uc3QgY3Vyc29yUmVxdWVzdCA9IGluZGV4Lm9wZW5DdXJzb3IocmFuZ2UpO1xuXG4gICAgICAgIGN1cnNvclJlcXVlc3Qub25zdWNjZXNzID0gKGV2ZW50KSA9PiB7XG4gICAgICAgICAgY29uc3QgY3Vyc29yID0gZXZlbnQudGFyZ2V0LnJlc3VsdDtcbiAgICAgICAgICBpZiAoY3Vyc29yKSB7XG4gICAgICAgICAgICBjdXJzb3IuZGVsZXRlKCk7XG4gICAgICAgICAgICBkZWxldGVkQ291bnQrKztcbiAgICAgICAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgfTtcblxuICAgICAgICBjdXJzb3JSZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcignW1RlbXBCdWZmZXJdIENsZWFudXAgY3Vyc29yIGVycm9yOicsIGN1cnNvclJlcXVlc3QuZXJyb3IpO1xuICAgICAgICAgIHJlamVjdChjdXJzb3JSZXF1ZXN0LmVycm9yKTtcbiAgICAgICAgfTtcblxuICAgICAgICB0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4ge1xuICAgICAgICAgIGlmIChkZWxldGVkQ291bnQgPiAwKSB7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJlc29sdmUoZGVsZXRlZENvdW50KTtcbiAgICAgICAgfTtcblxuICAgICAgICB0cmFuc2FjdGlvbi5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBDbGVhbnVwIHRyYW5zYWN0aW9uIGVycm9yOicsIHRyYW5zYWN0aW9uLmVycm9yKTtcbiAgICAgICAgICByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IpO1xuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBjbGVhbnVwKCkgZXJyb3I6JywgZXJyb3IpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFx1QzgwNFx1Q0NCNCBcdUIzNzBcdUM3NzRcdUQxMzBcdUI5N0MgXHVDMTFDXHVCQzg0XHVCODVDIGZsdXNoXG4gICAqIEBwYXJhbSB7RnVuY3Rpb259IGVuY3J5cHRBbmRTZW5kIC0gXHVDNTU0XHVENjM4XHVENjU0IFx1QkMwRiBcdUM4MDRcdUMxQTEgXHVDRjVDXHVCQzMxOiBhc3luYyAoZGF0YSkgPT4gdm9pZFxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxudW1iZXI+fSAtIFx1QzgwNFx1QzFBMVx1QjQxQyBcdUQ1NkRcdUJBQTkgXHVDMjE4XG4gICAqL1xuICBhc3luYyBmbHVzaFRvU2VydmVyKGVuY3J5cHRBbmRTZW5kKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRiID0gYXdhaXQgdGhpcy5faW5pdERCKCk7XG5cbiAgICAgIC8vIDEuIFx1QkFBOFx1QjRFMCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDNzdEXHVBRTMwXG4gICAgICBjb25zdCBhbGxEYXRhID0gYXdhaXQgdGhpcy5fZ2V0QWxsRGF0YShkYik7XG5cbiAgICAgIGlmIChhbGxEYXRhLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXR1cm4gMDtcbiAgICAgIH1cblxuXG4gICAgICAvLyAyLiBcdUNGNUNcdUJDMzFcdUM1RDAgXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzgwNFx1QjJFQyAoXHVDNTU0XHVENjM4XHVENjU0IFx1QkMwRiBcdUM4MDRcdUMxQTEpXG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBlbmNyeXB0QW5kU2VuZChhbGxEYXRhKTtcbiAgICAgIH0gY2F0Y2ggKHNlbmRFcnJvcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gZW5jcnlwdEFuZFNlbmQgY2FsbGJhY2sgZXJyb3I6Jywgc2VuZEVycm9yKTtcbiAgICAgICAgdGhyb3cgc2VuZEVycm9yO1xuICAgICAgfVxuXG4gICAgICAvLyAzLiBcdUM4MDRcdUMxQTEgXHVDMTMxXHVBQ0Y1IFx1QzJEQyBcdUJBQThcdUI0RTAgXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzBBRFx1QzgxQ1xuICAgICAgYXdhaXQgdGhpcy5fY2xlYXJBbGwoZGIpO1xuXG4gICAgICByZXR1cm4gYWxsRGF0YS5sZW5ndGg7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBmbHVzaFRvU2VydmVyKCkgZXJyb3I6JywgZXJyb3IpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFx1QkFBOFx1QjRFMCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDNzdEXHVBRTMwIChcdUIwQjRcdUJEODAgXHVENUVDXHVEMzdDKVxuICAgKiBAcGFyYW0ge0lEQkRhdGFiYXNlfSBkYlxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxBcnJheT59XG4gICAqL1xuICBhc3luYyBfZ2V0QWxsRGF0YShkYikge1xuICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oW1NUT1JFX05BTUVdLCAncmVhZG9ubHknKTtcbiAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKFNUT1JFX05BTUUpO1xuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5nZXRBbGwoKTtcblxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgIHJlc29sdmUocmVxdWVzdC5yZXN1bHQpO1xuICAgICAgfTtcblxuICAgICAgcmVxdWVzdC5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gZ2V0QWxsIGVycm9yOicsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB9O1xuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFx1QkFBOFx1QjRFMCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDMEFEXHVDODFDIChcdUIwQjRcdUJEODAgXHVENUVDXHVEMzdDKVxuICAgKiBAcGFyYW0ge0lEQkRhdGFiYXNlfSBkYlxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTx2b2lkPn1cbiAgICovXG4gIGFzeW5jIF9jbGVhckFsbChkYikge1xuICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oW1NUT1JFX05BTUVdLCAncmVhZHdyaXRlJyk7XG4gICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShTVE9SRV9OQU1FKTtcblxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUuY2xlYXIoKTtcblxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH07XG5cbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHtcbiAgICAgICAgY29uc29sZS5lcnJvcignW1RlbXBCdWZmZXJdIGNsZWFyIGVycm9yOicsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB9O1xuXG4gICAgICB0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4ge1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9O1xuXG4gICAgICB0cmFuc2FjdGlvbi5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gQ2xlYXIgdHJhbnNhY3Rpb24gZXJyb3I6JywgdHJhbnNhY3Rpb24uZXJyb3IpO1xuICAgICAgICByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IpO1xuICAgICAgfTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBcdUM4MDBcdUM3QTVcdUI0MUMgXHVENTZEXHVCQUE5IFx1QzIxOCBcdUM4NzBcdUQ2OEMgKFx1RDMxRFx1QzVDNSBcdUMwQzFcdUQwREMgXHVENDVDXHVDMkRDXHVDNkE5KVxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxudW1iZXI+fVxuICAgKi9cbiAgYXN5bmMgZ2V0Q291bnQoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRiID0gYXdhaXQgdGhpcy5faW5pdERCKCk7XG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKFtTVE9SRV9OQU1FXSwgJ3JlYWRvbmx5Jyk7XG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKFNUT1JFX05BTUUpO1xuXG4gICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUuY291bnQoKTtcblxuICAgICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgICAgICByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcbiAgICAgICAgfTtcblxuICAgICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcignW1RlbXBCdWZmZXJdIGNvdW50IGVycm9yOicsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICAgIHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gZ2V0Q291bnQoKSBlcnJvcjonLCBlcnJvcik7XG4gICAgICByZXR1cm4gMDsgLy8gXHVDNUQwXHVCN0VDIFx1QzJEQyAwIFx1QkMxOFx1RDY1OCAoVUlcdUFDMDAgXHVBRTY4XHVDOUMwXHVDOUMwIFx1QzU0QVx1QjNDNFx1Qjg1RClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogSW5kZXhlZERCIFx1QzVGMFx1QUNCMCBcdUIyRUJcdUFFMzBcbiAgICovXG4gIGNsb3NlKCkge1xuICAgIGlmICh0aGlzLmRiKSB7XG4gICAgICB0aGlzLmRiLmNsb3NlKCk7XG4gICAgICB0aGlzLmRiID0gbnVsbDtcbiAgICB9XG4gIH1cbn1cblxuLy8gXHVDMkYxXHVBRTAwXHVEMUE0IFx1Qzc3OFx1QzJBNFx1RDEzNFx1QzJBNCBleHBvcnRcbmV4cG9ydCBjb25zdCB0ZW1wQnVmZmVyID0gbmV3IFRlbXBCdWZmZXIoKTtcbiIsICIvKipcbiAqIEVuY3J5cHRpb24gRW5naW5lIGZvciBEYWlseSBTY3J1bSBFeHRlbnNpb25cbiAqXG4gKiBcdUJDRjRcdUM1NDggXHVCQUE4XHVCMzc4OiBUcmFuc2l0IEVuY3J5cHRpb24gKEUyRSBcdUM1NDRcdUIyRDgpXG4gKiAtIFx1QzExQ1x1QkM4NFx1QUMwMCB1c2VySWQgKyBzZXJ2ZXJTYWx0XHVCODVDIFx1RDBBNCBcdUM3QUNcdUQzMENcdUMwREQgXHVBQzAwXHVCMkE1XG4gKiAtIFx1QjEyNFx1RDJCOFx1QzZDQ1x1RDA2QyBcdUM4MDRcdUMxQTEgXHVDOTExIFx1QjNDNFx1Q0NBRCBcdUJDMjlcdUM5QzAgXHVCQUE5XHVDODAxXG4gKlxuICogQHNlZSBkb2NzL3Jlc2VhcmNoLm1kIDVcdUM4MDhcbiAqL1xuXG4vKipcbiAqIEFFUy1HQ00tMjU2IFx1QzU1NFx1RDYzOFx1RDY1NCBcdUM1RDRcdUM5QzRcbiAqXG4gKiBcdUQwQTQgXHVEMzBDXHVDMEREOiBQQktERjIgKFNIQS0yNTYsIDEwMCwwMDAgaXRlcmF0aW9ucylcbiAqIFx1QzU1NFx1RDYzOFx1RDY1NDogQUVTLUdDTS0yNTYgKFx1Qzc3OFx1Qzk5RFx1QjQxQyBcdUM1NTRcdUQ2MzhcdUQ2NTQpXG4gKiBJVjogMTJcdUJDMTRcdUM3NzRcdUQyQjggKDk2XHVCRTQ0XHVEMkI4KSBcdUI3OUNcdUIzNjQgXHVDMEREXHVDMTMxXG4gKlxuICogQGNsYXNzXG4gKi9cbmV4cG9ydCBjbGFzcyBFbmNyeXB0aW9uRW5naW5lIHtcbiAgLyoqXG4gICAqIEBwcml2YXRlXG4gICAqIEB0eXBlIHtDcnlwdG9LZXl8bnVsbH1cbiAgICovXG4gICNrZXkgPSBudWxsO1xuXG4gIC8qKlxuICAgKiBQQktERjIgaXRlcmF0aW9uIGNvdW50XG4gICAqIEBwcml2YXRlXG4gICAqIEBjb25zdGFudCB7bnVtYmVyfVxuICAgKi9cbiAgc3RhdGljICNQQktERjJfSVRFUkFUSU9OUyA9IDMwMDAwMDsgIC8vIFx1QURFMFx1RDYxNVx1QzdBMVx1RDc4QyBcdUJDRjRcdUM1NDgvXHVDMTMxXHVCMkE1IChPV0FTUCAyMDI2IFx1QUQ4Q1x1QzdBNTogNjAwLDAwMCspXG5cbiAgLyoqXG4gICAqIEFFUy1HQ00gSVYgbGVuZ3RoIChieXRlcylcbiAgICogQHByaXZhdGVcbiAgICogQGNvbnN0YW50IHtudW1iZXJ9XG4gICAqL1xuICBzdGF0aWMgI0lWX0xFTkdUSCA9IDEyOyAgLy8gOTYgYml0cyAoXHVENDVDXHVDOTAwIFx1QUQ4Q1x1QzdBNSlcblxuICAvKipcbiAgICogTWF4aW11bSBjaXBoZXJ0ZXh0IHNpemUgKGJ5dGVzKSAtIERvUyBcdUJDMjlcdUM5QzBcbiAgICogQHByaXZhdGVcbiAgICogQGNvbnN0YW50IHtudW1iZXJ9XG4gICAqL1xuICBzdGF0aWMgI01BWF9DSVBIRVJURVhUX1NJWkUgPSAxMCAqIDEwMjQgKiAxMDI0OyAgLy8gMTBNQlxuXG4gIC8qKlxuICAgKiBcdUM1NTRcdUQ2MzhcdUQ2NTQgXHVEMEE0IFx1RDMwQ1x1QzBERFxuICAgKlxuICAgKiBcdTI2QTBcdUZFMEYgXHVCQ0Y0XHVDNTQ4IFx1QUNCRFx1QUNFMDogdXNlcklkXHVCMjk0IFx1QzYwOFx1Q0UyMSBcdUFDMDBcdUIyQTVcdUQ1NThcdUJCQzBcdUI4NUMgXHVDOUM0XHVDODE1XHVENTVDIEUyRVx1QUMwMCBcdUM1NDRcdUIyRDhcbiAgICogXHVDMTFDXHVCQzg0XHVBQzAwIHVzZXJJZCArIHNlcnZlclNhbHRcdUI4NUMgXHVCM0Q5XHVDNzdDXHVENTVDIFx1RDBBNFx1Qjk3QyBcdUM3QUNcdUFENkNcdUMxMzFcdUQ1NjAgXHVDMjE4IFx1Qzc4OFx1Qzc0Q1xuICAgKlxuICAgKiBAcGFyYW0ge3N0cmluZ30gdXNlcklkIC0gU3VwYWJhc2UgdXNlciBJRCAoVVVJRClcbiAgICogQHBhcmFtIHtzdHJpbmd9IHNlcnZlclNhbHQgLSBcdUMxMUNcdUJDODRcdUM1RDBcdUMxMUMgXHVDODFDXHVBQ0Y1XHVENTVDIHNhbHRcbiAgICogQHRocm93cyB7RXJyb3J9IHVzZXJJZCBcdUI2MTBcdUIyOTQgc2VydmVyU2FsdFx1QUMwMCBcdUJFNDRcdUM1QjRcdUM3ODhcdUM3NDQgXHVBQ0JEXHVDNkIwXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fVxuICAgKi9cbiAgYXN5bmMgZGVyaXZlS2V5KHVzZXJJZCwgc2VydmVyU2FsdCkge1xuICAgIGlmICghdXNlcklkIHx8ICFzZXJ2ZXJTYWx0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ3VzZXJJZCBhbmQgc2VydmVyU2FsdCBhcmUgcmVxdWlyZWQnKTtcbiAgICB9XG5cbiAgICBjb25zdCBlbmMgPSBuZXcgVGV4dEVuY29kZXIoKTtcblxuICAgIC8vIDEuIEtleSBtYXRlcmlhbCBcdUMwRERcdUMxMzEgKHVzZXJJZCBcdUFFMzBcdUJDMTgpXG4gICAgY29uc3Qga2V5TWF0ZXJpYWwgPSBhd2FpdCBjcnlwdG8uc3VidGxlLmltcG9ydEtleShcbiAgICAgICdyYXcnLFxuICAgICAgZW5jLmVuY29kZSh1c2VySWQpLFxuICAgICAgJ1BCS0RGMicsXG4gICAgICBmYWxzZSwgIC8vIGV4dHJhY3RhYmxlOiBmYWxzZVxuICAgICAgWydkZXJpdmVLZXknXVxuICAgICk7XG5cbiAgICAvLyAyLiBQQktERjJcdUI4NUMgQUVTLUdDTSBcdUQwQTQgXHVEMzBDXHVDMEREXG4gICAgdGhpcy4ja2V5ID0gYXdhaXQgY3J5cHRvLnN1YnRsZS5kZXJpdmVLZXkoXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdQQktERjInLFxuICAgICAgICBzYWx0OiBlbmMuZW5jb2RlKHNlcnZlclNhbHQpLFxuICAgICAgICBpdGVyYXRpb25zOiBFbmNyeXB0aW9uRW5naW5lLiNQQktERjJfSVRFUkFUSU9OUyxcbiAgICAgICAgaGFzaDogJ1NIQS0yNTYnXG4gICAgICB9LFxuICAgICAga2V5TWF0ZXJpYWwsXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdBRVMtR0NNJyxcbiAgICAgICAgbGVuZ3RoOiAyNTYgIC8vIDI1Ni1iaXQga2V5XG4gICAgICB9LFxuICAgICAgZmFsc2UsICAvLyBleHRyYWN0YWJsZTogZmFsc2UgKFx1RDBBNFx1Qjk3QyBcdUJBNTRcdUJBQThcdUI5QUNcdUM1RDBcdUMxMUMgXHVDRDk0XHVDRDlDIFx1QkQ4OFx1QUMwMClcbiAgICAgIFsnZW5jcnlwdCcsICdkZWNyeXB0J11cbiAgICApO1xuXG4gICAgLy8gXHVBQzFDXHVCQzFDIFx1RDY1OFx1QUNCRFx1QzVEMFx1QzExQ1x1QjlDQyBcdUI4NUNcdUFFNDUgKFx1RDUwNFx1Qjg1Q1x1QjM1NVx1QzE1OCBcdUQwQTQgXHVCMTc4XHVDRDlDIFx1QkMyOVx1QzlDMClcbiAgICBpZiAodHlwZW9mIHByb2Nlc3MgIT09ICd1bmRlZmluZWQnICYmIHByb2Nlc3MuZW52Py5OT0RFX0VOViA9PT0gJ2RldmVsb3BtZW50Jykge1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDNTU0XHVENjM4XHVENjU0XG4gICAqXG4gICAqIEBwYXJhbSB7YW55fSBkYXRhIC0gXHVDNTU0XHVENjM4XHVENjU0XHVENTYwIFx1QjM3MFx1Qzc3NFx1RDEzMCAoSlNPTiBcdUM5QzFcdUI4MkNcdUQ2NTQgXHVBQzAwXHVCMkE1XHVENTc0XHVDNTdDIFx1RDU2OClcbiAgICogQHRocm93cyB7RXJyb3J9IFx1RDBBNFx1QUMwMCBcdUQzMENcdUMwRERcdUI0MThcdUM5QzAgXHVDNTRBXHVDNTU4XHVBQzcwXHVCMDk4IFx1QzU1NFx1RDYzOFx1RDY1NCBcdUMyRTRcdUQzMjggXHVDMkRDXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHtpdjogbnVtYmVyW10sIGNpcGhlcnRleHQ6IG51bWJlcltdLCBhbGdvcml0aG06IHN0cmluZywgdGltZXN0YW1wOiBudW1iZXJ9Pn1cbiAgICovXG4gIGFzeW5jIGVuY3J5cHQoZGF0YSkge1xuICAgIGlmICghdGhpcy4ja2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0VuY3J5cHRpb24ga2V5IG5vdCBkZXJpdmVkLiBDYWxsIGRlcml2ZUtleSgpIGZpcnN0LicpO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICAvLyAxLiBcdUI3OUNcdUIzNjQgSVYgXHVDMEREXHVDMTMxICgxMlx1QkMxNFx1Qzc3NFx1RDJCOCwgOTZcdUJFNDRcdUQyQjgpXG4gICAgICBjb25zdCBpdiA9IGNyeXB0by5nZXRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkoRW5jcnlwdGlvbkVuZ2luZS4jSVZfTEVOR1RIKSk7XG5cbiAgICAgIC8vIDIuIFx1QjM3MFx1Qzc3NFx1RDEzMCBKU09OIFx1QzlDMVx1QjgyQ1x1RDY1NFxuICAgICAgY29uc3QgcGxhaW50ZXh0ID0gSlNPTi5zdHJpbmdpZnkoZGF0YSk7XG4gICAgICBjb25zdCBwbGFpbnRleHRCdWZmZXIgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUocGxhaW50ZXh0KTtcblxuICAgICAgLy8gMy4gQUVTLUdDTSBcdUM1NTRcdUQ2MzhcdUQ2NTRcbiAgICAgIGNvbnN0IGNpcGhlcnRleHRCdWZmZXIgPSBhd2FpdCBjcnlwdG8uc3VidGxlLmVuY3J5cHQoXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnQUVTLUdDTScsXG4gICAgICAgICAgaXY6IGl2XG4gICAgICAgIH0sXG4gICAgICAgIHRoaXMuI2tleSxcbiAgICAgICAgcGxhaW50ZXh0QnVmZmVyXG4gICAgICApO1xuXG4gICAgICAvLyA0LiBcdUNEOUNcdUI4MjUgXHVENjE1XHVDMkREIFx1QkNDMFx1RDY1OCAoVWludDhBcnJheSBcdTIxOTIgbnVtYmVyW10pXG4gICAgICByZXR1cm4ge1xuICAgICAgICBpdjogQXJyYXkuZnJvbShpdiksXG4gICAgICAgIGNpcGhlcnRleHQ6IEFycmF5LmZyb20obmV3IFVpbnQ4QXJyYXkoY2lwaGVydGV4dEJ1ZmZlcikpLFxuICAgICAgICBhbGdvcml0aG06ICdBRVMtR0NNLTI1NicsXG4gICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKVxuICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgLy8gXHVEMEMwXHVDNzc0XHVCQzBEIFx1QUNGNVx1QUNBOSBcdUJDMjlcdUM5QzA6IFx1QzVEMFx1QjdFQyBcdUFDMURcdUNDQjQgXHVCODVDXHVBRTQ1IFx1QUUwOFx1QzlDMFxuICAgICAgY29uc29sZS5lcnJvcignW0VuY3J5cHRpb25dIEVuY3J5cHRpb24gZmFpbGVkJyk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0VuY3J5cHRpb24gZmFpbGVkJyk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUJDRjVcdUQ2MzhcdUQ2NTRcbiAgICpcbiAgICogXHVEMEMwXHVDNzc0XHVCQzBEIFx1QUNGNVx1QUNBOSBcdUJDMjlcdUM5QzA6IFx1QkFBOFx1QjRFMCBcdUM1RDBcdUI3RUNcdUI5N0MgXHVCM0Q5XHVDNzdDXHVENTVDIFx1QkE1NFx1QzJEQ1x1QzlDMFx1Qjg1QyBcdUJDMThcdUQ2NThcbiAgICpcbiAgICogQHBhcmFtIHt7aXY6IG51bWJlcltdLCBjaXBoZXJ0ZXh0OiBudW1iZXJbXSwgYWxnb3JpdGhtOiBzdHJpbmd9fSBlbmNyeXB0ZWREYXRhXG4gICAqIEB0aHJvd3Mge0Vycm9yfSBcdUQwQTRcdUFDMDAgXHVEMzBDXHVDMEREXHVCNDE4XHVDOUMwIFx1QzU0QVx1QzU1OFx1QUM3MFx1QjA5OCBcdUJDRjVcdUQ2MzhcdUQ2NTQgXHVDMkU0XHVEMzI4IFx1QzJEQ1xuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxhbnk+fSBcdUJDRjVcdUQ2MzhcdUQ2NTRcdUI0MUMgXHVDNkQwXHVCQ0Y4IFx1QjM3MFx1Qzc3NFx1RDEzMFxuICAgKi9cbiAgYXN5bmMgZGVjcnlwdChlbmNyeXB0ZWREYXRhKSB7XG4gICAgaWYgKCF0aGlzLiNrZXkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignRW5jcnlwdGlvbiBrZXkgbm90IGRlcml2ZWQuIENhbGwgZGVyaXZlS2V5KCkgZmlyc3QuJyk7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIC8vIDEuIFx1Qzc4NVx1QjgyNSBcdUFDODBcdUM5OURcbiAgICAgIGlmICghZW5jcnlwdGVkRGF0YS5pdiB8fCAhZW5jcnlwdGVkRGF0YS5jaXBoZXJ0ZXh0KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBlbmNyeXB0ZWQgZGF0YSBmb3JtYXQnKTtcbiAgICAgIH1cblxuICAgICAgLy8gSVYgXHVBRTM4XHVDNzc0IFx1QUM4MFx1Qzk5RCAobWFsZm9ybWVkIGRhdGEgXHVBQ0Y1XHVBQ0E5IFx1QkMyOVx1QzlDMClcbiAgICAgIGlmIChlbmNyeXB0ZWREYXRhLml2Lmxlbmd0aCAhPT0gRW5jcnlwdGlvbkVuZ2luZS4jSVZfTEVOR1RIKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBlbmNyeXB0ZWQgZGF0YSBmb3JtYXQnKTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2lwaGVydGV4dCBcdUQwNkNcdUFFMzAgXHVDODFDXHVENTVDIChEb1MgdmlhIG1lbW9yeSBleGhhdXN0aW9uIFx1QkMyOVx1QzlDMClcbiAgICAgIGlmIChlbmNyeXB0ZWREYXRhLmNpcGhlcnRleHQubGVuZ3RoID4gRW5jcnlwdGlvbkVuZ2luZS4jTUFYX0NJUEhFUlRFWFRfU0laRSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgZW5jcnlwdGVkIGRhdGEgZm9ybWF0Jyk7XG4gICAgICB9XG5cbiAgICAgIC8vIDIuIG51bWJlcltdIFx1MjE5MiBVaW50OEFycmF5IFx1QkNDMFx1RDY1OFxuICAgICAgY29uc3QgaXYgPSBuZXcgVWludDhBcnJheShlbmNyeXB0ZWREYXRhLml2KTtcbiAgICAgIGNvbnN0IGNpcGhlcnRleHQgPSBuZXcgVWludDhBcnJheShlbmNyeXB0ZWREYXRhLmNpcGhlcnRleHQpO1xuXG4gICAgICAvLyAzLiBBRVMtR0NNIFx1QkNGNVx1RDYzOFx1RDY1NFxuICAgICAgY29uc3QgcGxhaW50ZXh0QnVmZmVyID0gYXdhaXQgY3J5cHRvLnN1YnRsZS5kZWNyeXB0KFxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ0FFUy1HQ00nLFxuICAgICAgICAgIGl2OiBpdlxuICAgICAgICB9LFxuICAgICAgICB0aGlzLiNrZXksXG4gICAgICAgIGNpcGhlcnRleHRcbiAgICAgICk7XG5cbiAgICAgIC8vIDQuIFx1QkM4NFx1RDM3QyBcdTIxOTIgXHVCQjM4XHVDNzkwXHVDNUY0IFx1MjE5MiBKU09OIFx1RDMwQ1x1QzJGMVxuICAgICAgY29uc3QgcGxhaW50ZXh0ID0gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHBsYWludGV4dEJ1ZmZlcik7XG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShwbGFpbnRleHQpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAvLyBcdUQwQzBcdUM3NzRcdUJDMEQgXHVBQ0Y1XHVBQ0E5IFx1QkMyOVx1QzlDMDogXHVDNUQwXHVCN0VDIFx1RDBDMFx1Qzc4NSBcdUIxNzhcdUNEOUMgXHVBRTA4XHVDOUMwXG4gICAgICAvLyAoQUVTLUdDTSBcdUM3NzhcdUM5OUQgXHVDMkU0XHVEMzI4LCBKU09OIFx1RDMwQ1x1QzJGMSBcdUM1RDBcdUI3RUMgXHVCQUE4XHVCNDUwIFx1QjNEOVx1Qzc3Q1x1RDU1QyBcdUM1RDBcdUI3RUMpXG4gICAgICBjb25zb2xlLmVycm9yKCdbRW5jcnlwdGlvbl0gRGVjcnlwdGlvbiBmYWlsZWQnKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcignRGVjcnlwdGlvbiBmYWlsZWQnKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogXHVEMEE0IFx1RDMwQ1x1QzBERCBcdUM1RUNcdUJEODAgXHVENjU1XHVDNzc4XG4gICAqXG4gICAqIEByZXR1cm5zIHtib29sZWFufVxuICAgKi9cbiAgaGFzS2V5KCkge1xuICAgIHJldHVybiB0aGlzLiNrZXkgIT09IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogXHVEMEE0IFx1RDNEMFx1QUUzMCAoXHVCODVDXHVBREY4XHVDNTQ0XHVDNkMzIFx1QzJEQyBcdUQ2MzhcdUNEOUMpXG4gICAqXG4gICAqIFx1MjZBMFx1RkUwRiBcdUM4RkNcdUM3NTg6IFx1RDBBNFx1QjI5NCBleHRyYWN0YWJsZTogZmFsc2VcdUM3NzRcdUJCQzBcdUI4NUMgXHVDN0FDXHVEMzBDXHVDMEREIFx1RDU0NFx1QzY5NFxuICAgKi9cbiAgY2xlYXJLZXkoKSB7XG4gICAgdGhpcy4ja2V5ID0gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIFx1QzJGMVx1QUUwMFx1RDFBNCBcdUM3NzhcdUMyQTRcdUQxMzRcdUMyQTQgKFx1QzEyMFx1RDBERFx1QzgwMSBcdUMwQUNcdUM2QTkpXG4gKlxuICogXHVDMEFDXHVDNkE5IFx1QzYwODpcbiAqIGltcG9ydCB7IGVuY3J5cHRpb25FbmdpbmUgfSBmcm9tICcuL2xpYi9lbmNyeXB0aW9uLmpzJztcbiAqIGF3YWl0IGVuY3J5cHRpb25FbmdpbmUuZGVyaXZlS2V5KHVzZXJJZCwgc2VydmVyU2FsdCk7XG4gKiBjb25zdCBlbmNyeXB0ZWQgPSBhd2FpdCBlbmNyeXB0aW9uRW5naW5lLmVuY3J5cHQoZGF0YSk7XG4gKi9cbmV4cG9ydCBjb25zdCBlbmNyeXB0aW9uRW5naW5lID0gbmV3IEVuY3J5cHRpb25FbmdpbmUoKTtcbiIsICIvKipcbiAqIENvbmZpZ3VyYXRpb24gZm9yIERhaWx5IFNjcnVtIEV4dGVuc2lvblxuICpcbiAqIFN1cGFiYXNlIFx1RDY1OFx1QUNCRCBcdUJDQzBcdUMyMTggXHVBRDAwXHVCOUFDXG4gKiBcdUQ1MDRcdUI4NUNcdUIzNTVcdUMxNTggXHVCQzMwXHVEM0VDIFx1QzJEQyBcdUQ2NThcdUFDQkQgXHVCQ0MwXHVDMjE4XHVCODVDIFx1QzhGQ1x1Qzc4NVx1RDU1OFx1QUM3MFx1QjA5OCBcdUJDQzRcdUIzQzQgXHVDMTI0XHVDODE1IFx1RDMwQ1x1Qzc3Q1x1Qjg1QyBcdUFEMDBcdUI5QUNcbiAqXG4gKiBAc2VlIGRvY3MvcmVzZWFyY2gubWQgNC4xXHVDODA4XG4gKi9cblxuLyoqXG4gKiBTdXBhYmFzZSBcdUQ1MDRcdUI4NUNcdUM4MURcdUQyQjggVVJMXG4gKiBAY29uc3RhbnQge3N0cmluZ31cbiAqL1xuZXhwb3J0IGNvbnN0IFNVUEFCQVNFX1VSTCA9IGltcG9ydC5tZXRhLmVudj8uVklURV9TVVBBQkFTRV9VUkwgfHwgJ2h0dHBzOi8vem9xdHZyY3JxbmFhdGtkd21haWwuc3VwYWJhc2UuY28nO1xuXG4vKipcbiAqIEZhc3RBUEkgYmFja2VuZCBVUkwgKGNvbXB1dGUtaGVhdnkgZW5kcG9pbnRzKVxuICogQGNvbnN0YW50IHtzdHJpbmd9XG4gKi9cbmV4cG9ydCBjb25zdCBBUElfVVJMID0gaW1wb3J0Lm1ldGEuZW52Py5WSVRFX0FQSV9VUkwgfHwgJ2h0dHBzOi8vYXBpLXByb2R1Y3Rpb24tODkwZi51cC5yYWlsd2F5LmFwcCc7XG5cbi8qKlxuICogQ29tcHV0ZS1oZWF2eSBlbmRwb2ludHMgcm91dGVkIHRvIEZhc3RBUElcbiAqIFNldCB0byBlbXB0eSBhcnJheSBbXSB0byByb2xsYmFjayBhbGwgcmVxdWVzdHMgdG8gU3VwYWJhc2VcbiAqL1xuY29uc3QgRkFTVEFQSV9FTkRQT0lOVFMgPSBbJ2RhdGEtbm9ybWFsaXplJywgJ2dlbmVyYXRlLXdvcmtmbG93LXRhc2tzJywgJ2dlbmVyYXRlLXdvcmtmbG93LWFnZW5kYXMnLCAnZ2VuZXJhdGUtZGV0YWlsZWQtZmFjdHMnXTtcblxuLyoqXG4gKiBHZXQgZW5kcG9pbnQgVVJMIGJhc2VkIG9uIHJvdXRpbmcgY29uZmlndXJhdGlvblxuICogQHBhcmFtIHtzdHJpbmd9IGVuZHBvaW50IC0gRWRnZSBmdW5jdGlvbiBuYW1lXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBGdWxsIFVSTCBmb3IgdGhlIGVuZHBvaW50XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRFbmRwb2ludFVybChlbmRwb2ludCkge1xuICBpZiAoRkFTVEFQSV9FTkRQT0lOVFMuaW5jbHVkZXMoZW5kcG9pbnQpKSB7XG4gICAgcmV0dXJuIGAke0FQSV9VUkx9L2FwaS92MS8ke2VuZHBvaW50fWA7XG4gIH1cbiAgcmV0dXJuIGAke1NVUEFCQVNFX1VSTH0vZnVuY3Rpb25zL3YxLyR7ZW5kcG9pbnR9YDtcbn1cblxuLyoqXG4gKiBTdXBhYmFzZSBBbm9ueW1vdXMgS2V5IChcdUFDRjVcdUFDMUMgXHVBQzAwXHVCMkE1KVxuICogQGNvbnN0YW50IHtzdHJpbmd9XG4gKi9cbmV4cG9ydCBjb25zdCBTVVBBQkFTRV9BTk9OX0tFWSA9IGltcG9ydC5tZXRhLmVudj8uVklURV9TVVBBQkFTRV9BTk9OX0tFWSB8fCAnZXlKaGJHY2lPaUpJVXpJMU5pSXNJblI1Y0NJNklrcFhWQ0o5LmV5SnBjM01pT2lKemRYQmhZbUZ6WlNJc0luSmxaaUk2SW5wdmNYUjJjbU55Y1c1aFlYUnJaSGR0WVdsc0lpd2ljbTlzWlNJNkltRnViMjRpTENKcFlYUWlPakUzTmprME1EZzVPRGtzSW1WNGNDSTZNakE0TkRrNE5EazRPWDAuajJOTkM1N2ptV1BBTmpHdWZkTFpiMEZQejhsaE9kYXE5VjMyRnYwelpwRSc7XG5cbi8vIERlYnVnOiBMb2cgY29uZmlndXJhdGlvbiB2YWx1ZXNcblxuLyoqXG4gKiBHb29nbGUgT0F1dGggXHVEMDc0XHVCNzdDXHVDNzc0XHVDNUI4XHVEMkI4IElEIChDaHJvbWUgRXh0ZW5zaW9uIFx1RDBDMFx1Qzc4NSlcbiAqIEdvb2dsZSBXb3Jrc3BhY2UgQVBJXHVDNkE5IC0gY2hyb21lLmlkZW50aXR5LmdldEF1dGhUb2tlbigpXHVDNUQwXHVDMTFDIFx1QzBBQ1x1QzZBOVxuICogQGNvbnN0YW50IHtzdHJpbmd9XG4gKi9cbmV4cG9ydCBjb25zdCBHT09HTEVfQ0xJRU5UX0lEID0gaW1wb3J0Lm1ldGEuZW52Py5WSVRFX0dPT0dMRV9DTElFTlRfSUQgfHwgJzE2NzI5MDkwMjEwNC1pbWhycXRuMzFvcnE2dG5vNTVjZW9kbzhnNGI0NTQ3OC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbSc7XG5cbi8qKlxuICogR29vZ2xlIE9BdXRoIFx1RDA3NFx1Qjc3Q1x1Qzc3NFx1QzVCOFx1RDJCOCBJRCAoXHVDNkY5IFx1QzU2MFx1RDUwQ1x1QjlBQ1x1Q0YwMFx1Qzc3NFx1QzE1OCBcdUQwQzBcdUM3ODUpXG4gKiBTdXBhYmFzZSBcdUM3NzhcdUM5OURcdUM2QTkgLSBjaHJvbWUuaWRlbnRpdHkubGF1bmNoV2ViQXV0aEZsb3coKVx1QzVEMFx1QzExQyBcdUMwQUNcdUM2QTlcbiAqIEBjb25zdGFudCB7c3RyaW5nfVxuICovXG5leHBvcnQgY29uc3QgR09PR0xFX0FVVEhfQ0xJRU5UX0lEID0gaW1wb3J0Lm1ldGEuZW52Py5WSVRFX0dPT0dMRV9BVVRIX0NMSUVOVF9JRCB8fCAnMTY3MjkwOTAyMTA0LW0zMXYxbGltbzlxamVjOXM3ZjlyOWs5bHR1NG4yNWIzLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29tJztcblxuLyoqXG4gKiBHb29nbGUgT0F1dGggUmVkaXJlY3QgVVJJXG4gKiBjaHJvbWUuaWRlbnRpdHkubGF1bmNoV2ViQXV0aEZsb3dcdUM1RDBcdUMxMUMgXHVDMEFDXHVDNkE5XG4gKiBAcmV0dXJucyB7c3RyaW5nfSBSZWRpcmVjdCBVUklcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEdvb2dsZVJlZGlyZWN0VVJJKCkge1xuICB0cnkge1xuICAgIHJldHVybiBgaHR0cHM6Ly8ke2Nocm9tZS5ydW50aW1lLmlkfS5jaHJvbWl1bWFwcC5vcmcvYDtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbQ29uZmlnXSBGYWlsZWQgdG8gZ2V0IGNocm9tZS5ydW50aW1lLmlkOicsIGVycm9yKTtcbiAgICByZXR1cm4gJ2h0dHBzOi8vdW5rbm93bi5jaHJvbWl1bWFwcC5vcmcvJztcbiAgfVxufVxuIiwgIi8qKlxuICogR29vZ2xlIFdvcmtzcGFjZSBBUEkgQ2xpZW50XG4gKlxuICogR29vZ2xlIERvY3MsIFNoZWV0cywgU2xpZGVzLCBEcml2ZSBBUEkgXHVDODExXHVBREZDXHVDNzQ0IFx1QzcwNFx1RDU1QyBPQXV0aDIgXHVEMDc0XHVCNzdDXHVDNzc0XHVDNUI4XHVEMkI4XG4gKlxuICogT0F1dGggRmxvdzpcbiAqIDEuIGNocm9tZS5pZGVudGl0eS5sYXVuY2hXZWJBdXRoRmxvd1x1Qjg1QyBcdUM3NzhcdUM5OURcbiAqIDIuIGFjY2Vzc190b2tlbiBcdUQ2OERcdUI0REQgKEdvb2dsZSBXb3Jrc3BhY2UgQVBJXHVDNkE5KVxuICogMy4gUkVTVCBBUEkgXHVENjM4XHVDRDlDXG4gKlxuICogQHNlZSBodHRwczovL2RldmVsb3BlcnMuZ29vZ2xlLmNvbS9kb2NzL2FwaS9yZWZlcmVuY2UvcmVzdFxuICogQHNlZSBodHRwczovL2RldmVsb3BlcnMuZ29vZ2xlLmNvbS9zaGVldHMvYXBpL3JlZmVyZW5jZS9yZXN0XG4gKiBAc2VlIGh0dHBzOi8vZGV2ZWxvcGVycy5nb29nbGUuY29tL3NsaWRlcy9hcGkvcmVmZXJlbmNlL3Jlc3RcbiAqL1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBPQXV0aDIgXHVDNzc4XHVDOTlEIChjaHJvbWUuaWRlbnRpdHkuZ2V0QXV0aFRva2VuIFx1QkMyOVx1QzJERClcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBHb29nbGUgV29ya3NwYWNlIEFQSSBcdUM4MTFcdUFERkNcdUM3NDQgXHVDNzA0XHVENTVDIE9BdXRoMiBcdUM3NzhcdUM5OURcbiAqIGNocm9tZS5pZGVudGl0eS5nZXRBdXRoVG9rZW4oKVx1Qzc0NCBcdUMwQUNcdUM2QTlcdUQ1NThcdUM1RUMgQ2hyb21lXHVDNzc0IFx1RDFBMFx1RDA3MCBcdUFEMDBcdUI5QUNcbiAqXG4gKiBAcGFyYW0ge2Jvb2xlYW59IGludGVyYWN0aXZlIC0gXHVDMEFDXHVDNkE5XHVDNzkwIFx1QzBDMVx1RDYzOFx1Qzc5MVx1QzZBOSBcdUQ1QzhcdUM2QTkgXHVDNUVDXHVCRDgwXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxzdHJpbmc+fSBBY2Nlc3MgdG9rZW5cbiAqIEB0aHJvd3Mge0Vycm9yfSBcdUM3NzhcdUM5OUQgXHVDMkU0XHVEMzI4IFx1QzJEQ1xuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYXV0aG9yaXplR29vZ2xlV29ya3NwYWNlKGludGVyYWN0aXZlID0gdHJ1ZSkge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXG4gICAgY2hyb21lLmlkZW50aXR5LmdldEF1dGhUb2tlbih7IGludGVyYWN0aXZlIH0sICh0b2tlbikgPT4ge1xuICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbR29vZ2xlIEFQSV0gT0F1dGggZmxvdyBlcnJvcjonLCBjaHJvbWUucnVudGltZS5sYXN0RXJyb3IpO1xuICAgICAgICByZXR1cm4gcmVqZWN0KG5ldyBFcnJvcihjaHJvbWUucnVudGltZS5sYXN0RXJyb3IubWVzc2FnZSkpO1xuICAgICAgfVxuXG4gICAgICBpZiAoIXRva2VuKSB7XG4gICAgICAgIHJldHVybiByZWplY3QobmV3IEVycm9yKCdObyB0b2tlbiByZWNlaXZlZCcpKTtcbiAgICAgIH1cblxuICAgICAgcmVzb2x2ZSh0b2tlbik7XG4gICAgfSk7XG4gIH0pO1xufVxuXG4vKipcbiAqIFx1QzgwMFx1QzdBNVx1QjQxQyBhY2Nlc3MgdG9rZW4gXHVBQzAwXHVDODM4XHVDNjI0XHVBRTMwIChcdUNFOTBcdUMyRENcdUI0MUMgXHVEMUEwXHVEMDcwIFx1QkMxOFx1RDY1OClcbiAqIENocm9tZVx1Qzc3NCBcdUQxQTBcdUQwNzAgXHVCOUNDXHVCOENDXHVCOTdDIFx1Qzc5MFx1QjNEOSBcdUFEMDBcdUI5QUNcbiAqXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxzdHJpbmd8bnVsbD59IEFjY2VzcyB0b2tlbiBvciBudWxsXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRBY2Nlc3NUb2tlbigpIHtcbiAgdHJ5IHtcbiAgICAvLyBpbnRlcmFjdGl2ZTogZmFsc2VcdUI4NUMgXHVDRTkwXHVDMkRDXHVCNDFDIFx1RDFBMFx1RDA3MFx1QjlDQyBcdUQ2NTVcdUM3NzhcbiAgICBjb25zdCB0b2tlbiA9IGF3YWl0IGF1dGhvcml6ZUdvb2dsZVdvcmtzcGFjZShmYWxzZSk7XG4gICAgcmV0dXJuIHRva2VuO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogXHVEMUEwXHVEMDcwIFx1QzcyMFx1RDZBOFx1QzEzMSBcdUQ2NTVcdUM3NzggXHVCQzBGIFx1Qzc5MFx1QjNEOSBcdUM3QUNcdUM3NzhcdUM5OURcbiAqXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxzdHJpbmc+fSBWYWxpZCBhY2Nlc3MgdG9rZW5cbiAqIEB0aHJvd3Mge0Vycm9yfSBcdUM3QUNcdUM3NzhcdUM5OUQgXHVDMkU0XHVEMzI4IFx1QzJEQ1xuICovXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVWYWxpZFRva2VuKCkge1xuICAvLyBpbnRlcmFjdGl2ZTogdHJ1ZVx1Qjg1QyBcdUQ1NDRcdUM2OTRcdUMyREMgXHVDMEFDXHVDNkE5XHVDNzkwXHVDNUQwXHVBQzhDIFx1Qzc3OFx1Qzk5RCBcdUM2OTRcdUNDQURcbiAgcmV0dXJuIGF3YWl0IGF1dGhvcml6ZUdvb2dsZVdvcmtzcGFjZSh0cnVlKTtcbn1cblxuLyoqXG4gKiBcdUNFOTBcdUMyRENcdUI0MUMgXHVEMUEwXHVEMDcwIFx1QzgxQ1x1QUM3MCAoXHVCODVDXHVBREY4XHVDNTQ0XHVDNkMzIFx1QjYxMFx1QjI5NCBcdUQxQTBcdUQwNzAgXHVBQzMxXHVDMkUwIFx1RDU0NFx1QzY5NCBcdUMyREMpXG4gKlxuICogQHJldHVybnMge1Byb21pc2U8dm9pZD59XG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXZva2VUb2tlbigpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjaHJvbWUuaWRlbnRpdHkuZ2V0QXV0aFRva2VuKHsgaW50ZXJhY3RpdmU6IGZhbHNlIH0sICh0b2tlbikgPT4ge1xuICAgICAgaWYgKHRva2VuKSB7XG4gICAgICAgIGNocm9tZS5pZGVudGl0eS5yZW1vdmVDYWNoZWRBdXRoVG9rZW4oeyB0b2tlbiB9LCAoKSA9PiB7XG4gICAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEdvb2dsZSBEb2NzIEFQSVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIEdvb2dsZSBEb2NzIFx1QkIzOFx1QzExQyBcdUIwQjRcdUM2QTkgXHVBQzAwXHVDODM4XHVDNjI0XHVBRTMwXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IGRvY3VtZW50SWQgLSBcdUJCMzhcdUMxMUMgSURcbiAqIEByZXR1cm5zIHtQcm9taXNlPE9iamVjdD59IERvY3VtZW50IG9iamVjdFxuICogQHRocm93cyB7RXJyb3J9IEFQSSBcdUQ2MzhcdUNEOUMgXHVDMkU0XHVEMzI4IFx1QzJEQ1xuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0RG9jdW1lbnQoZG9jdW1lbnRJZCkge1xuICBjb25zdCB0b2tlbiA9IGF3YWl0IGVuc3VyZVZhbGlkVG9rZW4oKTtcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFxuICAgIGBodHRwczovL2RvY3MuZ29vZ2xlYXBpcy5jb20vdjEvZG9jdW1lbnRzLyR7ZG9jdW1lbnRJZH1gLFxuICAgIHtcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7dG9rZW59YFxuICAgICAgfVxuICAgIH1cbiAgKTtcblxuICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgY29uc3QgZXJyb3IgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBEb2NzIEFQSSBlcnJvcjogJHtyZXNwb25zZS5zdGF0dXN9IC0gJHtlcnJvcn1gKTtcbiAgfVxuXG4gIHJldHVybiBhd2FpdCByZXNwb25zZS5qc29uKCk7XG59XG5cbi8qKlxuICogR29vZ2xlIERvY3MgXHVCQjM4XHVDMTFDXHVDNUQwXHVDMTFDIFx1RDE0RFx1QzJBNFx1RDJCOCBcdUNEOTRcdUNEOUNcbiAqXG4gKiBAcGFyYW0ge3N0cmluZ30gZG9jdW1lbnRJZCAtIFx1QkIzOFx1QzExQyBJRFxuICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nPn0gXHVCQjM4XHVDMTFDIFx1RDE0RFx1QzJBNFx1RDJCOFxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0RG9jdW1lbnRUZXh0KGRvY3VtZW50SWQpIHtcbiAgY29uc3QgZG9jID0gYXdhaXQgZ2V0RG9jdW1lbnQoZG9jdW1lbnRJZCk7XG5cbiAgbGV0IHRleHQgPSAnJztcblxuICAvLyBEb2N1bWVudCBib2R5IFx1QzIxQ1x1RDY4Q1x1RDU1OFx1QkE3MCBcdUQxNERcdUMyQTRcdUQyQjggXHVDRDk0XHVDRDlDXG4gIGlmIChkb2MuYm9keSAmJiBkb2MuYm9keS5jb250ZW50KSB7XG4gICAgZm9yIChjb25zdCBlbGVtZW50IG9mIGRvYy5ib2R5LmNvbnRlbnQpIHtcbiAgICAgIGlmIChlbGVtZW50LnBhcmFncmFwaCkge1xuICAgICAgICBmb3IgKGNvbnN0IGVsIG9mIGVsZW1lbnQucGFyYWdyYXBoLmVsZW1lbnRzIHx8IFtdKSB7XG4gICAgICAgICAgaWYgKGVsLnRleHRSdW4gJiYgZWwudGV4dFJ1bi5jb250ZW50KSB7XG4gICAgICAgICAgICB0ZXh0ICs9IGVsLnRleHRSdW4uY29udGVudDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gdGV4dDtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gR29vZ2xlIFNoZWV0cyBBUElcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBHb29nbGUgU2hlZXRzIFx1QzJBNFx1RDUwNFx1QjgwOFx1QjREQ1x1QzJEQ1x1RDJCOCBcdUJBNTRcdUQwQzBcdUIzNzBcdUM3NzRcdUQxMzAgXHVBQzAwXHVDODM4XHVDNjI0XHVBRTMwXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IHNwcmVhZHNoZWV0SWQgLSBcdUMyQTRcdUQ1MDRcdUI4MDhcdUI0RENcdUMyRENcdUQyQjggSURcbiAqIEByZXR1cm5zIHtQcm9taXNlPE9iamVjdD59IFNwcmVhZHNoZWV0IG9iamVjdFxuICogQHRocm93cyB7RXJyb3J9IEFQSSBcdUQ2MzhcdUNEOUMgXHVDMkU0XHVEMzI4IFx1QzJEQ1xuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0U3ByZWFkc2hlZXQoc3ByZWFkc2hlZXRJZCkge1xuICBjb25zdCB0b2tlbiA9IGF3YWl0IGVuc3VyZVZhbGlkVG9rZW4oKTtcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFxuICAgIGBodHRwczovL3NoZWV0cy5nb29nbGVhcGlzLmNvbS92NC9zcHJlYWRzaGVldHMvJHtzcHJlYWRzaGVldElkfWAsXG4gICAge1xuICAgICAgaGVhZGVyczoge1xuICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHt0b2tlbn1gXG4gICAgICB9XG4gICAgfVxuICApO1xuXG4gIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICBjb25zdCBlcnJvciA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFNoZWV0cyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAtICR7ZXJyb3J9YCk7XG4gIH1cblxuICByZXR1cm4gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xufVxuXG4vKipcbiAqIEdvb2dsZSBTaGVldHMgXHVEMkI5XHVDODE1IFx1QkM5NFx1QzcwNCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVBQzAwXHVDODM4XHVDNjI0XHVBRTMwXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IHNwcmVhZHNoZWV0SWQgLSBcdUMyQTRcdUQ1MDRcdUI4MDhcdUI0RENcdUMyRENcdUQyQjggSURcbiAqIEBwYXJhbSB7c3RyaW5nfSByYW5nZSAtIFx1QkM5NFx1QzcwNCAoXHVDNjA4OiAnU2hlZXQxIUExOkQxMCcpXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxBcnJheTxBcnJheTxzdHJpbmc+Pj59IDJEIFx1QkMzMFx1QzVGNCBcdUIzNzBcdUM3NzRcdUQxMzBcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFNoZWV0VmFsdWVzKHNwcmVhZHNoZWV0SWQsIHJhbmdlKSB7XG4gIGNvbnN0IHRva2VuID0gYXdhaXQgZW5zdXJlVmFsaWRUb2tlbigpO1xuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXG4gICAgYGh0dHBzOi8vc2hlZXRzLmdvb2dsZWFwaXMuY29tL3Y0L3NwcmVhZHNoZWV0cy8ke3NwcmVhZHNoZWV0SWR9L3ZhbHVlcy8ke2VuY29kZVVSSUNvbXBvbmVudChyYW5nZSl9YCxcbiAgICB7XG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3Rva2VufWBcbiAgICAgIH1cbiAgICB9XG4gICk7XG5cbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIGNvbnN0IGVycm9yID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgIHRocm93IG5ldyBFcnJvcihgU2hlZXRzIEFQSSBlcnJvcjogJHtyZXNwb25zZS5zdGF0dXN9IC0gJHtlcnJvcn1gKTtcbiAgfVxuXG4gIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gIHJldHVybiBkYXRhLnZhbHVlcyB8fCBbXTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gR29vZ2xlIFNsaWRlcyBBUElcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBHb29nbGUgU2xpZGVzIFx1RDUwNFx1QjgwOFx1QzgyMFx1RDE0Q1x1Qzc3NFx1QzE1OCBcdUFDMDBcdUM4MzhcdUM2MjRcdUFFMzBcbiAqXG4gKiBAcGFyYW0ge3N0cmluZ30gcHJlc2VudGF0aW9uSWQgLSBcdUQ1MDRcdUI4MDhcdUM4MjBcdUQxNENcdUM3NzRcdUMxNTggSURcbiAqIEByZXR1cm5zIHtQcm9taXNlPE9iamVjdD59IFByZXNlbnRhdGlvbiBvYmplY3RcbiAqIEB0aHJvd3Mge0Vycm9yfSBBUEkgXHVENjM4XHVDRDlDIFx1QzJFNFx1RDMyOCBcdUMyRENcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFByZXNlbnRhdGlvbihwcmVzZW50YXRpb25JZCkge1xuICBjb25zdCB0b2tlbiA9IGF3YWl0IGVuc3VyZVZhbGlkVG9rZW4oKTtcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFxuICAgIGBodHRwczovL3NsaWRlcy5nb29nbGVhcGlzLmNvbS92MS9wcmVzZW50YXRpb25zLyR7cHJlc2VudGF0aW9uSWR9YCxcbiAgICB7XG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3Rva2VufWBcbiAgICAgIH1cbiAgICB9XG4gICk7XG5cbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIGNvbnN0IGVycm9yID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgIHRocm93IG5ldyBFcnJvcihgU2xpZGVzIEFQSSBlcnJvcjogJHtyZXNwb25zZS5zdGF0dXN9IC0gJHtlcnJvcn1gKTtcbiAgfVxuXG4gIHJldHVybiBhd2FpdCByZXNwb25zZS5qc29uKCk7XG59XG5cbi8qKlxuICogR29vZ2xlIFNsaWRlcyBcdUQ1MDRcdUI4MDhcdUM4MjBcdUQxNENcdUM3NzRcdUMxNThcdUM1RDBcdUMxMUMgXHVEMTREXHVDMkE0XHVEMkI4IFx1Q0Q5NFx1Q0Q5Q1xuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSBwcmVzZW50YXRpb25JZCAtIFx1RDUwNFx1QjgwOFx1QzgyMFx1RDE0Q1x1Qzc3NFx1QzE1OCBJRFxuICogQHJldHVybnMge1Byb21pc2U8e3NsaWRlczogQXJyYXk8e3NsaWRlTnVtYmVyOiBudW1iZXIsIHRleHQ6IHN0cmluZ30+LCBmdWxsVGV4dDogc3RyaW5nfT59XG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRQcmVzZW50YXRpb25UZXh0KHByZXNlbnRhdGlvbklkKSB7XG4gIGNvbnN0IHByZXNlbnRhdGlvbiA9IGF3YWl0IGdldFByZXNlbnRhdGlvbihwcmVzZW50YXRpb25JZCk7XG5cbiAgY29uc3Qgc2xpZGVzID0gW107XG4gIGxldCBmdWxsVGV4dCA9ICcnO1xuXG4gIGlmIChwcmVzZW50YXRpb24uc2xpZGVzKSB7XG4gICAgcHJlc2VudGF0aW9uLnNsaWRlcy5mb3JFYWNoKChzbGlkZSwgaW5kZXgpID0+IHtcbiAgICAgIGxldCBzbGlkZVRleHQgPSAnJztcblxuICAgICAgLy8gXHVDMkFDXHVCNzdDXHVDNzc0XHVCNERDXHVDNzU4IFx1QkFBOFx1QjRFMCBcdUM2OTRcdUMxOEMgXHVDMjFDXHVENjhDXG4gICAgICBpZiAoc2xpZGUucGFnZUVsZW1lbnRzKSB7XG4gICAgICAgIGZvciAoY29uc3QgZWxlbWVudCBvZiBzbGlkZS5wYWdlRWxlbWVudHMpIHtcbiAgICAgICAgICAvLyBTaGFwZSBcdUM2OTRcdUMxOENcdUM3NTggXHVEMTREXHVDMkE0XHVEMkI4IFx1Q0Q5NFx1Q0Q5Q1xuICAgICAgICAgIGlmIChlbGVtZW50LnNoYXBlICYmIGVsZW1lbnQuc2hhcGUudGV4dCkge1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0RWxlbWVudCBvZiBlbGVtZW50LnNoYXBlLnRleHQudGV4dEVsZW1lbnRzIHx8IFtdKSB7XG4gICAgICAgICAgICAgIGlmICh0ZXh0RWxlbWVudC50ZXh0UnVuICYmIHRleHRFbGVtZW50LnRleHRSdW4uY29udGVudCkge1xuICAgICAgICAgICAgICAgIHNsaWRlVGV4dCArPSB0ZXh0RWxlbWVudC50ZXh0UnVuLmNvbnRlbnQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKHNsaWRlVGV4dC50cmltKCkpIHtcbiAgICAgICAgc2xpZGVzLnB1c2goe1xuICAgICAgICAgIHNsaWRlTnVtYmVyOiBpbmRleCArIDEsXG4gICAgICAgICAgdGV4dDogc2xpZGVUZXh0LnRyaW0oKVxuICAgICAgICB9KTtcbiAgICAgICAgZnVsbFRleHQgKz0gc2xpZGVUZXh0ICsgJ1xcbic7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4geyBzbGlkZXMsIGZ1bGxUZXh0OiBmdWxsVGV4dC50cmltKCkgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gR29vZ2xlIERyaXZlIEFQSVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIEdvb2dsZSBEcml2ZSBcdUQzMENcdUM3N0MgXHVCQTU0XHVEMEMwXHVCMzcwXHVDNzc0XHVEMTMwIFx1QUMwMFx1QzgzOFx1QzYyNFx1QUUzMFxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSBmaWxlSWQgLSBcdUQzMENcdUM3N0MgSURcbiAqIEByZXR1cm5zIHtQcm9taXNlPE9iamVjdD59IEZpbGUgbWV0YWRhdGFcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEZpbGVNZXRhZGF0YShmaWxlSWQpIHtcbiAgY29uc3QgdG9rZW4gPSBhd2FpdCBlbnN1cmVWYWxpZFRva2VuKCk7XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcbiAgICBgaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vZHJpdmUvdjMvZmlsZXMvJHtmaWxlSWR9P2ZpZWxkcz1pZCxuYW1lLG1pbWVUeXBlLG1vZGlmaWVkVGltZSxvd25lcnNgLFxuICAgIHtcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7dG9rZW59YFxuICAgICAgfVxuICAgIH1cbiAgKTtcblxuICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgY29uc3QgZXJyb3IgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBEcml2ZSBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAtICR7ZXJyb3J9YCk7XG4gIH1cblxuICByZXR1cm4gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xufVxuXG4iLCAiLyoqXG4gKiBCYWNrZ3JvdW5kIFNlcnZpY2UgV29ya2VyIChNYW5pZmVzdCBWMylcbiAqXG4gKiBcdUM1RURcdUQ1NjA6XG4gKiAxLiBDb250ZW50IHNjcmlwdFx1Qjg1Q1x1QkQ4MFx1RDEzMCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDMjE4XHVDMkUwIChEQVRBX0NBUFRVUkVELCBUQUJfVFJBTlNJVElPTilcbiAqIDIuIFRhYiB0cmFuc2l0aW9uIFx1QjlFNFx1Q0U2RCAoZnJvbS90byBcdUMzMEQgXHVDMEREXHVDMTMxKVxuICogMy4gXHVCMzcwXHVDNzc0XHVEMTMwIFx1QkM4NFx1RDM3Q1x1QjlDMSBcdUJDMEYgNVx1QkQ4NCBcdUFDMDRcdUFDQTkgXHVCQzMwXHVDRTU4IFx1QzgwNFx1QzFBMVxuICogNC4gXHVCODVDXHVBREY4XHVDNzc4IFx1QzBDMVx1RDBEQyBcdUFEMDBcdUI5QUNcbiAqXG4gKiBAc2VlIHJlc2VhcmNoLm1kIDQuM1x1QzgwOFxuICovXG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIENSSVRJQ0FMOiBvbk1lc3NhZ2UgXHVCOUFDXHVDMkE0XHVCMTA4XHVCOTdDIFx1Q0Q1Q1x1QzBDMVx1QjJFOFx1QzVEMCBcdUI0RjFcdUI4NUQgKFJhY2UgQ29uZGl0aW9uIFx1QkMyOVx1QzlDMClcbi8vIENvbnRlbnQgc2NyaXB0XHVBQzAwIFx1QkE1NFx1QzJEQ1x1QzlDMFx1Qjk3QyBcdUJDRjRcdUIwQjRcdUFFMzAgXHVDODA0XHVDNUQwIFx1RDU3OFx1QjRFNFx1QjdFQ1x1QUMwMCBcdUJDMThcdUI0RENcdUMyREMgXHVCNEYxXHVCODVEXHVCNDE4XHVDNUI0XHVDNTdDIFx1RDU2OFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1lc3NhZ2UsIHNlbmRlciwgc2VuZFJlc3BvbnNlKSA9PiB7XG4gIC8vIE1lc3NhZ2Ugcm91dGluZyAocHJvZHVjdGlvbiBtb2RlKVxuXG4gIGlmIChtZXNzYWdlLmFjdGlvbiA9PT0gJ0RBVEFfQ0FQVFVSRUQnKSB7XG4gICAgaGFuZGxlRGF0YUNhcHR1cmVkKG1lc3NhZ2UucGF5bG9hZCwgc2VuZGVyKTtcbiAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pO1xuICB9IGVsc2UgaWYgKG1lc3NhZ2UuYWN0aW9uID09PSAnVEFCX1RSQU5TSVRJT04nKSB7XG4gICAgaGFuZGxlVGFiVHJhbnNpdGlvbihtZXNzYWdlLnBheWxvYWQsIHNlbmRlcik7XG4gICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KTtcbiAgfSBlbHNlIGlmIChtZXNzYWdlLmFjdGlvbiA9PT0gJ0dPT0dMRV9BUElfUkVRVUVTVCcpIHtcbiAgICAvLyBHb29nbGUgQVBJIFx1QzY5NFx1Q0NBRCAoXHVCRTQ0XHVCM0Q5XHVBRTMwIFx1Q0M5OFx1QjlBQylcbiAgICBoYW5kbGVHb29nbGVBcGlSZXF1ZXN0KG1lc3NhZ2UucGF5bG9hZClcbiAgICAgIC50aGVuKHJlc3VsdCA9PiBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlLCBkYXRhOiByZXN1bHQgfSkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlcnJvci5tZXNzYWdlIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTsgLy8gXHVCRTQ0XHVCM0Q5XHVBRTMwIFx1Qzc1MVx1QjJGNVxuICB9IGVsc2UgaWYgKG1lc3NhZ2UuYWN0aW9uID09PSAnQVVUSE9SSVpFX0dPT0dMRV9XT1JLU1BBQ0UnKSB7XG4gICAgLy8gR29vZ2xlIFdvcmtzcGFjZSBPQXV0aCBcdUM3NzhcdUM5OURcbiAgICBhdXRob3JpemVHb29nbGVXb3Jrc3BhY2UoKVxuICAgICAgLnRoZW4odG9rZW4gPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSwgdG9rZW4gfSkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlcnJvci5tZXNzYWdlIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTsgLy8gXHVCRTQ0XHVCM0Q5XHVBRTMwIFx1Qzc1MVx1QjJGNVxuICB9IGVsc2UgaWYgKG1lc3NhZ2UuYWN0aW9uID09PSAnU1RBUlRfQ09MTEVDVElPTicpIHtcbiAgICAvLyBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDMjE4XHVDOUQxIFx1QzJEQ1x1Qzc5MVxuICAgIGhhbmRsZVN0YXJ0Q29sbGVjdGlvbigpXG4gICAgICAudGhlbihyZXN1bHQgPT4gc2VuZFJlc3BvbnNlKHJlc3VsdCkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlcnJvci5tZXNzYWdlIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBlbHNlIGlmIChtZXNzYWdlLmFjdGlvbiA9PT0gJ1NUT1BfQ09MTEVDVElPTicpIHtcbiAgICAvLyBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDMjE4XHVDOUQxIFx1QzkxMVx1QzlDMFxuICAgIGhhbmRsZVN0b3BDb2xsZWN0aW9uKClcbiAgICAgIC50aGVuKHJlc3VsdCA9PiBzZW5kUmVzcG9uc2UocmVzdWx0KSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfSkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGVsc2UgaWYgKG1lc3NhZ2UuYWN0aW9uID09PSAnRk9SQ0VfRkxVU0gnKSB7XG4gICAgLy8gXHVCQUE4XHVCNEUwIFx1RDBFRFx1QzVEMCBGTFVTSF9OT1cgXHVCRTBDXHVCODVDXHVCNERDXHVDRTkwXHVDMkE0XHVEMkI4IFx1RDZDNCBcdUJDMzBcdUNFNTggXHVDODA0XHVDMUExXG4gICAgaGFuZGxlRm9yY2VGbHVzaCgpXG4gICAgICAudGhlbihyZXN1bHQgPT4gc2VuZFJlc3BvbnNlKHJlc3VsdCkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlcnJvci5tZXNzYWdlIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBlbHNlIGlmIChtZXNzYWdlLmFjdGlvbiA9PT0gJ0dFVF9DT0xMRUNUSU9OX1NUQVRFJykge1xuICAgIC8vIFx1RDYwNFx1QzdBQyBcdUMyMThcdUM5RDEgXHVDMEMxXHVEMERDIFx1Qzg3MFx1RDY4Q1xuICAgIGhhbmRsZUdldENvbGxlY3Rpb25TdGF0ZSgpXG4gICAgICAudGhlbihyZXN1bHQgPT4gc2VuZFJlc3BvbnNlKHJlc3VsdCkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlcnJvci5tZXNzYWdlIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLndhcm4oJ1tEYWlseSBTY3J1bV0gVW5rbm93biBhY3Rpb246JywgbWVzc2FnZS5hY3Rpb24pO1xuICAgIHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogJ1Vua25vd24gYWN0aW9uJyB9KTtcbiAgfVxuXG4gIHJldHVybiB0cnVlOyAvLyBcdUJFNDRcdUIzRDlcdUFFMzAgc2VuZFJlc3BvbnNlIFx1QzcyMFx1QzlDMFxufSk7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEltcG9ydFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5pbXBvcnQgeyB0ZW1wQnVmZmVyIH0gZnJvbSAnLi9saWIvdGVtcC1idWZmZXIuanMnO1xuaW1wb3J0IHsgZW5jcnlwdGlvbkVuZ2luZSB9IGZyb20gJy4vbGliL2VuY3J5cHRpb24uanMnO1xuaW1wb3J0IHsgU1VQQUJBU0VfVVJMLCBTVVBBQkFTRV9BTk9OX0tFWSB9IGZyb20gJy4vbGliL2NvbmZpZy5qcyc7XG5pbXBvcnQge1xuICBhdXRob3JpemVHb29nbGVXb3Jrc3BhY2UsXG4gIGdldEFjY2Vzc1Rva2VuLFxuICBnZXREb2N1bWVudFRleHQsXG4gIGdldFNwcmVhZHNoZWV0LFxuICBnZXRQcmVzZW50YXRpb25UZXh0XG59IGZyb20gJy4vbGliL2dvb2dsZS1hcGktY2xpZW50LmpzJztcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHVDMEMxXHVDMjE4XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmNvbnN0IEJBVENIX1NFTkRfSU5URVJWQUwgPSAxOyAvLyAxXHVCRDg0IChjaHJvbWUuYWxhcm1zIFx1Q0Q1Q1x1QzE4QyBcdUM4RkNcdUFFMzApXG5jb25zdCBNQVhfUkVUUllfQVRURU1QVFMgPSAzOyAvLyBcdUM3QUNcdUMyRENcdUIzQzQgXHVENjlGXHVDMjE4XG5jb25zdCBJTklUSUFMX1JFVFJZX0RFTEFZID0gMTAwMDsgLy8gXHVDRDA4XHVBRTMwIFx1QzdBQ1x1QzJEQ1x1QjNDNCBcdUM5QzBcdUM1RjAgKG1zKVxuXG5jb25zdCBTVE9SQUdFX0tFWVMgPSB7XG4gIENPTlNFTlRfR0lWRU46ICdjb25zZW50R2l2ZW4nLFxuICBJU19MT0dHRURfSU46ICdpc0xvZ2dlZEluJyxcbiAgVVNFUl9JRDogJ3VzZXJJZCcsXG4gIFNFTkRfUVVFVUU6ICdzZW5kUXVldWUnLFxuICBMQVNUX1RSQU5TSVRJT046ICdsYXN0VHJhbnNpdGlvbicsXG4gIEFDVElWRV9UQUJfSU5GTzogJ2FjdGl2ZVRhYkluZm8nLFxuICBTRVJWRVJfU0FMVDogJ3NlcnZlclNhbHQnLFxuICBBVVRIX1RPS0VOOiAnYXV0aFRva2VuJyxcbiAgUkVGUkVTSF9UT0tFTjogJ3JlZnJlc2hUb2tlbicsXG4gIElTX0NPTExFQ1RJTkc6ICdpc0NvbGxlY3RpbmcnLFxuICBDT0xMRUNUSU9OX1NUQVJUX1RJTUU6ICdjb2xsZWN0aW9uU3RhcnRUaW1lJyxcbiAgQ09MTEVDVElPTl9TVE9QX1RJTUU6ICdjb2xsZWN0aW9uU3RvcFRpbWUnLFxuICBMQVNUX0dFTkVSQVRFRF9SQU5HRTogJ2xhc3RHZW5lcmF0ZWRSYW5nZSdcbn07XG5cbi8vIENvbnRlbnQgc2NyaXB0IFx1QjlFNFx1RDU1MSAobWFuaWZlc3QuanNvblx1Qzc1OCBjb250ZW50X3NjcmlwdHNcdUM2NDAgXHVCM0Q5XHVBRTMwXHVENjU0KVxuY29uc3QgQ09OVEVOVF9TQ1JJUFRfTUFQUElORyA9IFtcbiAge1xuICAgIHBhdHRlcm5zOiBbJ2h0dHBzOi8vY2hhdGdwdC5jb20vKicsICdodHRwczovL2NoYXQub3BlbmFpLmNvbS8qJywgJ2h0dHBzOi8vY2xhdWRlLmFpLyonLCAnaHR0cHM6Ly9nZW1pbmkuZ29vZ2xlLmNvbS8qJ10sXG4gICAgc2NyaXB0czogWydjb250ZW50LXNjcmlwdHMvbGxtLWNhcHR1cmUuanMnLCAnY29udGVudC1zY3JpcHRzL2ludGVyYWN0aW9uLXRyYWNrZXIuanMnXVxuICB9LFxuICB7XG4gICAgcGF0dGVybnM6IFsnaHR0cHM6Ly93d3cubm90aW9uLnNvLyonLCAnaHR0cHM6Ly9hcHAuc2xhY2suY29tLyonXSxcbiAgICBzY3JpcHRzOiBbJ2NvbnRlbnQtc2NyaXB0cy9jb2xsYWItY2FwdHVyZS5qcycsICdjb250ZW50LXNjcmlwdHMvaW50ZXJhY3Rpb24tdHJhY2tlci5qcyddXG4gIH0sXG4gIHtcbiAgICBwYXR0ZXJuczogWydodHRwczovL2RvY3MuZ29vZ2xlLmNvbS8qJywgJ2h0dHBzOi8vc2hlZXRzLmdvb2dsZS5jb20vKicsICdodHRwczovL3NsaWRlcy5nb29nbGUuY29tLyonLCAnaHR0cHM6Ly9kcml2ZS5nb29nbGUuY29tLyonXSxcbiAgICBzY3JpcHRzOiBbJ2NvbnRlbnQtc2NyaXB0cy9nb29nbGUtY2FwdHVyZS5qcycsICdjb250ZW50LXNjcmlwdHMvaW50ZXJhY3Rpb24tdHJhY2tlci5qcyddXG4gIH0sXG4gIHtcbiAgICBwYXR0ZXJuczogWydodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy8qJywgJ2h0dHBzOi8vc3RhY2tvdmVyZmxvdy5jb20vKicsICdodHRwczovL2dpdGh1Yi5jb20vKicsICdodHRwczovL21lZGl1bS5jb20vKicsICdodHRwczovL2Rldi50by8qJ10sXG4gICAgc2NyaXB0czogWydjb250ZW50LXNjcmlwdHMvd2ViLXJlZmVyZW5jZS10cmFja2VyLmpzJ11cbiAgfVxuXTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gVG9rZW4gUmVmcmVzaCBMb2dpYyAoU2VydmljZSBXb3JrZXIgXHVDN0FDXHVDMkRDXHVDNzkxIFx1QjMwMFx1Qzc1MSlcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBTdXBhYmFzZSByZWZyZXNoIHRva2VuXHVDNzQ0IFx1QzBBQ1x1QzZBOVx1RDU3NFx1QzExQyBcdUMwQzhcdUI4NUNcdUM2QjQgYWNjZXNzIHRva2VuIFx1RDY4RFx1QjRERFxuICogU2VydmljZSBXb3JrZXJcdUFDMDAgXHVCRTQ0XHVENjVDXHVDMTMxXHVENjU0XHVCNDE4XHVDNUM4XHVCMkU0XHVBQzAwIFx1QzdBQ1x1RDY1Q1x1QzEzMVx1RDY1NFx1QjQyMCBcdUI1NEMgXHVENTQ0XHVDNjk0XG4gKlxuICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nfG51bGw+fSBcdUMwQzggYWNjZXNzIHRva2VuIFx1QjYxMFx1QjI5NCBudWxsIChcdUMyRTRcdUQzMjggXHVDMkRDKVxuICovXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoQXV0aFRva2VuKCkge1xuICB0cnkge1xuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbJ3JlZnJlc2hUb2tlbiddKTtcblxuICAgIGlmICghc3RvcmVkLnJlZnJlc2hUb2tlbikge1xuICAgICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBcdTI3NEMgTm8gcmVmcmVzaCB0b2tlbiBpbiBzdG9yYWdlJyk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBcdUQ4M0RcdUREMDQgUmVmcmVzaGluZyBhdXRoIHRva2VuLi4uJyk7XG5cbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGAke1NVUEFCQVNFX1VSTH0vYXV0aC92MS90b2tlbj9ncmFudF90eXBlPXJlZnJlc2hfdG9rZW5gLCB7XG4gICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgJ2FwaWtleSc6IFNVUEFCQVNFX0FOT05fS0VZXG4gICAgICB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICByZWZyZXNoX3Rva2VuOiBzdG9yZWQucmVmcmVzaFRva2VuXG4gICAgICB9KVxuICAgIH0pO1xuXG4gICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgY29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBcdTI3NEMgVG9rZW4gcmVmcmVzaCBmYWlsZWQ6JywgZXJyb3JUZXh0KTtcblxuICAgICAgLy8gcmVmcmVzaCB0b2tlblx1QjNDNCBcdUI5Q0NcdUI4Q0NcdUI0MUMgXHVBQ0JEXHVDNkIwIFx1Qjg1Q1x1QURGOFx1QzU0NFx1QzZDMyBcdUNDOThcdUI5QUNcbiAgICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQwMCB8fCByZXNwb25zZS5zdGF0dXMgPT09IDQwMSkge1xuICAgICAgICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBcdUQ4M0RcdUREMTIgU2Vzc2lvbiBleHBpcmVkLCBjbGVhcmluZyBhdXRoIHN0YXRlLi4uJyk7XG4gICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7XG4gICAgICAgICAgaXNMb2dnZWRJbjogZmFsc2UsXG4gICAgICAgICAgYXV0aFRva2VuOiBudWxsLFxuICAgICAgICAgIHJlZnJlc2hUb2tlbjogbnVsbFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG5cbiAgICAvLyBcdUMwQzggXHVEMUEwXHVEMDcwIFx1QzgwMFx1QzdBNVxuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7XG4gICAgICBhdXRoVG9rZW46IGRhdGEuYWNjZXNzX3Rva2VuLFxuICAgICAgcmVmcmVzaFRva2VuOiBkYXRhLnJlZnJlc2hfdG9rZW4sIC8vIHJlZnJlc2ggdG9rZW5cdUIzQzQgXHVBQzMxXHVDMkUwXHVCNDI4XG4gICAgICBpc0xvZ2dlZEluOiB0cnVlXG4gICAgfSk7XG5cbiAgICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBcdTI3MDUgQXV0aCB0b2tlbiByZWZyZXNoZWQgc3VjY2Vzc2Z1bGx5Jyk7XG4gICAgcmV0dXJuIGRhdGEuYWNjZXNzX3Rva2VuO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gXHUyNzRDIFRva2VuIHJlZnJlc2ggZXJyb3I6JywgZXJyb3IpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1Q0QwOFx1QUUzMFx1RDY1NFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFNlcnZpY2UgV29ya2VyIFx1QzEyNFx1Q0U1OCBcdUMyRENcbiAqL1xuY2hyb21lLnJ1bnRpbWUub25JbnN0YWxsZWQuYWRkTGlzdGVuZXIoYXN5bmMgKGRldGFpbHMpID0+IHtcbiAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gU2VydmljZSBXb3JrZXIgaW5zdGFsbGVkOicsIGRldGFpbHMucmVhc29uKTtcblxuICAvLyBcdUJDMzBcdUNFNTggXHVDODA0XHVDMUExIFx1QzU0Q1x1Qjc4QyBcdUMxMjRcdUM4MTUgKGNocm9tZS5hbGFybXMgXHVDRDVDXHVDMThDIDFcdUJEODQpXG4gIGNocm9tZS5hbGFybXMuY3JlYXRlKCdiYXRjaFNlbmQnLCB7XG4gICAgcGVyaW9kSW5NaW51dGVzOiBCQVRDSF9TRU5EX0lOVEVSVkFMXG4gIH0pO1xuXG4gIC8vIFx1Q0QwOFx1QUUzMCBcdUMwQzFcdUQwREMgXHVDMTI0XHVDODE1XG4gIGNvbnN0IHN0b3JhZ2UgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1xuICAgIFNUT1JBR0VfS0VZUy5DT05TRU5UX0dJVkVOLFxuICAgIFNUT1JBR0VfS0VZUy5JU19MT0dHRURfSU5cbiAgXSk7XG5cbiAgLy8gXHVDRDVDXHVDRDA4IFx1QzEyNFx1Q0U1OCBcdUMyRENcdUM1RDBcdUI5Q0MgXHVDRDA4XHVBRTMwXHVBQzEyIFx1QzEyNFx1QzgxNVxuICBpZiAoc3RvcmFnZVtTVE9SQUdFX0tFWVMuSVNfTE9HR0VEX0lOXSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHtcbiAgICAgIFtTVE9SQUdFX0tFWVMuSVNfTE9HR0VEX0lOXTogZmFsc2UsXG4gICAgICBbU1RPUkFHRV9LRVlTLlNFTkRfUVVFVUVdOiBbXVxuICAgIH0pO1xuICB9XG5cbiAgLy8gY29uc2VudEdpdmVuXHVDNzQwIFx1QkE4NVx1QzJEQ1x1QzgwMVx1QzczQ1x1Qjg1QyBcdUNEMDhcdUFFMzBcdUQ2NTRcdUQ1NThcdUM5QzAgXHVDNTRBXHVDNzRDICh1bmRlZmluZWQgPSBcdUM1NDRcdUM5QzEgXHVCM0Q5XHVDNzU4IFx1QzU0OFx1RDU2OClcblxuICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBBbGFybXMgY29uZmlndXJlZDogYmF0Y2hTZW5kIGV2ZXJ5JywgQkFUQ0hfU0VORF9JTlRFUlZBTCwgJ21pbnV0ZShzKScpO1xuXG4gIC8vIFx1QzEyNFx1Q0U1OCBcdUI2MTBcdUIyOTQgXHVDNUM1XHVCMzcwXHVDNzc0XHVEMkI4IFx1QzJEQyBcdUFFMzBcdUM4NzQgXHVEMEVEXHVDNUQwIGNvbnRlbnQgc2NyaXB0IFx1QzhGQ1x1Qzc4NVxuICBpZiAoZGV0YWlscy5yZWFzb24gPT09ICdpbnN0YWxsJyB8fCBkZXRhaWxzLnJlYXNvbiA9PT0gJ3VwZGF0ZScpIHtcbiAgICBhd2FpdCBpbmplY3RDb250ZW50U2NyaXB0c1RvRXhpc3RpbmdUYWJzKCk7XG4gIH1cbn0pO1xuXG4vKipcbiAqIFx1QUUzMFx1Qzg3NCBcdUQwRURcdUM1RDAgY29udGVudCBzY3JpcHQgXHVDOEZDXHVDNzg1XG4gKlxuICogXHVENjU1XHVDN0E1IFx1RDUwNFx1Qjg1Q1x1QURGOFx1QjdBOCBcdUMxMjRcdUNFNTgvXHVDNUM1XHVCMzcwXHVDNzc0XHVEMkI4IFx1QzJEQyBcdUM3NzRcdUJCRjggXHVDNUY0XHVCODI0XHVDNzg4XHVCMjk0IFx1RDBFRFx1QzVEMCBjb250ZW50IHNjcmlwdFx1Qjk3QyBcdUM4RkNcdUM3ODVcdUQ1NThcdUM1RUNcbiAqIFx1QzBBQ1x1QzZBOVx1Qzc5MFx1QUMwMCBcdUMwQzhcdUI4NUNcdUFDRTBcdUNFNjggXHVDNUM2XHVDNzc0IFx1Qzk4OVx1QzJEQyBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDMjE4XHVDOUQxXHVDNzQ0IFx1QzJEQ1x1Qzc5MVx1RDU2MCBcdUMyMTggXHVDNzg4XHVCM0M0XHVCODVEIFx1RDU2OFxuICpcbiAqIG9wdGlvbmFsX2hvc3RfcGVybWlzc2lvbnNcdUI5N0MgXHVDMEFDXHVDNkE5XHVENTU4XHVCQkMwXHVCODVDLCBcdUFEOENcdUQ1NUNcdUM3NzQgXHVCRDgwXHVDNUVDXHVCNDFDIFx1RDBFRFx1QzVEMFx1QjlDQyBcdUM4RkNcdUM3ODVcbiAqL1xuYXN5bmMgZnVuY3Rpb24gaW5qZWN0Q29udGVudFNjcmlwdHNUb0V4aXN0aW5nVGFicygpIHtcbiAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gSW5qZWN0aW5nIGNvbnRlbnQgc2NyaXB0cyB0byBleGlzdGluZyB0YWJzLi4uJyk7XG5cbiAgZm9yIChjb25zdCBtYXBwaW5nIG9mIENPTlRFTlRfU0NSSVBUX01BUFBJTkcpIHtcbiAgICB0cnkge1xuICAgICAgLy8gXHVDNzc0IFx1RDMyOFx1RDEzNCBcdUFERjhcdUI4RjlcdUM1RDAgXHVCMzAwXHVENTc0IFx1QUQ4Q1x1RDU1Q1x1Qzc3NCBcdUM3ODhcdUIyOTRcdUM5QzAgXHVENjU1XHVDNzc4XG4gICAgICBjb25zdCBoYXNQZXJtaXNzaW9uID0gYXdhaXQgY2hyb21lLnBlcm1pc3Npb25zLmNvbnRhaW5zKHtcbiAgICAgICAgb3JpZ2luczogbWFwcGluZy5wYXR0ZXJuc1xuICAgICAgfSk7XG5cbiAgICAgIGlmICghaGFzUGVybWlzc2lvbikge1xuICAgICAgICAvLyBcdUFEOENcdUQ1NUNcdUM3NzQgXHVDNUM2XHVDNzNDXHVCQTc0IFx1QzJBNFx1RDBCNSAob3B0aW9uYWxfaG9zdF9wZXJtaXNzaW9uc1x1Qzc3NFx1QkJDMFx1Qjg1QyBcdUM4MTVcdUMwQzEpXG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBcdUI5RTRcdUNFNkRcdUI0MThcdUIyOTQgVVJMXHVDNzU4IFx1RDBFRCBcdUM4NzBcdUQ2OENcbiAgICAgIGNvbnN0IHRhYnMgPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IHVybDogbWFwcGluZy5wYXR0ZXJucyB9KTtcblxuICAgICAgZm9yIChjb25zdCB0YWIgb2YgdGFicykge1xuICAgICAgICAvLyBcdUM3MjBcdUQ2QThcdUQ1NThcdUM5QzAgXHVDNTRBXHVDNzQwIFx1RDBFRCBcdUMyQTRcdUQwQjVcbiAgICAgICAgaWYgKCF0YWIuaWQgfHwgdGFiLmlkID09PSBjaHJvbWUudGFicy5UQUJfSURfTk9ORSkgY29udGludWU7XG5cbiAgICAgICAgZm9yIChjb25zdCBzY3JpcHQgb2YgbWFwcGluZy5zY3JpcHRzKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IGNocm9tZS5zY3JpcHRpbmcuZXhlY3V0ZVNjcmlwdCh7XG4gICAgICAgICAgICAgIHRhcmdldDogeyB0YWJJZDogdGFiLmlkIH0sXG4gICAgICAgICAgICAgIGZpbGVzOiBbc2NyaXB0XVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgW0RhaWx5IFNjcnVtXSBJbmplY3RlZCAke3NjcmlwdH0gaW50byB0YWIgJHt0YWIuaWR9ICgke3RhYi51cmx9KWApO1xuICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgLy8gY2hyb21lOi8vIFx1QjRGMSBcdUM4MTFcdUFERkMgXHVCRDg4XHVBQzAwXHVCMkE1XHVENTVDIFx1RDJCOVx1QzIxOCBcdUQzOThcdUM3NzRcdUM5QzBcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbRGFpbHkgU2NydW1dIENvdWxkIG5vdCBpbmplY3QgJHtzY3JpcHR9IGludG8gdGFiICR7dGFiLmlkfTpgLCBlcnIubWVzc2FnZSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIFRhYiBxdWVyeSBmYWlsZWQgZm9yIHBhdHRlcm5zJywgbWFwcGluZy5wYXR0ZXJucywgJzonLCBlcnIpO1xuICAgIH1cbiAgfVxuXG4gIGNvbnNvbGUubG9nKCdbRGFpbHkgU2NydW1dIENvbnRlbnQgc2NyaXB0IGluamVjdGlvbiBjb21wbGV0ZWQnKTtcbn1cblxuLyoqXG4gKiBcdUFEOENcdUQ1NUMgXHVCRDgwXHVDNUVDIFx1QzJEQyBcdUFFMzBcdUM4NzQgXHVEMEVEXHVDNUQwIGNvbnRlbnQgc2NyaXB0IFx1Qzk4OVx1QzJEQyBcdUM4RkNcdUM3ODVcbiAqXG4gKiBcdUMwQUNcdUM2QTlcdUM3OTBcdUFDMDAgcG9wdXBcdUM1RDBcdUMxMUMgXHVDMEFDXHVDNzc0XHVEMkI4IFx1QUQ4Q1x1RDU1Q1x1Qzc0NCBcdUNGMUNcdUJBNzQsIFx1Qzc3NFx1QkJGOCBcdUM1RjRcdUI5QjAgXHVENTc0XHVCMkY5IFx1QzBBQ1x1Qzc3NFx1RDJCOCBcdUQwRURcdUM1RDBcbiAqIFx1QzBDOFx1Qjg1Q1x1QUNFMFx1Q0U2OCBcdUM1QzZcdUM3NzQgY29udGVudCBzY3JpcHRcdUI5N0MgXHVDOEZDXHVDNzg1XG4gKi9cbmNocm9tZS5wZXJtaXNzaW9ucy5vbkFkZGVkLmFkZExpc3RlbmVyKGFzeW5jIChwZXJtaXNzaW9ucykgPT4ge1xuICBpZiAoIXBlcm1pc3Npb25zLm9yaWdpbnMgfHwgcGVybWlzc2lvbnMub3JpZ2lucy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBQZXJtaXNzaW9ucyBncmFudGVkOicsIHBlcm1pc3Npb25zLm9yaWdpbnMpO1xuXG4gIGNvbnN0IGdyYW50ZWRPcmlnaW5zID0gbmV3IFNldChwZXJtaXNzaW9ucy5vcmlnaW5zKTtcblxuICBmb3IgKGNvbnN0IG1hcHBpbmcgb2YgQ09OVEVOVF9TQ1JJUFRfTUFQUElORykge1xuICAgIC8vIFx1Qzc3NCBcdUI5RTRcdUQ1NTFcdUM3NTggXHVEMzI4XHVEMTM0IFx1QzkxMSBcdUMwQzhcdUI4NUMgXHVCRDgwXHVDNUVDXHVCNDFDIFx1QUQ4Q1x1RDU1Q1x1QUNGQyBcdUFDQjlcdUNFNThcdUIyOTQgXHVBQzhDIFx1Qzc4OFx1QjI5NFx1QzlDMCBcdUQ2NTVcdUM3NzhcbiAgICBjb25zdCBtYXRjaGluZ1BhdHRlcm5zID0gbWFwcGluZy5wYXR0ZXJucy5maWx0ZXIocCA9PiBncmFudGVkT3JpZ2lucy5oYXMocCkpO1xuICAgIGlmIChtYXRjaGluZ1BhdHRlcm5zLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFicyA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgdXJsOiBtYXRjaGluZ1BhdHRlcm5zIH0pO1xuXG4gICAgICBmb3IgKGNvbnN0IHRhYiBvZiB0YWJzKSB7XG4gICAgICAgIGlmICghdGFiLmlkIHx8IHRhYi5pZCA9PT0gY2hyb21lLnRhYnMuVEFCX0lEX05PTkUpIGNvbnRpbnVlO1xuXG4gICAgICAgIGZvciAoY29uc3Qgc2NyaXB0IG9mIG1hcHBpbmcuc2NyaXB0cykge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCBjaHJvbWUuc2NyaXB0aW5nLmV4ZWN1dGVTY3JpcHQoe1xuICAgICAgICAgICAgICB0YXJnZXQ6IHsgdGFiSWQ6IHRhYi5pZCB9LFxuICAgICAgICAgICAgICBmaWxlczogW3NjcmlwdF1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29uc29sZS5sb2coYFtEYWlseSBTY3J1bV0gSW5qZWN0ZWQgJHtzY3JpcHR9IGludG8gdGFiICR7dGFiLmlkfSAoJHt0YWIudXJsfSlgKTtcbiAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbRGFpbHkgU2NydW1dIENvdWxkIG5vdCBpbmplY3QgJHtzY3JpcHR9IGludG8gdGFiICR7dGFiLmlkfTpgLCBlcnIubWVzc2FnZSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIFRhYiBxdWVyeSBmYWlsZWQgZm9yIGdyYW50ZWQgcGF0dGVybnM6JywgZXJyKTtcbiAgICB9XG4gIH1cbn0pO1xuXG4vKipcbiAqIFNlcnZpY2UgV29ya2VyIFx1QzJEQ1x1Qzc5MSBcdUMyRENcbiAqL1xuY2hyb21lLnJ1bnRpbWUub25TdGFydHVwLmFkZExpc3RlbmVyKCgpID0+IHtcbiAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gU2VydmljZSBXb3JrZXIgc3RhcnRlZCcpO1xufSk7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEdvb2dsZSBBUEkgXHVENTc4XHVCNEU0XHVCN0VDXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogR29vZ2xlIEFQSSBcdUM2OTRcdUNDQUQgXHVDQzk4XHVCOUFDXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IHBheWxvYWQgLSB7IGFwaVR5cGU6ICdkb2NzJ3wnc2hlZXRzJ3wnc2xpZGVzJywgZG9jdW1lbnRJZDogc3RyaW5nIH1cbiAqIEByZXR1cm5zIHtQcm9taXNlPE9iamVjdD59IEFQSSBcdUM3NTFcdUIyRjUgXHVCMzcwXHVDNzc0XHVEMTMwXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUdvb2dsZUFwaVJlcXVlc3QocGF5bG9hZCkge1xuICB0cnkge1xuICAgIGNvbnN0IHsgYXBpVHlwZSwgZG9jdW1lbnRJZCB9ID0gcGF5bG9hZDtcblxuICAgIC8vIFx1RDFBMFx1RDA3MCBcdUQ2NTVcdUM3NzggKFx1QzVDNlx1QzczQ1x1QkE3NCBcdUM3OTBcdUIzRDkgXHVDNzc4XHVDOTlEIFx1QzJEQ1x1QjNDNClcbiAgICBsZXQgdG9rZW4gPSBhd2FpdCBnZXRBY2Nlc3NUb2tlbigpO1xuICAgIGlmICghdG9rZW4pIHtcbiAgICAgIC8vIFJlcXVlc3RpbmcgR29vZ2xlIEFQSSBhdXRob3JpemF0aW9uXG4gICAgICB0b2tlbiA9IGF3YWl0IGF1dGhvcml6ZUdvb2dsZVdvcmtzcGFjZSgpO1xuICAgIH1cblxuICAgIC8vIEFQSSBcdUQwQzBcdUM3ODVcdUJDQzQgXHVDQzk4XHVCOUFDXG4gICAgc3dpdGNoIChhcGlUeXBlKSB7XG4gICAgICBjYXNlICdkb2NzJzpcbiAgICAgICAgY29uc3QgZG9jVGV4dCA9IGF3YWl0IGdldERvY3VtZW50VGV4dChkb2N1bWVudElkKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBkb2N1bWVudElkLFxuICAgICAgICAgIHRleHQ6IGRvY1RleHQsXG4gICAgICAgICAgdHlwZTogJ2RvY3MnXG4gICAgICAgIH07XG5cbiAgICAgIGNhc2UgJ3NoZWV0cyc6XG4gICAgICAgIGNvbnN0IHNwcmVhZHNoZWV0ID0gYXdhaXQgZ2V0U3ByZWFkc2hlZXQoZG9jdW1lbnRJZCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgZG9jdW1lbnRJZCxcbiAgICAgICAgICB0aXRsZTogc3ByZWFkc2hlZXQucHJvcGVydGllcz8udGl0bGUsXG4gICAgICAgICAgc2hlZXRzOiBzcHJlYWRzaGVldC5zaGVldHM/Lm1hcChzID0+IHMucHJvcGVydGllcz8udGl0bGUpLFxuICAgICAgICAgIHR5cGU6ICdzaGVldHMnXG4gICAgICAgIH07XG5cbiAgICAgIGNhc2UgJ3NsaWRlcyc6XG4gICAgICAgIGNvbnN0IHByZXNlbnRhdGlvbiA9IGF3YWl0IGdldFByZXNlbnRhdGlvblRleHQoZG9jdW1lbnRJZCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgZG9jdW1lbnRJZCxcbiAgICAgICAgICBzbGlkZXM6IHByZXNlbnRhdGlvbi5zbGlkZXMsXG4gICAgICAgICAgZnVsbFRleHQ6IHByZXNlbnRhdGlvbi5mdWxsVGV4dCxcbiAgICAgICAgICB0eXBlOiAnc2xpZGVzJ1xuICAgICAgICB9O1xuXG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gQVBJIHR5cGU6ICR7YXBpVHlwZX1gKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBHb29nbGUgQVBJIHJlcXVlc3QgZXJyb3I6JywgZXJyb3IpO1xuICAgIHRocm93IGVycm9yO1xuICB9XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1QzIxOFx1QzlEMSBcdUMwQzFcdUQwREMgXHVBRDAwXHVCOUFDIFx1RDU3OFx1QjRFNFx1QjdFQ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUMyMThcdUM5RDEgXHVDMkRDXHVDNzkxXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVN0YXJ0Q29sbGVjdGlvbigpIHtcbiAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcbiAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHtcbiAgICBbU1RPUkFHRV9LRVlTLklTX0NPTExFQ1RJTkddOiB0cnVlLFxuICAgIFtTVE9SQUdFX0tFWVMuQ09MTEVDVElPTl9TVEFSVF9USU1FXTogc3RhcnRUaW1lLFxuICAgIFtTVE9SQUdFX0tFWVMuQ09MTEVDVElPTl9TVE9QX1RJTUVdOiBudWxsXG4gIH0pO1xuICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBcdTI1QjYgQ29sbGVjdGlvbiBzdGFydGVkIGF0JywgbmV3IERhdGUoc3RhcnRUaW1lKS50b0lTT1N0cmluZygpKTtcbiAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgc3RhcnRUaW1lIH07XG59XG5cbi8qKlxuICogXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzIxOFx1QzlEMSBcdUM5MTFcdUM5QzBcbiAqL1xuYXN5bmMgZnVuY3Rpb24gaGFuZGxlU3RvcENvbGxlY3Rpb24oKSB7XG4gIGNvbnN0IHN0b3BUaW1lID0gRGF0ZS5ub3coKTtcbiAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHtcbiAgICBbU1RPUkFHRV9LRVlTLklTX0NPTExFQ1RJTkddOiBmYWxzZSxcbiAgICBbU1RPUkFHRV9LRVlTLkNPTExFQ1RJT05fU1RPUF9USU1FXTogc3RvcFRpbWVcbiAgfSk7XG4gIGNvbnNvbGUubG9nKCdbRGFpbHkgU2NydW1dIFx1MjNGOSBDb2xsZWN0aW9uIHN0b3BwZWQgYXQnLCBuZXcgRGF0ZShzdG9wVGltZSkudG9JU09TdHJpbmcoKSk7XG4gIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUsIHN0b3BUaW1lIH07XG59XG5cbi8qKlxuICogXHVCQUE4XHVCNEUwIFx1RDBFRFx1QzVEMCBGTFVTSF9OT1cgXHVCRTBDXHVCODVDXHVCNERDXHVDRTkwXHVDMkE0XHVEMkI4IFx1RDZDNCBcdUJDMzBcdUNFNTggXHVDODA0XHVDMUExXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUZvcmNlRmx1c2goKSB7XG4gIGNvbnNvbGUubG9nKCdbRGFpbHkgU2NydW1dIFx1RDgzRFx1REQwNCBGb3JjZSBmbHVzaGluZyBhbGwgdGFicy4uLicpO1xuXG4gIHRyeSB7XG4gICAgLy8gXHVCQUE4XHVCNEUwIFx1RDBFRFx1QzVEMCBGTFVTSF9OT1cgXHVCQTU0XHVDMkRDXHVDOUMwIFx1QkUwQ1x1Qjg1Q1x1QjREQ1x1Q0U5MFx1QzJBNFx1RDJCOFxuICAgIGNvbnN0IHRhYnMgPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7fSk7XG4gICAgY29uc3QgZmx1c2hQcm9taXNlcyA9IHRhYnMubWFwKHRhYiA9PiB7XG4gICAgICBpZiAoIXRhYi5pZCB8fCB0YWIuaWQgPT09IGNocm9tZS50YWJzLlRBQl9JRF9OT05FKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbiAgICAgIHJldHVybiBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWIuaWQsIHsgYWN0aW9uOiAnRkxVU0hfTk9XJyB9KVxuICAgICAgICAuY2F0Y2goKCkgPT4ge1xuICAgICAgICAgIC8vIENvbnRlbnQgc2NyaXB0XHVBQzAwIFx1QzVDNlx1QjI5NCBcdUQwRURcdUM3NDAgXHVCQjM0XHVDMkRDXG4gICAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoZmx1c2hQcm9taXNlcyk7XG4gICAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gXHUyNzA1IEZMVVNIX05PVyBicm9hZGNhc3QgY29tcGxldGVkJyk7XG5cbiAgICAvLyBcdUM3QTBcdUMyREMgXHVCMzAwXHVBRTMwIFx1RDZDNCBcdUJDMzBcdUNFNTggXHVDODA0XHVDMUExIChjb250ZW50IHNjcmlwdFx1QjRFNFx1Qzc3NCBcdUIzNzBcdUM3NzRcdUQxMzBcdUI5N0MgXHVCQ0Y0XHVCMEJDIFx1QzJEQ1x1QUMwNClcbiAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgNTAwKSk7XG5cbiAgICAvLyBcdUJDMzBcdUNFNTggXHVDODA0XHVDMUExIFx1QzJFNFx1RDU4OVxuICAgIGF3YWl0IHByb2Nlc3NCYXRjaFNlbmQoKTtcbiAgICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBcdTI3MDUgRm9yY2UgYmF0Y2ggc2VuZCBjb21wbGV0ZWQnKTtcblxuICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIFx1Mjc0QyBGb3JjZSBmbHVzaCBmYWlsZWQ6JywgZXJyb3IpO1xuICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZXJyb3IubWVzc2FnZSB9O1xuICB9XG59XG5cbi8qKlxuICogXHVENjA0XHVDN0FDIFx1QzIxOFx1QzlEMSBcdUMwQzFcdUQwREMgXHVDODcwXHVENjhDXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUdldENvbGxlY3Rpb25TdGF0ZSgpIHtcbiAgY29uc3Qgc3RvcmFnZSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXG4gICAgU1RPUkFHRV9LRVlTLklTX0NPTExFQ1RJTkcsXG4gICAgU1RPUkFHRV9LRVlTLkNPTExFQ1RJT05fU1RBUlRfVElNRSxcbiAgICBTVE9SQUdFX0tFWVMuQ09MTEVDVElPTl9TVE9QX1RJTUUsXG4gICAgU1RPUkFHRV9LRVlTLkxBU1RfR0VORVJBVEVEX1JBTkdFLFxuICAgIFNUT1JBR0VfS0VZUy5TRU5EX1FVRVVFXG4gIF0pO1xuXG4gIHJldHVybiB7XG4gICAgc3VjY2VzczogdHJ1ZSxcbiAgICBpc0NvbGxlY3Rpbmc6IHN0b3JhZ2VbU1RPUkFHRV9LRVlTLklTX0NPTExFQ1RJTkddIHx8IGZhbHNlLFxuICAgIHN0YXJ0VGltZTogc3RvcmFnZVtTVE9SQUdFX0tFWVMuQ09MTEVDVElPTl9TVEFSVF9USU1FXSB8fCBudWxsLFxuICAgIHN0b3BUaW1lOiBzdG9yYWdlW1NUT1JBR0VfS0VZUy5DT0xMRUNUSU9OX1NUT1BfVElNRV0gfHwgbnVsbCxcbiAgICBsYXN0R2VuZXJhdGVkUmFuZ2U6IHN0b3JhZ2VbU1RPUkFHRV9LRVlTLkxBU1RfR0VORVJBVEVEX1JBTkdFXSB8fCBudWxsLFxuICAgIHF1ZXVlTGVuZ3RoOiBzdG9yYWdlW1NUT1JBR0VfS0VZUy5TRU5EX1FVRVVFXT8ubGVuZ3RoIHx8IDBcbiAgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzIxOFx1QzlEMSBcdUQ1NzhcdUI0RTRcdUI3RUNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBEQVRBX0NBUFRVUkVEIFx1QzU2MVx1QzE1OCBcdUNDOThcdUI5QUNcbiAqL1xuYXN5bmMgZnVuY3Rpb24gaGFuZGxlRGF0YUNhcHR1cmVkKHBheWxvYWQsIHNlbmRlcikge1xuICB0cnkge1xuICAgIC8vIFx1QjNEOVx1Qzc1OCBcdUQ2NTVcdUM3NzggKFx1Q0Q1Q1x1QzZCMFx1QzEyMClcbiAgICBjb25zdCB7IGNvbnNlbnRHaXZlbiwgaXNDb2xsZWN0aW5nIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoWydjb25zZW50R2l2ZW4nLCAnaXNDb2xsZWN0aW5nJ10pO1xuICAgIGlmIChjb25zZW50R2l2ZW4gIT09IHRydWUpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBcdUMyMThcdUM5RDEgXHVDMEMxXHVEMERDIFx1RDY1NVx1Qzc3OCAtIFx1QzIxOFx1QzlEMSBcdUM5MTFcdUM3NzQgXHVDNTQ0XHVCMkM4XHVCQTc0IFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUJCMzRcdUMyRENcbiAgICBpZiAoaXNDb2xsZWN0aW5nICE9PSB0cnVlKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgeyBpc0xvZ2dlZEluIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1NUT1JBR0VfS0VZUy5JU19MT0dHRURfSU5dKTtcblxuICAgIC8vIFx1QkE1NFx1RDBDMFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUNEOTRcdUFDMDBcbiAgICBjb25zdCBlbnJpY2hlZFBheWxvYWQgPSB7XG4gICAgICAuLi5wYXlsb2FkLFxuICAgICAgdGFiSWQ6IHNlbmRlci50YWI/LmlkLFxuICAgICAgY2FwdHVyZWRBdDogRGF0ZS5ub3coKVxuICAgIH07XG5cbiAgICAvLyBUYWIgdHJhbnNpdGlvbiAoaW50ZXJhY3Rpb24gc291cmNlKVx1Qzc0MCBcdUM3NzRcdUJCRjggZnJvbS90byBob3N0bmFtZVx1Qzc3NCBcdUM3ODhcdUM3M0NcdUJCQzBcdUI4NUNcbiAgICAvLyBzZW5kZXIudGFiPy51cmwgXHVDRDk0XHVBQzAwXHVENTU4XHVDOUMwIFx1QzU0QVx1Qzc0QyAoXHVCMkU0XHVCOTc4IFx1RDBFRCBVUkxcdUM3NzQgXHVCNEU0XHVDNUI0XHVBQzA4IFx1QzIxOCBcdUM3ODhcdUM3NEMpXG4gICAgLy8gXHVCMkU0XHVCOTc4IFx1QzE4Q1x1QzJBNFx1QjRFNFx1Qzc0MCBcdUQ2MDRcdUM3QUMgXHVEMEVEXHVDNzU4IFVSTCBcdUNEOTRcdUFDMDBcbiAgICBpZiAocGF5bG9hZC5zb3VyY2UgIT09ICdpbnRlcmFjdGlvbicpIHtcbiAgICAgIGVucmljaGVkUGF5bG9hZC51cmwgPSBzZW5kZXIudGFiPy51cmw7XG4gICAgfVxuXG4gICAgaWYgKGlzTG9nZ2VkSW4pIHtcbiAgICAgIC8vIFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMwQzFcdUQwREM6IFx1QzU1NFx1RDYzOFx1RDY1NCBcdUQ2QzQgXHVDODA0XHVDMUExIFx1RDA1MFx1QzVEMCBcdUNEOTRcdUFDMDBcbiAgICAgIGlmICghZW5jcnlwdGlvbkVuZ2luZS5oYXNLZXkoKSkge1xuICAgICAgICBjb25zb2xlLndhcm4oJ1tEYWlseSBTY3J1bV0gRW5jcnlwdGlvbiBrZXkgbm90IGRlcml2ZWQsIGluaXRpYWxpemluZy4uLicpO1xuICAgICAgICBhd2FpdCBpbml0aWFsaXplRW5jcnlwdGlvbigpO1xuICAgICAgfVxuXG4gICAgICAvLyBzb3VyY2UgXHVENTQ0XHVCNERDXHVCOTdDIFx1QzU1NFx1RDYzOFx1RDY1NCBcdUM4MDRcdUM1RDAgXHVCRDg0XHVCOUFDIChpbmdlc3QgZW5kcG9pbnRcdUM1RDBcdUMxMUMgXHVCQ0M0XHVCM0M0IFx1RDU0NFx1QjREQ1x1Qjg1QyBcdUQ1NDRcdUM2OTQpXG4gICAgICBjb25zdCB7IHNvdXJjZSwgdHlwZSwgLi4uZGF0YVRvRW5jcnlwdCB9ID0gZW5yaWNoZWRQYXlsb2FkO1xuICAgICAgY29uc3QgZW5jcnlwdGVkID0gYXdhaXQgZW5jcnlwdGlvbkVuZ2luZS5lbmNyeXB0KGRhdGFUb0VuY3J5cHQpO1xuXG4gICAgICAvLyBpbmdlc3QgZW5kcG9pbnQgXHVENjE1XHVDMkREXHVDNUQwIFx1QjlERVx1QUM4QyBcdUJDQzBcdUQ2NThcbiAgICAgIGNvbnN0IGluZ2VzdEl0ZW0gPSB7XG4gICAgICAgIHNvdXJjZTogc291cmNlIHx8IHR5cGUgfHwgJ3Vua25vd24nLFxuICAgICAgICBpdjogSlNPTi5zdHJpbmdpZnkoZW5jcnlwdGVkLml2KSxcbiAgICAgICAgY2lwaGVydGV4dDogSlNPTi5zdHJpbmdpZnkoZW5jcnlwdGVkLmNpcGhlcnRleHQpLFxuICAgICAgICBhbGdvcml0aG06IGVuY3J5cHRlZC5hbGdvcml0aG0sXG4gICAgICAgIHRpbWVzdGFtcDogZW5jcnlwdGVkLnRpbWVzdGFtcCxcbiAgICAgICAgbWV0YWRhdGE6IHt9XG4gICAgICB9O1xuXG4gICAgICBhd2FpdCBhZGRUb1NlbmRRdWV1ZShpbmdlc3RJdGVtKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gXHVCRTQ0XHVCODVDXHVBREY4XHVDNzc4IFx1QzBDMVx1RDBEQzogXHVDNzg0XHVDMkRDIFx1QkM4NFx1RDM3Q1x1QzVEMCBcdUM4MDBcdUM3QTUgKFx1RDNDOVx1QkIzOClcbiAgICAgIGF3YWl0IGFkZFRvVGVtcEJ1ZmZlcihlbnJpY2hlZFBheWxvYWQpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIGhhbmRsZURhdGFDYXB0dXJlZCBlcnJvcjonLCBlcnJvcik7XG4gIH1cbn1cblxuLyoqXG4gKiBcdUM4MDRcdUMxQTEgXHVEMDUwXHVDNUQwIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUNEOTRcdUFDMDBcbiAqL1xuYXN5bmMgZnVuY3Rpb24gYWRkVG9TZW5kUXVldWUocGF5bG9hZCkge1xuICBjb25zdCB7IHNlbmRRdWV1ZSA9IFtdIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1NUT1JBR0VfS0VZUy5TRU5EX1FVRVVFXSk7XG4gIHNlbmRRdWV1ZS5wdXNoKHBheWxvYWQpO1xuICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbU1RPUkFHRV9LRVlTLlNFTkRfUVVFVUVdOiBzZW5kUXVldWUgfSk7XG59XG5cbi8qKlxuICogXHVDNzg0XHVDMkRDIFx1QkM4NFx1RDM3Q1x1QzVEMCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDRDk0XHVBQzAwIChJbmRleGVkREIpXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGFkZFRvVGVtcEJ1ZmZlcihwYXlsb2FkKSB7XG4gIHRyeSB7XG4gICAgYXdhaXQgdGVtcEJ1ZmZlci5hZGQocGF5bG9hZCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBhZGRUb1RlbXBCdWZmZXIgZXJyb3I6JywgZXJyb3IpO1xuICB9XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFRhYiBUcmFuc2l0aW9uIFx1QjlFNFx1Q0U2RFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFRBQl9UUkFOU0lUSU9OIFx1QzU2MVx1QzE1OCBcdUNDOThcdUI5QUNcbiAqIGludGVyYWN0aW9uLXRyYWNrZXIuanNcdUM1RDBcdUMxMUMgdmlzaWJpbGl0eWNoYW5nZSBcdUM3NzRcdUJDQTRcdUQyQjhcdUI4NUMgXHVDODA0XHVDMUExXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVRhYlRyYW5zaXRpb24ocGF5bG9hZCwgc2VuZGVyKSB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyB0eXBlLCBob3N0bmFtZSwgYXQgfSA9IHBheWxvYWQ7XG4gICAgY29uc3QgdGFiSWQgPSBzZW5kZXIudGFiPy5pZDtcblxuICAgIGlmICh0eXBlID09PSAnbGVhdmUnKSB7XG4gICAgICAvLyBcdUQwRURcdUM3NDQgXHVCNUEwXHVCMEEwIFx1QjU0QzogbGFzdFRyYW5zaXRpb24gXHVDODAwXHVDN0E1XG4gICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoe1xuICAgICAgICBbU1RPUkFHRV9LRVlTLkxBU1RfVFJBTlNJVElPTl06IHtcbiAgICAgICAgICB0eXBlOiAnbGVhdmUnLFxuICAgICAgICAgIGhvc3RuYW1lLFxuICAgICAgICAgIGF0LFxuICAgICAgICAgIHRhYklkXG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgLy8gVGFiIGxlZnRcbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdlbnRlcicpIHtcbiAgICAgIC8vIFx1RDBFRFx1QzVEMCBcdUM5QzRcdUM3ODVcdUQ1NjAgXHVCNTRDOiBcdUM3NzRcdUM4MDQgbGVhdmVcdUM2NDAgXHVCOUU0XHVDRTZEXG4gICAgICBjb25zdCB7IGxhc3RUcmFuc2l0aW9uIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1NUT1JBR0VfS0VZUy5MQVNUX1RSQU5TSVRJT05dKTtcblxuICAgICAgaWYgKGxhc3RUcmFuc2l0aW9uICYmIGxhc3RUcmFuc2l0aW9uLnR5cGUgPT09ICdsZWF2ZScpIHtcbiAgICAgICAgLy8gVHJhbnNpdGlvbiBcdUMzMEQgXHVDMEREXHVDMTMxXG4gICAgICAgIGNvbnN0IHRyYW5zaXRpb24gPSB7XG4gICAgICAgICAgZnJvbTogbGFzdFRyYW5zaXRpb24uaG9zdG5hbWUsXG4gICAgICAgICAgdG86IGhvc3RuYW1lLFxuICAgICAgICAgIGxlZnRBdDogbGFzdFRyYW5zaXRpb24uYXQsXG4gICAgICAgICAgZW50ZXJlZEF0OiBhdCxcbiAgICAgICAgICBnYXA6IGF0IC0gbGFzdFRyYW5zaXRpb24uYXQsXG4gICAgICAgICAgdGltZXN0YW1wOiBhdFxuICAgICAgICB9O1xuXG4gICAgICAgIC8vIFRyYW5zaXRpb25cdUM3NDQgXHVCMzcwXHVDNzc0XHVEMTMwXHVCODVDIFx1QzgwMFx1QzdBNVxuICAgICAgICBhd2FpdCBoYW5kbGVEYXRhQ2FwdHVyZWQoe1xuICAgICAgICAgIHR5cGU6ICdEQUlMWV9TQ1JVTV9DQVBUVVJFJyxcbiAgICAgICAgICBzb3VyY2U6ICdpbnRlcmFjdGlvbicsXG4gICAgICAgICAgZGF0YTogdHJhbnNpdGlvblxuICAgICAgICB9LCBzZW5kZXIpO1xuXG4gICAgICAgIC8vIGxhc3RUcmFuc2l0aW9uIFx1Q0QwOFx1QUUzMFx1RDY1NFxuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5yZW1vdmUoU1RPUkFHRV9LRVlTLkxBU1RfVFJBTlNJVElPTik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBUYWIgZW50ZXJlZCB3aXRob3V0IG1hdGNoaW5nIGxlYXZlXG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gaGFuZGxlVGFiVHJhbnNpdGlvbiBlcnJvcjonLCBlcnJvcik7XG4gIH1cbn1cblxuLyoqXG4gKiBjaHJvbWUudGFicy5vbkFjdGl2YXRlZFx1Qjg1QyBcdUQ2NUNcdUMxMzEgXHVEMEVEIFx1Q0Q5NFx1QzgwMVxuICogKFx1Q0Q5NFx1QUMwMFx1QzgwMVx1Qzc3OCBcdUQwRUQgXHVDODA0XHVENjU4IFx1QUMxMFx1QzlDMClcbiAqL1xuY2hyb21lLnRhYnMub25BY3RpdmF0ZWQuYWRkTGlzdGVuZXIoYXN5bmMgKGFjdGl2ZUluZm8pID0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB0YWIgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQoYWN0aXZlSW5mby50YWJJZCk7XG4gICAgY29uc3QgaG9zdG5hbWUgPSBuZXcgVVJMKHRhYi51cmwpLmhvc3RuYW1lO1xuXG4gICAgLy8gXHVENjVDXHVDMTMxIFx1RDBFRCBcdUM4MTVcdUJDRjQgXHVDODAwXHVDN0E1XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHtcbiAgICAgIFtTVE9SQUdFX0tFWVMuQUNUSVZFX1RBQl9JTkZPXToge1xuICAgICAgICB0YWJJZDogYWN0aXZlSW5mby50YWJJZCxcbiAgICAgICAgaG9zdG5hbWUsXG4gICAgICAgIGFjdGl2YXRlZEF0OiBEYXRlLm5vdygpXG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAvLyBUYWIgYWN0aXZhdGVkXG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgLy8gY2hyb21lOi8vIFx1QjRGMSBcdUM4MTFcdUFERkMgXHVCRDg4XHVBQzAwIFVSTFx1Qzc0MCBcdUJCMzRcdUMyRENcbiAgfVxufSk7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1QkMzMFx1Q0U1OCBcdUM4MDRcdUMxQTFcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBcdUJDMzBcdUNFNTggXHVDODA0XHVDMUExIFx1QzU0Q1x1Qjc4QyBcdUI5QUNcdUMyQTRcdUIxMDhcbiAqL1xuY2hyb21lLmFsYXJtcy5vbkFsYXJtLmFkZExpc3RlbmVyKGFzeW5jIChhbGFybSkgPT4ge1xuICBpZiAoYWxhcm0ubmFtZSA9PT0gJ2JhdGNoU2VuZCcpIHtcbiAgICBhd2FpdCBwcm9jZXNzQmF0Y2hTZW5kKCk7XG4gIH1cbn0pO1xuXG4vKipcbiAqIFx1QkMzMFx1Q0U1OCBcdUM4MDRcdUMxQTEgXHVDQzk4XHVCOUFDXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHByb2Nlc3NCYXRjaFNlbmQoKSB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBzZW5kUXVldWUgPSBbXSwgaXNMb2dnZWRJbiB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtcbiAgICAgIFNUT1JBR0VfS0VZUy5TRU5EX1FVRVVFLFxuICAgICAgU1RPUkFHRV9LRVlTLklTX0xPR0dFRF9JTlxuICAgIF0pO1xuXG4gICAgaWYgKCFpc0xvZ2dlZEluKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKHNlbmRRdWV1ZS5sZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBTdXBhYmFzZSBFZGdlIEZ1bmN0aW9uXHVDNzNDXHVCODVDIFx1QzgwNFx1QzFBMVxuICAgIGNvbnN0IHN1Y2Nlc3MgPSBhd2FpdCBzZW5kVG9TdXBhYmFzZShzZW5kUXVldWUpO1xuXG4gICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgIC8vIFx1QzgwNFx1QzFBMSBcdUMxMzFcdUFDRjUgXHVDMkRDIFx1RDA1MCBcdUJFNDRcdUM2QjBcdUFFMzBcbiAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtTVE9SQUdFX0tFWVMuU0VORF9RVUVVRV06IFtdIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIEJhdGNoIHNlbmQgZmFpbGVkIGFmdGVyIHJldHJpZXMnKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBwcm9jZXNzQmF0Y2hTZW5kIGVycm9yOicsIGVycm9yKTtcbiAgfVxufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBcdUI4NUNcdUFERjhcdUM3NzggXHVDMEMxXHVEMERDIFx1QUQwMFx1QjlBQ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIGNocm9tZS5zdG9yYWdlIFx1QkNDMFx1QUNCRCBcdUFDMTBcdUM5QzAgKFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMwQzFcdUQwREMgXHVCNEYxKVxuICovXG5jaHJvbWUuc3RvcmFnZS5vbkNoYW5nZWQuYWRkTGlzdGVuZXIoYXN5bmMgKGNoYW5nZXMsIGFyZWFOYW1lKSA9PiB7XG4gIGlmIChhcmVhTmFtZSAhPT0gJ2xvY2FsJykgcmV0dXJuO1xuXG4gIC8vIFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMwQzFcdUQwREMgXHVCQ0MwXHVBQ0JEIFx1QUMxMFx1QzlDMFxuICBpZiAoY2hhbmdlc1tTVE9SQUdFX0tFWVMuSVNfTE9HR0VEX0lOXSkge1xuICAgIGNvbnN0IHsgbmV3VmFsdWUgfSA9IGNoYW5nZXNbU1RPUkFHRV9LRVlTLklTX0xPR0dFRF9JTl07XG4gICAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gTG9naW4gc3RhdGUgY2hhbmdlZDonLCBuZXdWYWx1ZSk7XG5cbiAgICBpZiAobmV3VmFsdWUgPT09IHRydWUpIHtcbiAgICAgIC8vIFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMyREM6IFx1QzU1NFx1RDYzOFx1RDY1NCBcdUQwQTQgXHVDRDA4XHVBRTMwXHVENjU0IFx1RDZDNCBcdUM3ODRcdUMyREMgXHVCQzg0XHVEMzdDIFx1RDUwQ1x1QjdFQ1x1QzJEQ1xuICAgICAgYXdhaXQgaW5pdGlhbGl6ZUVuY3J5cHRpb24oKTtcbiAgICAgIGF3YWl0IGZsdXNoVGVtcEJ1ZmZlclRvUXVldWUoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gXHVCODVDXHVBREY4XHVDNTQ0XHVDNkMzIFx1QzJEQzogXHVDNTU0XHVENjM4XHVENjU0IFx1RDBBNCBcdUQzRDBcdUFFMzBcbiAgICAgIGVuY3J5cHRpb25FbmdpbmUuY2xlYXJLZXkoKTtcbiAgICB9XG4gIH1cbn0pO1xuXG4vKipcbiAqIFx1Qzc4NFx1QzJEQyBcdUJDODRcdUQzN0MgXHVCMzcwXHVDNzc0XHVEMTMwXHVCOTdDIFx1QzU1NFx1RDYzOFx1RDY1NFx1RDU1OFx1QzVFQyBcdUM4MDRcdUMxQTEgXHVEMDUwXHVCODVDIFx1Qzc3NFx1QjNEOVxuICovXG5hc3luYyBmdW5jdGlvbiBmbHVzaFRlbXBCdWZmZXJUb1F1ZXVlKCkge1xuICB0cnkge1xuICAgIGNvbnN0IGNvdW50ID0gYXdhaXQgdGVtcEJ1ZmZlci5nZXRDb3VudCgpO1xuXG4gICAgaWYgKGNvdW50ID09PSAwKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gXHVDNTU0XHVENjM4XHVENjU0IFx1RDBBNCBcdUNEMDhcdUFFMzBcdUQ2NTQgKFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUM5QzFcdUQ2QzQgXHVENjM4XHVDRDlDXHVCNDE4XHVCQkMwXHVCODVDIFx1RDU0NFx1QzIxOClcbiAgICBpZiAoIWVuY3J5cHRpb25FbmdpbmUuaGFzS2V5KCkpIHtcbiAgICAgIGF3YWl0IGluaXRpYWxpemVFbmNyeXB0aW9uKCk7XG4gICAgfVxuXG4gICAgLy8gSW5kZXhlZERCXHVDNUQwXHVDMTFDIFx1QjM3MFx1Qzc3NFx1RDEzMFx1Qjk3QyBcdUM1NTRcdUQ2MzhcdUQ2NTRcdUQ1NThcdUM1RUMgXHVDODA0XHVDMUExIFx1RDA1MFx1Qjg1QyBcdUM3NzRcdUIzRDlcbiAgICBhd2FpdCB0ZW1wQnVmZmVyLmZsdXNoVG9TZXJ2ZXIoYXN5bmMgKGRhdGFBcnJheSkgPT4ge1xuICAgICAgY29uc3QgeyBzZW5kUXVldWUgPSBbXSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtTVE9SQUdFX0tFWVMuU0VORF9RVUVVRV0pO1xuXG4gICAgICAvLyBcdUFDMDEgXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzU1NFx1RDYzOFx1RDY1NFxuICAgICAgY29uc3QgZW5jcnlwdGVkSXRlbXMgPSBbXTtcbiAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBkYXRhQXJyYXkpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAvLyBzb3VyY2UgXHVENTQ0XHVCNERDXHVCOTdDIFx1QzU1NFx1RDYzOFx1RDY1NCBcdUM4MDRcdUM1RDAgXHVCRDg0XHVCOUFDXG4gICAgICAgICAgY29uc3QgeyBzb3VyY2UsIHR5cGUsIC4uLmRhdGFUb0VuY3J5cHQgfSA9IGl0ZW07XG4gICAgICAgICAgY29uc3QgZW5jcnlwdGVkID0gYXdhaXQgZW5jcnlwdGlvbkVuZ2luZS5lbmNyeXB0KGRhdGFUb0VuY3J5cHQpO1xuXG4gICAgICAgICAgLy8gaW5nZXN0IGVuZHBvaW50IFx1RDYxNVx1QzJERFx1QzVEMCBcdUI5REVcdUFDOEMgXHVCQ0MwXHVENjU4XG4gICAgICAgICAgY29uc3QgaW5nZXN0SXRlbSA9IHtcbiAgICAgICAgICAgIHNvdXJjZTogc291cmNlIHx8IHR5cGUgfHwgJ3Vua25vd24nLFxuICAgICAgICAgICAgaXY6IEpTT04uc3RyaW5naWZ5KGVuY3J5cHRlZC5pdiksICAgICAvLyBudW1iZXJbXSBcdTIxOTIgc3RyaW5nXG4gICAgICAgICAgICBjaXBoZXJ0ZXh0OiBKU09OLnN0cmluZ2lmeShlbmNyeXB0ZWQuY2lwaGVydGV4dCksIC8vIG51bWJlcltdIFx1MjE5MiBzdHJpbmdcbiAgICAgICAgICAgIGFsZ29yaXRobTogZW5jcnlwdGVkLmFsZ29yaXRobSxcbiAgICAgICAgICAgIHRpbWVzdGFtcDogZW5jcnlwdGVkLnRpbWVzdGFtcCxcbiAgICAgICAgICAgIG1ldGFkYXRhOiB7fVxuICAgICAgICAgIH07XG5cbiAgICAgICAgICBlbmNyeXB0ZWRJdGVtcy5wdXNoKGluZ2VzdEl0ZW0pO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIEZhaWxlZCB0byBlbmNyeXB0IHRlbXAgYnVmZmVyIGl0ZW06JywgZXJyKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCBtZXJnZWRRdWV1ZSA9IFsuLi5zZW5kUXVldWUsIC4uLmVuY3J5cHRlZEl0ZW1zXTtcbiAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtTVE9SQUdFX0tFWVMuU0VORF9RVUVVRV06IG1lcmdlZFF1ZXVlIH0pO1xuICAgIH0pO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gZmx1c2hUZW1wQnVmZmVyVG9RdWV1ZSBlcnJvcjonLCBlcnJvcik7XG4gIH1cbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHVDNzIwXHVEMkY4XHVCOUFDXHVEMkYwXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogXHVCODVDXHVBREY4XHVDNzc4IFx1QzBDMVx1RDBEQyBcdUQ2NTVcdUM3NzggKFx1QjJFNFx1Qjk3OCBcdUJBQThcdUI0QzhcdUM1RDBcdUMxMUMgXHVENjM4XHVDRDlDIFx1QUMwMFx1QjJBNSlcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldExvZ2luU3RhdGUoKSB7XG4gIGNvbnN0IHsgaXNMb2dnZWRJbiwgdXNlcklkIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1xuICAgIFNUT1JBR0VfS0VZUy5JU19MT0dHRURfSU4sXG4gICAgU1RPUkFHRV9LRVlTLlVTRVJfSURcbiAgXSk7XG4gIHJldHVybiB7IGlzTG9nZ2VkSW46IGlzTG9nZ2VkSW4gfHwgZmFsc2UsIHVzZXJJZDogdXNlcklkIHx8IG51bGwgfTtcbn1cblxuLyoqXG4gKiBcdUI4NUNcdUFERjhcdUM3NzggXHVDMTI0XHVDODE1IChwb3B1cFx1Qzc3NFx1QjA5OCBcdUIyRTRcdUI5NzggXHVCQUE4XHVCNEM4XHVDNUQwXHVDMTFDIFx1RDYzOFx1Q0Q5QylcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNldExvZ2luU3RhdGUoaXNMb2dnZWRJbiwgdXNlcklkID0gbnVsbCkge1xuICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoe1xuICAgIFtTVE9SQUdFX0tFWVMuSVNfTE9HR0VEX0lOXTogaXNMb2dnZWRJbixcbiAgICBbU1RPUkFHRV9LRVlTLlVTRVJfSURdOiB1c2VySWRcbiAgfSk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1QzU1NFx1RDYzOFx1RDY1NCBcdUNEMDhcdUFFMzBcdUQ2NTRcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBcdUM1NTRcdUQ2MzhcdUQ2NTQgXHVEMEE0IFx1RDMwQ1x1QzBERCAoXHVCODVDXHVBREY4XHVDNzc4IFx1QzJEQyBcdUQ2MzhcdUNEOUMpXG4gKlxuICogdXNlcklkXHVDNjQwIHNlcnZlclNhbHRcdUI5N0MgXHVDMEFDXHVDNkE5XHVENTU4XHVDNUVDIFBCS0RGMlx1Qjg1QyBcdUQwQTQgXHVEMzBDXHVDMEREXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGluaXRpYWxpemVFbmNyeXB0aW9uKCkge1xuICB0cnkge1xuICAgIGNvbnN0IHsgdXNlcklkLCBzZXJ2ZXJTYWx0LCBhdXRoVG9rZW4gfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXG4gICAgICBTVE9SQUdFX0tFWVMuVVNFUl9JRCxcbiAgICAgIFNUT1JBR0VfS0VZUy5TRVJWRVJfU0FMVCxcbiAgICAgIFNUT1JBR0VfS0VZUy5BVVRIX1RPS0VOXG4gICAgXSk7XG5cbiAgICBpZiAoIXVzZXJJZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdVc2VyIElEIG5vdCBmb3VuZCBpbiBzdG9yYWdlJyk7XG4gICAgfVxuXG4gICAgLy8gU2FsdCBcdUIzRDlcdUFFMzBcdUQ2NTQgXHVCODVDXHVDOUMxIChcdUIyRTRcdUM5MTEgXHVCNTE0XHVCQzE0XHVDNzc0XHVDMkE0IFx1QzlDMFx1QzZEMClcbiAgICAvLyBDUklUSUNBTDogU2FsdCBcdUJEODhcdUM3N0NcdUNFNTggXHVCQzI5XHVDOUMwIC0gXHVDMTFDXHVCQzg0IFx1Qzg3MFx1RDY4QyBcdUMyRTRcdUQzMjggXHVDMkRDIFx1QzBDOCBzYWx0IFx1QzBERFx1QzEzMSBcdUFFMDhcdUM5QzBcbiAgICBsZXQgc2FsdCA9IHNlcnZlclNhbHQ7XG4gICAgbGV0IHNhbHRXYXNHZW5lcmF0ZWQgPSBmYWxzZTtcblxuICAgIGlmICghc2FsdCkge1xuICAgICAgaWYgKCFhdXRoVG9rZW4pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgaW5pdGlhbGl6ZSBlbmNyeXB0aW9uIHdpdGhvdXQgYXV0aCB0b2tlbicpO1xuICAgICAgfVxuXG4gICAgICAvLyBTdGVwIDE6IFx1QzExQ1x1QkM4NFx1QzVEMFx1QzExQyBzYWx0IFx1Qzg3MFx1RDY4QyAoXHVENTQ0XHVDMjE4IC0gXHVDMkU0XHVEMzI4IFx1QzJEQyBcdUM5MTFcdUIyRTgpXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBleGlzdGluZ1NhbHQgPSBhd2FpdCBmZXRjaFNhbHRGcm9tU3VwYWJhc2UodXNlcklkLCBhdXRoVG9rZW4pO1xuICAgICAgICBpZiAoZXhpc3RpbmdTYWx0KSB7XG4gICAgICAgICAgLy8gXHVDMTFDXHVCQzg0XHVDNUQwIFx1Qzc3NFx1QkJGOCBzYWx0IFx1Qzg3NFx1QzdBQyBcdTIxOTIgXHVCMkU0XHVDNkI0XHVCODVDXHVCNERDXHVENTU4XHVDNUVDIFx1QzBBQ1x1QzZBOVxuICAgICAgICAgIHNhbHQgPSBleGlzdGluZ1NhbHQ7XG4gICAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW1NUT1JBR0VfS0VZUy5TRVJWRVJfU0FMVF06IHNhbHQgfSk7XG4gICAgICAgICAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gXHUyNzA1IERvd25sb2FkZWQgZXhpc3Rpbmcgc2FsdCBmcm9tIHNlcnZlciAobXVsdGktZGV2aWNlIHN5bmMpJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gU3RlcCAyOiBcdUMxMUNcdUJDODRcdUM1RDAgc2FsdCBcdUM1QzZcdUM3NEMgXHUyMTkyIFx1QzBDOFx1Qjg1QyBcdUMwRERcdUMxMzEgKFx1Q0Q1Q1x1Q0QwOCBcdUI4NUNcdUFERjhcdUM3NzhcdUI5Q0MpXG4gICAgICAgICAgc2FsdCA9IGF3YWl0IGdlbmVyYXRlU2VydmVyU2FsdCgpO1xuICAgICAgICAgIHNhbHRXYXNHZW5lcmF0ZWQgPSB0cnVlO1xuICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtTVE9SQUdFX0tFWVMuU0VSVkVSX1NBTFRdOiBzYWx0IH0pO1xuICAgICAgICAgIGNvbnNvbGUubG9nKCdbRGFpbHkgU2NydW1dIFx1MjcwNSBHZW5lcmF0ZWQgbmV3IHNlcnZlciBzYWx0IChmaXJzdCBsb2dpbiknKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgLy8gQ1JJVElDQUw6IFx1QzExQ1x1QkM4NCBcdUM4NzBcdUQ2OEMgXHVDMkU0XHVEMzI4IFx1QzJEQyBcdUMwQzggc2FsdCBcdUMwRERcdUMxMzEgXHVBRTA4XHVDOUMwIChcdUIzNzBcdUM3NzRcdUQxMzAgXHVCQjM0XHVBQ0IwXHVDMTMxIFx1QkNGNFx1RDYzOClcbiAgICAgICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBcdTI3NEMgRmFpbGVkIHRvIGZldGNoIHNhbHQgZnJvbSBzZXJ2ZXI6JywgZXJyb3IubWVzc2FnZSk7XG5cbiAgICAgICAgY2hyb21lLm5vdGlmaWNhdGlvbnMuY3JlYXRlKHtcbiAgICAgICAgICB0eXBlOiAnYmFzaWMnLFxuICAgICAgICAgIGljb25Vcmw6ICdpY29ucy9pY29uLTQ4LnBuZycsXG4gICAgICAgICAgdGl0bGU6ICdEYWlseSBTY3J1bSBDb25uZWN0aW9uIFJlcXVpcmVkJyxcbiAgICAgICAgICBtZXNzYWdlOiAnQ2Fubm90IHZlcmlmeSBlbmNyeXB0aW9uIHNldHRpbmdzLiBQbGVhc2UgY2hlY2sgeW91ciBpbnRlcm5ldCBjb25uZWN0aW9uIGFuZCB0cnkgYWdhaW4uJyxcbiAgICAgICAgICBwcmlvcml0eTogMlxuICAgICAgICB9KTtcblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCBpbml0aWFsaXplIGVuY3J5cHRpb246IHNlcnZlciBzYWx0IHZlcmlmaWNhdGlvbiBmYWlsZWQuIFRoaXMgcHJldmVudHMgZGF0YSBjb3JydXB0aW9uLicpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFx1QzU1NFx1RDYzOFx1RDY1NCBcdUQwQTQgXHVEMzBDXHVDMEREXG4gICAgYXdhaXQgZW5jcnlwdGlvbkVuZ2luZS5kZXJpdmVLZXkodXNlcklkLCBzYWx0KTtcbiAgICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBcdTI3MDUgRW5jcnlwdGlvbiBpbml0aWFsaXplZCcpO1xuXG4gICAgLy8gXHVDMEM4XHVCODVDIFx1QzBERFx1QzEzMVx1QjQxQyBzYWx0XHVCOTdDIFN1cGFiYXNlXHVDNUQwIFx1QzgwMFx1QzdBNSAoXHVDRDVDXHVDRDA4IFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMyRENcdUI5Q0MpXG4gICAgaWYgKHNhbHRXYXNHZW5lcmF0ZWQgJiYgYXV0aFRva2VuKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBzYXZlU2FsdFRvU3VwYWJhc2VXaXRoUmV0cnkodXNlcklkLCBzYWx0LCBhdXRoVG9rZW4pO1xuICAgICAgICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBcdTI3MDUgU2FsdCBzYXZlZCB0byBTdXBhYmFzZScpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgLy8gQ1JJVElDQUw6IFNhbHQgXHVDODAwXHVDN0E1IFx1QzJFNFx1RDMyOCBcdUMyREMgXHVDNTU0XHVENjM4XHVENjU0IFx1Q0QwOFx1QUUzMFx1RDY1NCBcdUNERThcdUMxOENcbiAgICAgICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBcdTI3NEMgRmFpbGVkIHRvIHNhdmUgc2FsdCB0byBTdXBhYmFzZSBhZnRlciByZXRyaWVzOicsIGVycm9yKTtcblxuICAgICAgICAvLyBcdUMwQUNcdUM2QTlcdUM3OTBcdUM1RDBcdUFDOEMgXHVDNTRDXHVCOUJDXG4gICAgICAgIGNocm9tZS5ub3RpZmljYXRpb25zLmNyZWF0ZSh7XG4gICAgICAgICAgdHlwZTogJ2Jhc2ljJyxcbiAgICAgICAgICBpY29uVXJsOiAnaWNvbnMvaWNvbi00OC5wbmcnLFxuICAgICAgICAgIHRpdGxlOiAnRGFpbHkgU2NydW0gU2V0dXAgRmFpbGVkJyxcbiAgICAgICAgICBtZXNzYWdlOiAnQ2Fubm90IGNvbm5lY3QgdG8gc2VydmVyLiBQbGVhc2UgY2hlY2sgeW91ciBpbnRlcm5ldCBjb25uZWN0aW9uIGFuZCB0cnkgbG9nZ2luZyBpbiBhZ2Fpbi4nLFxuICAgICAgICAgIHByaW9yaXR5OiAyXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFx1QzU1NFx1RDYzOFx1RDY1NCBcdUMwQzFcdUQwREMgXHVDRDA4XHVBRTMwXHVENjU0IChkZWdyYWRlZCBtb2RlIFx1QkMyOVx1QzlDMClcbiAgICAgICAgZW5jcnlwdGlvbkVuZ2luZS5jbGVhcktleSgpO1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5yZW1vdmUoU1RPUkFHRV9LRVlTLlNFUlZFUl9TQUxUKTtcblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ZhaWxlZCB0byBzYXZlIGVuY3J5cHRpb24gc2FsdCAtIGNhbm5vdCBwcm9jZWVkIHdpdGhvdXQgc2VydmVyIHN5bmNocm9uaXphdGlvbicpO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIFx1Mjc0QyBGYWlsZWQgdG8gaW5pdGlhbGl6ZSBlbmNyeXB0aW9uOicsIGVycm9yKTtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG4vKipcbiAqIFNhbHRcdUI5N0MgU3VwYWJhc2VcdUM1RDAgXHVDODAwXHVDN0E1IChcdUM3QUNcdUMyRENcdUIzQzQgXHVCODVDXHVDOUMxIFx1RDNFQ1x1RDU2OClcbiAqXG4gKiBDUklUSUNBTDogU2FsdCBcdUM4MDBcdUM3QTUgXHVDMkU0XHVEMzI4IFx1QzJEQyBcdUM1NTRcdUQ2MzhcdUQ2NTRcdUI0MUMgXHVCMzcwXHVDNzc0XHVEMTMwXHVCOTdDIFx1QzExQ1x1QkM4NFx1QzVEMFx1QzExQyBcdUJDRjVcdUQ2MzhcdUQ2NTRcdUQ1NjAgXHVDMjE4IFx1QzVDNlx1QzczQ1x1QkJDMFx1Qjg1QyxcbiAqIFx1QkMxOFx1QjREQ1x1QzJEQyBcdUMxMzFcdUFDRjVcdUQ1NzRcdUM1N0MgXHVENTY5XHVCMkM4XHVCMkU0LiAzXHVENjhDIFx1QzdBQ1x1QzJEQ1x1QjNDNCBcdUQ2QzQgXHVDMkU0XHVEMzI4XHVENTU4XHVCQTc0IFx1QzYwOFx1QzY3OFx1Qjk3QyBcdUIzNThcdUM5RDFcdUIyQzhcdUIyRTQuXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IHVzZXJJZCAtIFVzZXIgSURcbiAqIEBwYXJhbSB7c3RyaW5nfSBzYWx0IC0gR2VuZXJhdGVkIHNhbHRcbiAqIEBwYXJhbSB7c3RyaW5nfSBhdXRoVG9rZW4gLSBTdXBhYmFzZSBhdXRoIHRva2VuXG4gKiBAdGhyb3dzIHtFcnJvcn0gM1x1RDY4QyBcdUM3QUNcdUMyRENcdUIzQzQgXHVENkM0XHVDNUQwXHVCM0M0IFx1QzJFNFx1RDMyOCBcdUMyRENcbiAqL1xuYXN5bmMgZnVuY3Rpb24gc2F2ZVNhbHRUb1N1cGFiYXNlV2l0aFJldHJ5KHVzZXJJZCwgc2FsdCwgYXV0aFRva2VuKSB7XG4gIGNvbnN0IG1heEF0dGVtcHRzID0gMztcbiAgY29uc3QgYmFzZUJhY2tvZmZNcyA9IDEwMDA7IC8vIDFcdUNEMDhcblxuICBmb3IgKGxldCBhdHRlbXB0ID0gMTsgYXR0ZW1wdCA8PSBtYXhBdHRlbXB0czsgYXR0ZW1wdCsrKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYCR7U1VQQUJBU0VfVVJMfS9yZXN0L3YxL3VzZXJfZW5jcnlwdGlvbl9zYWx0c2AsIHtcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke2F1dGhUb2tlbn1gLFxuICAgICAgICAgICdhcGlrZXknOiBTVVBBQkFTRV9BTk9OX0tFWSxcbiAgICAgICAgICAnUHJlZmVyJzogJ3Jlc29sdXRpb249aWdub3JlLWR1cGxpY2F0ZXMnIC8vIFx1Qzc3NFx1QkJGOCBcdUM3ODhcdUM3M0NcdUJBNzQgXHVCQjM0XHVDMkRDXG4gICAgICAgIH0sXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICB1c2VyX2lkOiB1c2VySWQsXG4gICAgICAgICAgc2FsdDogc2FsdFxuICAgICAgICB9KVxuICAgICAgfSk7XG5cbiAgICAgIGlmIChyZXNwb25zZS5vayB8fCByZXNwb25zZS5zdGF0dXMgPT09IDQwOSkge1xuICAgICAgICAvLyBcdUMxMzFcdUFDRjUgKDIwMSBDcmVhdGVkKSBcdUI2MTBcdUIyOTQgXHVDNzc0XHVCQkY4IFx1Qzg3NFx1QzdBQ1x1RDU2OCAoNDA5IENvbmZsaWN0KVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIC8vIDR4eC81eHggXHVDNUQwXHVCN0VDXG4gICAgICBjb25zdCBlcnJvclRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9OiAke2Vycm9yVGV4dH1gKTtcblxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKGBbRGFpbHkgU2NydW1dIFNhbHQgc2F2ZSBhdHRlbXB0ICR7YXR0ZW1wdH0vJHttYXhBdHRlbXB0c30gZmFpbGVkOmAsIGVycm9yLm1lc3NhZ2UpO1xuXG4gICAgICBpZiAoYXR0ZW1wdCA+PSBtYXhBdHRlbXB0cykge1xuICAgICAgICAvLyBcdUNENUNcdUM4ODUgXHVDMkU0XHVEMzI4XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIHNhdmUgc2FsdCBhZnRlciAke21heEF0dGVtcHRzfSBhdHRlbXB0czogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgICAgfVxuXG4gICAgICAvLyBFeHBvbmVudGlhbCBiYWNrb2ZmOiAxXHVDRDA4LCAyXHVDRDA4LCA0XHVDRDA4XG4gICAgICBjb25zdCBiYWNrb2ZmTXMgPSBiYXNlQmFja29mZk1zICogTWF0aC5wb3coMiwgYXR0ZW1wdCAtIDEpO1xuICAgICAgY29uc29sZS5sb2coYFtEYWlseSBTY3J1bV0gUmV0cnlpbmcgaW4gJHtiYWNrb2ZmTXN9bXMuLi5gKTtcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCBiYWNrb2ZmTXMpKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBTdXBhYmFzZVx1QzVEMFx1QzExQyBcdUFFMzBcdUM4NzQgc2FsdCBcdUM4NzBcdUQ2OEMgKFx1QjJFNFx1QzkxMSBcdUI1MTRcdUJDMTRcdUM3NzRcdUMyQTQgXHVDOUMwXHVDNkQwKVxuICpcbiAqIFx1QjJFNFx1Qjk3OCBcdUI1MTRcdUJDMTRcdUM3NzRcdUMyQTRcdUM1RDBcdUMxMUMgXHVDNzc0XHVCQkY4IHNhbHRcdUI5N0MgXHVDMEREXHVDMTMxXHVENTg4XHVDNzQ0IFx1QzIxOCBcdUM3ODhcdUM3M0NcdUJCQzBcdUI4NUMsXG4gKiBcdUMwQzggc2FsdFx1Qjk3QyBcdUMwRERcdUMxMzFcdUQ1NThcdUFFMzAgXHVDODA0XHVDNUQwIFx1QzExQ1x1QkM4NFx1QzVEMCBcdUFFMzBcdUM4NzQgc2FsdFx1QUMwMCBcdUM3ODhcdUIyOTRcdUM5QzAgXHVENjU1XHVDNzc4XHVENTY5XHVCMkM4XHVCMkU0LlxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSB1c2VySWQgLSBVc2VyIElEXG4gKiBAcGFyYW0ge3N0cmluZ30gYXV0aFRva2VuIC0gU3VwYWJhc2UgYXV0aCB0b2tlblxuICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nfG51bGw+fSBcdUMxMUNcdUJDODRcdUM1RDAgXHVDODAwXHVDN0E1XHVCNDFDIHNhbHQsIFx1QzVDNlx1QzczQ1x1QkE3NCBudWxsXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZldGNoU2FsdEZyb21TdXBhYmFzZSh1c2VySWQsIGF1dGhUb2tlbikge1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXG4gICAgICBgJHtTVVBBQkFTRV9VUkx9L3Jlc3QvdjEvdXNlcl9lbmNyeXB0aW9uX3NhbHRzP3VzZXJfaWQ9ZXEuJHt1c2VySWR9JnNlbGVjdD1zYWx0YCxcbiAgICAgIHtcbiAgICAgICAgbWV0aG9kOiAnR0VUJyxcbiAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke2F1dGhUb2tlbn1gLFxuICAgICAgICAgICdhcGlrZXknOiBTVVBBQkFTRV9BTk9OX0tFWVxuICAgICAgICB9XG4gICAgICB9XG4gICAgKTtcblxuICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c306ICR7YXdhaXQgcmVzcG9uc2UudGV4dCgpfWApO1xuICAgIH1cblxuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG5cbiAgICBpZiAoZGF0YSAmJiBkYXRhLmxlbmd0aCA+IDAgJiYgZGF0YVswXS5zYWx0KSB7XG4gICAgICByZXR1cm4gZGF0YVswXS5zYWx0O1xuICAgIH1cblxuICAgIHJldHVybiBudWxsOyAvLyBTYWx0IG5vdCBmb3VuZCBvbiBzZXJ2ZXJcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIEZhaWxlZCB0byBmZXRjaCBzYWx0IGZyb20gc2VydmVyOicsIGVycm9yLm1lc3NhZ2UpO1xuICAgIHRocm93IGVycm9yO1xuICB9XG59XG5cbi8qKlxuICogXHVDMTFDXHVCQzg0IFNhbHQgXHVDMEREXHVDMTMxIChcdUNENUNcdUMxOEMgMTZcdUJDMTRcdUM3NzRcdUQyQjgsIENTUFJORylcbiAqXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxzdHJpbmc+fVxuICovXG5hc3luYyBmdW5jdGlvbiBnZW5lcmF0ZVNlcnZlclNhbHQoKSB7XG4gIC8vIDJcdUFDMUNcdUM3NTggVVVJRCBcdUFDQjBcdUQ1NjkgXHUyMTkyIDMyXHVCQzE0XHVDNzc0XHVEMkI4ICgyNTZcdUJFNDRcdUQyQjgpXG4gIHJldHVybiBjcnlwdG8ucmFuZG9tVVVJRCgpICsgY3J5cHRvLnJhbmRvbVVVSUQoKTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gU3VwYWJhc2UgXHVDODA0XHVDMUExXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogXHVDNTU0XHVENjM4XHVENjU0XHVCNDFDIFx1QjM3MFx1Qzc3NFx1RDEzMFx1Qjk3QyBTdXBhYmFzZSBFZGdlIEZ1bmN0aW9uXHVDNUQwIFx1QzgwNFx1QzFBMVxuICpcbiAqIFx1QzdBQ1x1QzJEQ1x1QjNDNCBcdUI4NUNcdUM5QzE6IFx1Q0Q1Q1x1QjMwMCAzXHVENjhDLCBleHBvbmVudGlhbCBiYWNrb2ZmXG4gKlxuICogQHBhcmFtIHtBcnJheTx7aXY6IG51bWJlcltdLCBjaXBoZXJ0ZXh0OiBudW1iZXJbXSwgYWxnb3JpdGhtOiBzdHJpbmcsIHRpbWVzdGFtcDogbnVtYmVyfT59IGVuY3J5cHRlZEl0ZW1zXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxib29sZWFuPn0gXHVDMTMxXHVBQ0Y1IFx1QzVFQ1x1QkQ4MFxuICovXG5hc3luYyBmdW5jdGlvbiBzZW5kVG9TdXBhYmFzZShlbmNyeXB0ZWRJdGVtcykge1xuICBjb25zdCBlbmRwb2ludCA9IGAke1NVUEFCQVNFX1VSTH0vZnVuY3Rpb25zL3YxL2luZ2VzdC1kYXRhYDtcblxuICAvLyBTZW5kaW5nIGJhdGNoIHRvIFN1cGFiYXNlXG5cbiAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPCBNQVhfUkVUUllfQVRURU1QVFM7IGF0dGVtcHQrKykge1xuICAgIHRyeSB7XG4gICAgICAvLyBjaHJvbWUuc3RvcmFnZVx1QzVEMFx1QzExQyBhdXRoVG9rZW4gXHVBQzAwXHVDODM4XHVDNjI0XHVBRTMwIChTZXJ2aWNlIFdvcmtlclx1QjI5NCBzdGF0ZWxlc3MpXG4gICAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoWydhdXRoVG9rZW4nXSk7XG5cbiAgICAgIGlmICghc3RvcmVkLmF1dGhUb2tlbikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIFx1Mjc0QyBObyBhdXRoIHRva2VuIGluIHN0b3JhZ2UnKTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuXG4gICAgICAvLyBQT1NUIFx1QzY5NFx1Q0NBRFxuICAgICAgY29uc3QgcGF5bG9hZCA9IHsgaXRlbXM6IGVuY3J5cHRlZEl0ZW1zIH07XG4gICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGVuZHBvaW50LCB7XG4gICAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHtzdG9yZWQuYXV0aFRva2VufWBcbiAgICAgICAgfSxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkocGF5bG9hZClcbiAgICAgIH0pO1xuXG4gICAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICAgIGNvbnN0IGVycm9yVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICAgICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSAtIEVycm9yIHJlc3BvbnNlOicsIGVycm9yVGV4dCk7XG5cbiAgICAgICAgLy8gNDAxIFx1QzVEMFx1QjdFQzogXHVEMUEwXHVEMDcwIFx1QjlDQ1x1QjhDQyBcdTIxOTIgXHVBQzMxXHVDMkUwIFx1QzJEQ1x1QjNDNCBcdUQ2QzQgXHVDN0FDXHVDMkRDXHVCM0M0XG4gICAgICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQwMSkge1xuICAgICAgICAgIGNvbnN0IG5ld1Rva2VuID0gYXdhaXQgcmVmcmVzaEF1dGhUb2tlbigpO1xuXG4gICAgICAgICAgaWYgKG5ld1Rva2VuKSB7XG4gICAgICAgICAgICAvLyBcdUQxQTBcdUQwNzAgXHVBQzMxXHVDMkUwIFx1QzEzMVx1QUNGNSBcdTIxOTIgXHVBQzE5XHVDNzQwIGF0dGVtcHRcdUM1RDBcdUMxMUMgXHVDN0FDXHVDMkRDXHVCM0M0XG4gICAgICAgICAgICBjb25zdCByZXRyeVJlc3BvbnNlID0gYXdhaXQgZmV0Y2goZW5kcG9pbnQsIHtcbiAgICAgICAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke25ld1Rva2VufWBcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkocGF5bG9hZClcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAocmV0cnlSZXNwb25zZS5vaykge1xuICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgcmV0cnlFcnJvclRleHQgPSBhd2FpdCByZXRyeVJlc3BvbnNlLnRleHQoKTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3JldHJ5UmVzcG9uc2Uuc3RhdHVzfSBhZnRlciB0b2tlbiByZWZyZXNoOiAke3JldHJ5RXJyb3JUZXh0fWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c306ICR7ZXJyb3JUZXh0fWApO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc29sZS5lcnJvcihgW0RhaWx5IFNjcnVtXSBTZW5kIGF0dGVtcHQgJHthdHRlbXB0ICsgMX0vJHtNQVhfUkVUUllfQVRURU1QVFN9IGZhaWxlZDpgLCBlcnJvci5tZXNzYWdlKTtcblxuICAgICAgLy8gXHVCOUM4XHVDOUMwXHVCOUM5IFx1QzJEQ1x1QjNDNFx1QUMwMCBcdUM1NDRcdUIyQzhcdUJBNzQgXHVDN0FDXHVDMkRDXHVCM0M0XG4gICAgICBpZiAoYXR0ZW1wdCA8IE1BWF9SRVRSWV9BVFRFTVBUUyAtIDEpIHtcbiAgICAgICAgLy8gRXhwb25lbnRpYWwgYmFja29mZjogMVx1Q0QwOCwgMlx1Q0QwOCwgNFx1Q0QwOFxuICAgICAgICBjb25zdCBkZWxheSA9IElOSVRJQUxfUkVUUllfREVMQVkgKiBNYXRoLnBvdygyLCBhdHRlbXB0KTtcbiAgICAgICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gRmFpbGVkIHRvIHNlbmQgZGF0YSBhZnRlcicsIE1BWF9SRVRSWV9BVFRFTVBUUywgJ2F0dGVtcHRzJyk7XG4gIHJldHVybiBmYWxzZTtcbn1cblxuLyoqXG4gKiBTbGVlcCBcdUM3MjBcdUQyRjhcdUI5QUNcdUQyRjBcbiAqXG4gKiBAcGFyYW0ge251bWJlcn0gbXMgLSBcdUJDMDBcdUI5QUNcdUNEMDhcbiAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fVxuICovXG5mdW5jdGlvbiBzbGVlcChtcykge1xuICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIG1zKSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBU0EsSUFBTSxVQUFVO0FBQ2hCLElBQU0sYUFBYTtBQUNuQixJQUFNLGFBQWE7QUFDbkIsSUFBTSxpQkFBaUIsS0FBSyxLQUFLO0FBSzFCLElBQU0sYUFBTixNQUFpQjtBQUFBLEVBQ3RCLGNBQWM7QUFDWixTQUFLLEtBQUs7QUFBQSxFQUNaO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU1BLE1BQU0sVUFBVTtBQUNkLFFBQUksS0FBSyxHQUFJLFFBQU8sS0FBSztBQUV6QixXQUFPLElBQUksUUFBUSxDQUFDLFNBQVMsV0FBVztBQUN0QyxZQUFNLFVBQVUsVUFBVSxLQUFLLFNBQVMsVUFBVTtBQUVsRCxjQUFRLFVB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
