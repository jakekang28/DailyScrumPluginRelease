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
  REFRESH_TOKEN: "refreshToken"
};
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
});
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
async function handleDataCaptured(payload, sender) {
  try {
    const { consentGiven } = await chrome.storage.local.get(["consentGiven"]);
    if (consentGiven !== true) {
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
      if (authToken) {
        try {
          const existingSalt = await fetchSaltFromSupabase(userId, authToken);
          if (existingSalt) {
            salt = existingSalt;
            await chrome.storage.local.set({ [STORAGE_KEYS.SERVER_SALT]: salt });
            console.log("[Daily Scrum] \u2705 Downloaded existing salt from server (multi-device sync)");
          }
        } catch (error) {
          console.warn("[Daily Scrum] \u26A0\uFE0F Failed to fetch existing salt from server:", error.message);
        }
      }
      if (!salt) {
        salt = await generateServerSalt();
        saltWasGenerated = true;
        await chrome.storage.local.set({ [STORAGE_KEYS.SERVER_SALT]: salt });
        console.log("[Daily Scrum] \u2705 Generated new server salt (first login)");
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vbGliL3RlbXAtYnVmZmVyLmpzIiwgIi4uL2xpYi9lbmNyeXB0aW9uLmpzIiwgIi4uL2xpYi9jb25maWcuanMiLCAiLi4vbGliL2dvb2dsZS1hcGktY2xpZW50LmpzIiwgIi4uL2JhY2tncm91bmQuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVGVtcEJ1ZmZlciAtIEluZGV4ZWREQiBcdUFFMzBcdUJDMTggXHVDNzg0XHVDMkRDIFx1QkM4NFx1RDM3Q1xuICpcbiAqIFx1QkU0NFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMwQzFcdUQwRENcdUM1RDBcdUMxMUMgXHVDMjE4XHVDOUQxXHVCNDFDIFx1QjM3MFx1Qzc3NFx1RDEzMFx1Qjk3QyBcdUM3ODRcdUMyREMgXHVDODAwXHVDN0E1XHVENTY5XHVCMkM4XHVCMkU0LlxuICogXHVCODVDXHVBREY4XHVDNzc4IFx1QzJEQyBmbHVzaFRvU2VydmVyKClcdUI4NUMgXHVDMTFDXHVCQzg0XHVDNUQwIFx1QzgwNFx1QzFBMSBcdUQ2QzQgXHVDMEFEXHVDODFDXHVCNDI5XHVCMkM4XHVCMkU0LlxuICpcbiAqIEBzZWUgcmVzZWFyY2gubWQgNC4yXHVDODA4XG4gKi9cblxuY29uc3QgREJfTkFNRSA9ICdkYWlseVNjcnVtQnVmZmVyJztcbmNvbnN0IERCX1ZFUlNJT04gPSAxO1xuY29uc3QgU1RPUkVfTkFNRSA9ICdjYXB0dXJlcyc7XG5jb25zdCBDTEVBTlVQX0FHRV9NUyA9IDMwICogNjAgKiAxMDAwOyAvLyAzMFx1QkQ4NFxuXG4vKipcbiAqIFRlbXBCdWZmZXIgXHVEMDc0XHVCNzk4XHVDMkE0XG4gKi9cbmV4cG9ydCBjbGFzcyBUZW1wQnVmZmVyIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgdGhpcy5kYiA9IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogSW5kZXhlZERCIFx1Q0QwOFx1QUUzMFx1RDY1NFxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxJREJEYXRhYmFzZT59XG4gICAqL1xuICBhc3luYyBfaW5pdERCKCkge1xuICAgIGlmICh0aGlzLmRiKSByZXR1cm4gdGhpcy5kYjtcblxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCByZXF1ZXN0ID0gaW5kZXhlZERCLm9wZW4oREJfTkFNRSwgREJfVkVSU0lPTik7XG5cbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHtcbiAgICAgICAgY29uc29sZS5lcnJvcignW1RlbXBCdWZmZXJdIEluZGV4ZWREQiBvcGVuIGVycm9yOicsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB9O1xuXG4gICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgICAgdGhpcy5kYiA9IHJlcXVlc3QucmVzdWx0O1xuICAgICAgICByZXNvbHZlKHRoaXMuZGIpO1xuICAgICAgfTtcblxuICAgICAgcmVxdWVzdC5vbnVwZ3JhZGVuZWVkZWQgPSAoZXZlbnQpID0+IHtcbiAgICAgICAgY29uc3QgZGIgPSBldmVudC50YXJnZXQucmVzdWx0O1xuXG4gICAgICAgIC8vIE9iamVjdCBTdG9yZSBcdUMwRERcdUMxMzFcbiAgICAgICAgaWYgKCFkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKFNUT1JFX05BTUUpKSB7XG4gICAgICAgICAgY29uc3Qgb2JqZWN0U3RvcmUgPSBkYi5jcmVhdGVPYmplY3RTdG9yZShTVE9SRV9OQU1FLCB7XG4gICAgICAgICAgICBrZXlQYXRoOiAnaWQnLFxuICAgICAgICAgICAgYXV0b0luY3JlbWVudDogdHJ1ZVxuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgLy8gXHVDNzc4XHVCMzcxXHVDMkE0IFx1QzBERFx1QzEzMTogdGltZXN0YW1wXHVCODVDIFx1QkU2MFx1Qjk3OCBcdUM4NzBcdUQ2OEMvXHVDODE1XHVCOUFDXG4gICAgICAgICAgb2JqZWN0U3RvcmUuY3JlYXRlSW5kZXgoJ3RpbWVzdGFtcCcsICd0aW1lc3RhbXAnLCB7IHVuaXF1ZTogZmFsc2UgfSk7XG5cbiAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgcmVxdWVzdC5vbmJsb2NrZWQgPSAoKSA9PiB7XG4gICAgICAgIGNvbnNvbGUud2FybignW1RlbXBCdWZmZXJdIEluZGV4ZWREQiBibG9ja2VkIGJ5IGFub3RoZXIgY29ubmVjdGlvbicpO1xuICAgICAgICByZWplY3QobmV3IEVycm9yKCdJbmRleGVkREIgYmxvY2tlZCcpKTtcbiAgICAgIH07XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogXHVCMzcwXHVDNzc0XHVEMTMwIFx1Q0Q5NFx1QUMwMFxuICAgKiBAcGFyYW0ge09iamVjdH0gZGF0YSAtIFx1QzgwMFx1QzdBNVx1RDU2MCBcdUIzNzBcdUM3NzRcdUQxMzBcbiAgICogQHJldHVybnMge1Byb21pc2U8bnVtYmVyPn0gLSBcdUNEOTRcdUFDMDBcdUI0MUMgXHVENTZEXHVCQUE5XHVDNzU4IElEXG4gICAqL1xuICBhc3luYyBhZGQoZGF0YSkge1xuICAgIHRyeSB7XG4gICAgICAvLyBcdUJBM0NcdUM4MDAgXHVDNjI0XHVCNzk4XHVCNDFDIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUM4MTVcdUI5QUNcbiAgICAgIGF3YWl0IHRoaXMuY2xlYW51cCgpO1xuXG4gICAgICBjb25zdCBkYiA9IGF3YWl0IHRoaXMuX2luaXREQigpO1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihbU1RPUkVfTkFNRV0sICdyZWFkd3JpdGUnKTtcbiAgICAgIGNvbnN0IHN0b3JlID0gdHJhbnNhY3Rpb24ub2JqZWN0U3RvcmUoU1RPUkVfTkFNRSk7XG5cbiAgICAgIC8vIHRpbWVzdGFtcCBcdUNEOTRcdUFDMDBcbiAgICAgIGNvbnN0IHJlY29yZCA9IHtcbiAgICAgICAgLi4uZGF0YSxcbiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpXG4gICAgICB9O1xuXG4gICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUuYWRkKHJlY29yZCk7XG5cbiAgICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgICAgcmVzb2x2ZShyZXF1ZXN0LnJlc3VsdCk7XG4gICAgICAgIH07XG5cbiAgICAgICAgcmVxdWVzdC5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBBZGQgZXJyb3I6JywgcmVxdWVzdC5lcnJvcik7XG4gICAgICAgICAgcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICB9O1xuXG4gICAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiB7XG4gICAgICAgIH07XG5cbiAgICAgICAgdHJhbnNhY3Rpb24ub25lcnJvciA9ICgpID0+IHtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gQWRkIHRyYW5zYWN0aW9uIGVycm9yOicsIHRyYW5zYWN0aW9uLmVycm9yKTtcbiAgICAgICAgICByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IpO1xuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBhZGQoKSBlcnJvcjonLCBlcnJvcik7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogMzBcdUJEODQgXHVDNzc0XHVDMEMxIFx1QjQxQyBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDMEFEXHVDODFDXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPG51bWJlcj59IC0gXHVDMEFEXHVDODFDXHVCNDFDIFx1RDU2RFx1QkFBOSBcdUMyMThcbiAgICovXG4gIGFzeW5jIGNsZWFudXAoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRiID0gYXdhaXQgdGhpcy5faW5pdERCKCk7XG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKFtTVE9SRV9OQU1FXSwgJ3JlYWR3cml0ZScpO1xuICAgICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShTVE9SRV9OQU1FKTtcbiAgICAgIGNvbnN0IGluZGV4ID0gc3RvcmUuaW5kZXgoJ3RpbWVzdGFtcCcpO1xuXG4gICAgICBjb25zdCBjdXRvZmZUaW1lID0gRGF0ZS5ub3coKSAtIENMRUFOVVBfQUdFX01TO1xuICAgICAgY29uc3QgcmFuZ2UgPSBJREJLZXlSYW5nZS51cHBlckJvdW5kKGN1dG9mZlRpbWUpO1xuXG4gICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBsZXQgZGVsZXRlZENvdW50ID0gMDtcbiAgICAgICAgY29uc3QgY3Vyc29yUmVxdWVzdCA9IGluZGV4Lm9wZW5DdXJzb3IocmFuZ2UpO1xuXG4gICAgICAgIGN1cnNvclJlcXVlc3Qub25zdWNjZXNzID0gKGV2ZW50KSA9PiB7XG4gICAgICAgICAgY29uc3QgY3Vyc29yID0gZXZlbnQudGFyZ2V0LnJlc3VsdDtcbiAgICAgICAgICBpZiAoY3Vyc29yKSB7XG4gICAgICAgICAgICBjdXJzb3IuZGVsZXRlKCk7XG4gICAgICAgICAgICBkZWxldGVkQ291bnQrKztcbiAgICAgICAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgfTtcblxuICAgICAgICBjdXJzb3JSZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcignW1RlbXBCdWZmZXJdIENsZWFudXAgY3Vyc29yIGVycm9yOicsIGN1cnNvclJlcXVlc3QuZXJyb3IpO1xuICAgICAgICAgIHJlamVjdChjdXJzb3JSZXF1ZXN0LmVycm9yKTtcbiAgICAgICAgfTtcblxuICAgICAgICB0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4ge1xuICAgICAgICAgIGlmIChkZWxldGVkQ291bnQgPiAwKSB7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJlc29sdmUoZGVsZXRlZENvdW50KTtcbiAgICAgICAgfTtcblxuICAgICAgICB0cmFuc2FjdGlvbi5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBDbGVhbnVwIHRyYW5zYWN0aW9uIGVycm9yOicsIHRyYW5zYWN0aW9uLmVycm9yKTtcbiAgICAgICAgICByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IpO1xuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBjbGVhbnVwKCkgZXJyb3I6JywgZXJyb3IpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFx1QzgwNFx1Q0NCNCBcdUIzNzBcdUM3NzRcdUQxMzBcdUI5N0MgXHVDMTFDXHVCQzg0XHVCODVDIGZsdXNoXG4gICAqIEBwYXJhbSB7RnVuY3Rpb259IGVuY3J5cHRBbmRTZW5kIC0gXHVDNTU0XHVENjM4XHVENjU0IFx1QkMwRiBcdUM4MDRcdUMxQTEgXHVDRjVDXHVCQzMxOiBhc3luYyAoZGF0YSkgPT4gdm9pZFxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxudW1iZXI+fSAtIFx1QzgwNFx1QzFBMVx1QjQxQyBcdUQ1NkRcdUJBQTkgXHVDMjE4XG4gICAqL1xuICBhc3luYyBmbHVzaFRvU2VydmVyKGVuY3J5cHRBbmRTZW5kKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRiID0gYXdhaXQgdGhpcy5faW5pdERCKCk7XG5cbiAgICAgIC8vIDEuIFx1QkFBOFx1QjRFMCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDNzdEXHVBRTMwXG4gICAgICBjb25zdCBhbGxEYXRhID0gYXdhaXQgdGhpcy5fZ2V0QWxsRGF0YShkYik7XG5cbiAgICAgIGlmIChhbGxEYXRhLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXR1cm4gMDtcbiAgICAgIH1cblxuXG4gICAgICAvLyAyLiBcdUNGNUNcdUJDMzFcdUM1RDAgXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzgwNFx1QjJFQyAoXHVDNTU0XHVENjM4XHVENjU0IFx1QkMwRiBcdUM4MDRcdUMxQTEpXG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBlbmNyeXB0QW5kU2VuZChhbGxEYXRhKTtcbiAgICAgIH0gY2F0Y2ggKHNlbmRFcnJvcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gZW5jcnlwdEFuZFNlbmQgY2FsbGJhY2sgZXJyb3I6Jywgc2VuZEVycm9yKTtcbiAgICAgICAgdGhyb3cgc2VuZEVycm9yO1xuICAgICAgfVxuXG4gICAgICAvLyAzLiBcdUM4MDRcdUMxQTEgXHVDMTMxXHVBQ0Y1IFx1QzJEQyBcdUJBQThcdUI0RTAgXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzBBRFx1QzgxQ1xuICAgICAgYXdhaXQgdGhpcy5fY2xlYXJBbGwoZGIpO1xuXG4gICAgICByZXR1cm4gYWxsRGF0YS5sZW5ndGg7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tUZW1wQnVmZmVyXSBmbHVzaFRvU2VydmVyKCkgZXJyb3I6JywgZXJyb3IpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFx1QkFBOFx1QjRFMCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDNzdEXHVBRTMwIChcdUIwQjRcdUJEODAgXHVENUVDXHVEMzdDKVxuICAgKiBAcGFyYW0ge0lEQkRhdGFiYXNlfSBkYlxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxBcnJheT59XG4gICAqL1xuICBhc3luYyBfZ2V0QWxsRGF0YShkYikge1xuICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oW1NUT1JFX05BTUVdLCAncmVhZG9ubHknKTtcbiAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKFNUT1JFX05BTUUpO1xuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5nZXRBbGwoKTtcblxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgIHJlc29sdmUocmVxdWVzdC5yZXN1bHQpO1xuICAgICAgfTtcblxuICAgICAgcmVxdWVzdC5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gZ2V0QWxsIGVycm9yOicsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB9O1xuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFx1QkFBOFx1QjRFMCBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDMEFEXHVDODFDIChcdUIwQjRcdUJEODAgXHVENUVDXHVEMzdDKVxuICAgKiBAcGFyYW0ge0lEQkRhdGFiYXNlfSBkYlxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTx2b2lkPn1cbiAgICovXG4gIGFzeW5jIF9jbGVhckFsbChkYikge1xuICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oW1NUT1JFX05BTUVdLCAncmVhZHdyaXRlJyk7XG4gICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShTVE9SRV9OQU1FKTtcblxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUuY2xlYXIoKTtcblxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH07XG5cbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHtcbiAgICAgICAgY29uc29sZS5lcnJvcignW1RlbXBCdWZmZXJdIGNsZWFyIGVycm9yOicsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB9O1xuXG4gICAgICB0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4ge1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9O1xuXG4gICAgICB0cmFuc2FjdGlvbi5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gQ2xlYXIgdHJhbnNhY3Rpb24gZXJyb3I6JywgdHJhbnNhY3Rpb24uZXJyb3IpO1xuICAgICAgICByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IpO1xuICAgICAgfTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBcdUM4MDBcdUM3QTVcdUI0MUMgXHVENTZEXHVCQUE5IFx1QzIxOCBcdUM4NzBcdUQ2OEMgKFx1RDMxRFx1QzVDNSBcdUMwQzFcdUQwREMgXHVENDVDXHVDMkRDXHVDNkE5KVxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxudW1iZXI+fVxuICAgKi9cbiAgYXN5bmMgZ2V0Q291bnQoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRiID0gYXdhaXQgdGhpcy5faW5pdERCKCk7XG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKFtTVE9SRV9OQU1FXSwgJ3JlYWRvbmx5Jyk7XG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKFNUT1JFX05BTUUpO1xuXG4gICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUuY291bnQoKTtcblxuICAgICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgICAgICByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcbiAgICAgICAgfTtcblxuICAgICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcignW1RlbXBCdWZmZXJdIGNvdW50IGVycm9yOicsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgICAgIHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdbVGVtcEJ1ZmZlcl0gZ2V0Q291bnQoKSBlcnJvcjonLCBlcnJvcik7XG4gICAgICByZXR1cm4gMDsgLy8gXHVDNUQwXHVCN0VDIFx1QzJEQyAwIFx1QkMxOFx1RDY1OCAoVUlcdUFDMDAgXHVBRTY4XHVDOUMwXHVDOUMwIFx1QzU0QVx1QjNDNFx1Qjg1RClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogSW5kZXhlZERCIFx1QzVGMFx1QUNCMCBcdUIyRUJcdUFFMzBcbiAgICovXG4gIGNsb3NlKCkge1xuICAgIGlmICh0aGlzLmRiKSB7XG4gICAgICB0aGlzLmRiLmNsb3NlKCk7XG4gICAgICB0aGlzLmRiID0gbnVsbDtcbiAgICB9XG4gIH1cbn1cblxuLy8gXHVDMkYxXHVBRTAwXHVEMUE0IFx1Qzc3OFx1QzJBNFx1RDEzNFx1QzJBNCBleHBvcnRcbmV4cG9ydCBjb25zdCB0ZW1wQnVmZmVyID0gbmV3IFRlbXBCdWZmZXIoKTtcbiIsICIvKipcbiAqIEVuY3J5cHRpb24gRW5naW5lIGZvciBEYWlseSBTY3J1bSBFeHRlbnNpb25cbiAqXG4gKiBcdUJDRjRcdUM1NDggXHVCQUE4XHVCMzc4OiBUcmFuc2l0IEVuY3J5cHRpb24gKEUyRSBcdUM1NDRcdUIyRDgpXG4gKiAtIFx1QzExQ1x1QkM4NFx1QUMwMCB1c2VySWQgKyBzZXJ2ZXJTYWx0XHVCODVDIFx1RDBBNCBcdUM3QUNcdUQzMENcdUMwREQgXHVBQzAwXHVCMkE1XG4gKiAtIFx1QjEyNFx1RDJCOFx1QzZDQ1x1RDA2QyBcdUM4MDRcdUMxQTEgXHVDOTExIFx1QjNDNFx1Q0NBRCBcdUJDMjlcdUM5QzAgXHVCQUE5XHVDODAxXG4gKlxuICogQHNlZSBkb2NzL3Jlc2VhcmNoLm1kIDVcdUM4MDhcbiAqL1xuXG4vKipcbiAqIEFFUy1HQ00tMjU2IFx1QzU1NFx1RDYzOFx1RDY1NCBcdUM1RDRcdUM5QzRcbiAqXG4gKiBcdUQwQTQgXHVEMzBDXHVDMEREOiBQQktERjIgKFNIQS0yNTYsIDEwMCwwMDAgaXRlcmF0aW9ucylcbiAqIFx1QzU1NFx1RDYzOFx1RDY1NDogQUVTLUdDTS0yNTYgKFx1Qzc3OFx1Qzk5RFx1QjQxQyBcdUM1NTRcdUQ2MzhcdUQ2NTQpXG4gKiBJVjogMTJcdUJDMTRcdUM3NzRcdUQyQjggKDk2XHVCRTQ0XHVEMkI4KSBcdUI3OUNcdUIzNjQgXHVDMEREXHVDMTMxXG4gKlxuICogQGNsYXNzXG4gKi9cbmV4cG9ydCBjbGFzcyBFbmNyeXB0aW9uRW5naW5lIHtcbiAgLyoqXG4gICAqIEBwcml2YXRlXG4gICAqIEB0eXBlIHtDcnlwdG9LZXl8bnVsbH1cbiAgICovXG4gICNrZXkgPSBudWxsO1xuXG4gIC8qKlxuICAgKiBQQktERjIgaXRlcmF0aW9uIGNvdW50XG4gICAqIEBwcml2YXRlXG4gICAqIEBjb25zdGFudCB7bnVtYmVyfVxuICAgKi9cbiAgc3RhdGljICNQQktERjJfSVRFUkFUSU9OUyA9IDMwMDAwMDsgIC8vIFx1QURFMFx1RDYxNVx1QzdBMVx1RDc4QyBcdUJDRjRcdUM1NDgvXHVDMTMxXHVCMkE1IChPV0FTUCAyMDI2IFx1QUQ4Q1x1QzdBNTogNjAwLDAwMCspXG5cbiAgLyoqXG4gICAqIEFFUy1HQ00gSVYgbGVuZ3RoIChieXRlcylcbiAgICogQHByaXZhdGVcbiAgICogQGNvbnN0YW50IHtudW1iZXJ9XG4gICAqL1xuICBzdGF0aWMgI0lWX0xFTkdUSCA9IDEyOyAgLy8gOTYgYml0cyAoXHVENDVDXHVDOTAwIFx1QUQ4Q1x1QzdBNSlcblxuICAvKipcbiAgICogTWF4aW11bSBjaXBoZXJ0ZXh0IHNpemUgKGJ5dGVzKSAtIERvUyBcdUJDMjlcdUM5QzBcbiAgICogQHByaXZhdGVcbiAgICogQGNvbnN0YW50IHtudW1iZXJ9XG4gICAqL1xuICBzdGF0aWMgI01BWF9DSVBIRVJURVhUX1NJWkUgPSAxMCAqIDEwMjQgKiAxMDI0OyAgLy8gMTBNQlxuXG4gIC8qKlxuICAgKiBcdUM1NTRcdUQ2MzhcdUQ2NTQgXHVEMEE0IFx1RDMwQ1x1QzBERFxuICAgKlxuICAgKiBcdTI2QTBcdUZFMEYgXHVCQ0Y0XHVDNTQ4IFx1QUNCRFx1QUNFMDogdXNlcklkXHVCMjk0IFx1QzYwOFx1Q0UyMSBcdUFDMDBcdUIyQTVcdUQ1NThcdUJCQzBcdUI4NUMgXHVDOUM0XHVDODE1XHVENTVDIEUyRVx1QUMwMCBcdUM1NDRcdUIyRDhcbiAgICogXHVDMTFDXHVCQzg0XHVBQzAwIHVzZXJJZCArIHNlcnZlclNhbHRcdUI4NUMgXHVCM0Q5XHVDNzdDXHVENTVDIFx1RDBBNFx1Qjk3QyBcdUM3QUNcdUFENkNcdUMxMzFcdUQ1NjAgXHVDMjE4IFx1Qzc4OFx1Qzc0Q1xuICAgKlxuICAgKiBAcGFyYW0ge3N0cmluZ30gdXNlcklkIC0gU3VwYWJhc2UgdXNlciBJRCAoVVVJRClcbiAgICogQHBhcmFtIHtzdHJpbmd9IHNlcnZlclNhbHQgLSBcdUMxMUNcdUJDODRcdUM1RDBcdUMxMUMgXHVDODFDXHVBQ0Y1XHVENTVDIHNhbHRcbiAgICogQHRocm93cyB7RXJyb3J9IHVzZXJJZCBcdUI2MTBcdUIyOTQgc2VydmVyU2FsdFx1QUMwMCBcdUJFNDRcdUM1QjRcdUM3ODhcdUM3NDQgXHVBQ0JEXHVDNkIwXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fVxuICAgKi9cbiAgYXN5bmMgZGVyaXZlS2V5KHVzZXJJZCwgc2VydmVyU2FsdCkge1xuICAgIGlmICghdXNlcklkIHx8ICFzZXJ2ZXJTYWx0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ3VzZXJJZCBhbmQgc2VydmVyU2FsdCBhcmUgcmVxdWlyZWQnKTtcbiAgICB9XG5cbiAgICBjb25zdCBlbmMgPSBuZXcgVGV4dEVuY29kZXIoKTtcblxuICAgIC8vIDEuIEtleSBtYXRlcmlhbCBcdUMwRERcdUMxMzEgKHVzZXJJZCBcdUFFMzBcdUJDMTgpXG4gICAgY29uc3Qga2V5TWF0ZXJpYWwgPSBhd2FpdCBjcnlwdG8uc3VidGxlLmltcG9ydEtleShcbiAgICAgICdyYXcnLFxuICAgICAgZW5jLmVuY29kZSh1c2VySWQpLFxuICAgICAgJ1BCS0RGMicsXG4gICAgICBmYWxzZSwgIC8vIGV4dHJhY3RhYmxlOiBmYWxzZVxuICAgICAgWydkZXJpdmVLZXknXVxuICAgICk7XG5cbiAgICAvLyAyLiBQQktERjJcdUI4NUMgQUVTLUdDTSBcdUQwQTQgXHVEMzBDXHVDMEREXG4gICAgdGhpcy4ja2V5ID0gYXdhaXQgY3J5cHRvLnN1YnRsZS5kZXJpdmVLZXkoXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdQQktERjInLFxuICAgICAgICBzYWx0OiBlbmMuZW5jb2RlKHNlcnZlclNhbHQpLFxuICAgICAgICBpdGVyYXRpb25zOiBFbmNyeXB0aW9uRW5naW5lLiNQQktERjJfSVRFUkFUSU9OUyxcbiAgICAgICAgaGFzaDogJ1NIQS0yNTYnXG4gICAgICB9LFxuICAgICAga2V5TWF0ZXJpYWwsXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdBRVMtR0NNJyxcbiAgICAgICAgbGVuZ3RoOiAyNTYgIC8vIDI1Ni1iaXQga2V5XG4gICAgICB9LFxuICAgICAgZmFsc2UsICAvLyBleHRyYWN0YWJsZTogZmFsc2UgKFx1RDBBNFx1Qjk3QyBcdUJBNTRcdUJBQThcdUI5QUNcdUM1RDBcdUMxMUMgXHVDRDk0XHVDRDlDIFx1QkQ4OFx1QUMwMClcbiAgICAgIFsnZW5jcnlwdCcsICdkZWNyeXB0J11cbiAgICApO1xuXG4gICAgLy8gXHVBQzFDXHVCQzFDIFx1RDY1OFx1QUNCRFx1QzVEMFx1QzExQ1x1QjlDQyBcdUI4NUNcdUFFNDUgKFx1RDUwNFx1Qjg1Q1x1QjM1NVx1QzE1OCBcdUQwQTQgXHVCMTc4XHVDRDlDIFx1QkMyOVx1QzlDMClcbiAgICBpZiAodHlwZW9mIHByb2Nlc3MgIT09ICd1bmRlZmluZWQnICYmIHByb2Nlc3MuZW52Py5OT0RFX0VOViA9PT0gJ2RldmVsb3BtZW50Jykge1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDNTU0XHVENjM4XHVENjU0XG4gICAqXG4gICAqIEBwYXJhbSB7YW55fSBkYXRhIC0gXHVDNTU0XHVENjM4XHVENjU0XHVENTYwIFx1QjM3MFx1Qzc3NFx1RDEzMCAoSlNPTiBcdUM5QzFcdUI4MkNcdUQ2NTQgXHVBQzAwXHVCMkE1XHVENTc0XHVDNTdDIFx1RDU2OClcbiAgICogQHRocm93cyB7RXJyb3J9IFx1RDBBNFx1QUMwMCBcdUQzMENcdUMwRERcdUI0MThcdUM5QzAgXHVDNTRBXHVDNTU4XHVBQzcwXHVCMDk4IFx1QzU1NFx1RDYzOFx1RDY1NCBcdUMyRTRcdUQzMjggXHVDMkRDXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHtpdjogbnVtYmVyW10sIGNpcGhlcnRleHQ6IG51bWJlcltdLCBhbGdvcml0aG06IHN0cmluZywgdGltZXN0YW1wOiBudW1iZXJ9Pn1cbiAgICovXG4gIGFzeW5jIGVuY3J5cHQoZGF0YSkge1xuICAgIGlmICghdGhpcy4ja2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0VuY3J5cHRpb24ga2V5IG5vdCBkZXJpdmVkLiBDYWxsIGRlcml2ZUtleSgpIGZpcnN0LicpO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICAvLyAxLiBcdUI3OUNcdUIzNjQgSVYgXHVDMEREXHVDMTMxICgxMlx1QkMxNFx1Qzc3NFx1RDJCOCwgOTZcdUJFNDRcdUQyQjgpXG4gICAgICBjb25zdCBpdiA9IGNyeXB0by5nZXRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkoRW5jcnlwdGlvbkVuZ2luZS4jSVZfTEVOR1RIKSk7XG5cbiAgICAgIC8vIDIuIFx1QjM3MFx1Qzc3NFx1RDEzMCBKU09OIFx1QzlDMVx1QjgyQ1x1RDY1NFxuICAgICAgY29uc3QgcGxhaW50ZXh0ID0gSlNPTi5zdHJpbmdpZnkoZGF0YSk7XG4gICAgICBjb25zdCBwbGFpbnRleHRCdWZmZXIgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUocGxhaW50ZXh0KTtcblxuICAgICAgLy8gMy4gQUVTLUdDTSBcdUM1NTRcdUQ2MzhcdUQ2NTRcbiAgICAgIGNvbnN0IGNpcGhlcnRleHRCdWZmZXIgPSBhd2FpdCBjcnlwdG8uc3VidGxlLmVuY3J5cHQoXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnQUVTLUdDTScsXG4gICAgICAgICAgaXY6IGl2XG4gICAgICAgIH0sXG4gICAgICAgIHRoaXMuI2tleSxcbiAgICAgICAgcGxhaW50ZXh0QnVmZmVyXG4gICAgICApO1xuXG4gICAgICAvLyA0LiBcdUNEOUNcdUI4MjUgXHVENjE1XHVDMkREIFx1QkNDMFx1RDY1OCAoVWludDhBcnJheSBcdTIxOTIgbnVtYmVyW10pXG4gICAgICByZXR1cm4ge1xuICAgICAgICBpdjogQXJyYXkuZnJvbShpdiksXG4gICAgICAgIGNpcGhlcnRleHQ6IEFycmF5LmZyb20obmV3IFVpbnQ4QXJyYXkoY2lwaGVydGV4dEJ1ZmZlcikpLFxuICAgICAgICBhbGdvcml0aG06ICdBRVMtR0NNLTI1NicsXG4gICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKVxuICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgLy8gXHVEMEMwXHVDNzc0XHVCQzBEIFx1QUNGNVx1QUNBOSBcdUJDMjlcdUM5QzA6IFx1QzVEMFx1QjdFQyBcdUFDMURcdUNDQjQgXHVCODVDXHVBRTQ1IFx1QUUwOFx1QzlDMFxuICAgICAgY29uc29sZS5lcnJvcignW0VuY3J5cHRpb25dIEVuY3J5cHRpb24gZmFpbGVkJyk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0VuY3J5cHRpb24gZmFpbGVkJyk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUJDRjVcdUQ2MzhcdUQ2NTRcbiAgICpcbiAgICogXHVEMEMwXHVDNzc0XHVCQzBEIFx1QUNGNVx1QUNBOSBcdUJDMjlcdUM5QzA6IFx1QkFBOFx1QjRFMCBcdUM1RDBcdUI3RUNcdUI5N0MgXHVCM0Q5XHVDNzdDXHVENTVDIFx1QkE1NFx1QzJEQ1x1QzlDMFx1Qjg1QyBcdUJDMThcdUQ2NThcbiAgICpcbiAgICogQHBhcmFtIHt7aXY6IG51bWJlcltdLCBjaXBoZXJ0ZXh0OiBudW1iZXJbXSwgYWxnb3JpdGhtOiBzdHJpbmd9fSBlbmNyeXB0ZWREYXRhXG4gICAqIEB0aHJvd3Mge0Vycm9yfSBcdUQwQTRcdUFDMDAgXHVEMzBDXHVDMEREXHVCNDE4XHVDOUMwIFx1QzU0QVx1QzU1OFx1QUM3MFx1QjA5OCBcdUJDRjVcdUQ2MzhcdUQ2NTQgXHVDMkU0XHVEMzI4IFx1QzJEQ1xuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxhbnk+fSBcdUJDRjVcdUQ2MzhcdUQ2NTRcdUI0MUMgXHVDNkQwXHVCQ0Y4IFx1QjM3MFx1Qzc3NFx1RDEzMFxuICAgKi9cbiAgYXN5bmMgZGVjcnlwdChlbmNyeXB0ZWREYXRhKSB7XG4gICAgaWYgKCF0aGlzLiNrZXkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignRW5jcnlwdGlvbiBrZXkgbm90IGRlcml2ZWQuIENhbGwgZGVyaXZlS2V5KCkgZmlyc3QuJyk7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIC8vIDEuIFx1Qzc4NVx1QjgyNSBcdUFDODBcdUM5OURcbiAgICAgIGlmICghZW5jcnlwdGVkRGF0YS5pdiB8fCAhZW5jcnlwdGVkRGF0YS5jaXBoZXJ0ZXh0KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBlbmNyeXB0ZWQgZGF0YSBmb3JtYXQnKTtcbiAgICAgIH1cblxuICAgICAgLy8gSVYgXHVBRTM4XHVDNzc0IFx1QUM4MFx1Qzk5RCAobWFsZm9ybWVkIGRhdGEgXHVBQ0Y1XHVBQ0E5IFx1QkMyOVx1QzlDMClcbiAgICAgIGlmIChlbmNyeXB0ZWREYXRhLml2Lmxlbmd0aCAhPT0gRW5jcnlwdGlvbkVuZ2luZS4jSVZfTEVOR1RIKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBlbmNyeXB0ZWQgZGF0YSBmb3JtYXQnKTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2lwaGVydGV4dCBcdUQwNkNcdUFFMzAgXHVDODFDXHVENTVDIChEb1MgdmlhIG1lbW9yeSBleGhhdXN0aW9uIFx1QkMyOVx1QzlDMClcbiAgICAgIGlmIChlbmNyeXB0ZWREYXRhLmNpcGhlcnRleHQubGVuZ3RoID4gRW5jcnlwdGlvbkVuZ2luZS4jTUFYX0NJUEhFUlRFWFRfU0laRSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgZW5jcnlwdGVkIGRhdGEgZm9ybWF0Jyk7XG4gICAgICB9XG5cbiAgICAgIC8vIDIuIG51bWJlcltdIFx1MjE5MiBVaW50OEFycmF5IFx1QkNDMFx1RDY1OFxuICAgICAgY29uc3QgaXYgPSBuZXcgVWludDhBcnJheShlbmNyeXB0ZWREYXRhLml2KTtcbiAgICAgIGNvbnN0IGNpcGhlcnRleHQgPSBuZXcgVWludDhBcnJheShlbmNyeXB0ZWREYXRhLmNpcGhlcnRleHQpO1xuXG4gICAgICAvLyAzLiBBRVMtR0NNIFx1QkNGNVx1RDYzOFx1RDY1NFxuICAgICAgY29uc3QgcGxhaW50ZXh0QnVmZmVyID0gYXdhaXQgY3J5cHRvLnN1YnRsZS5kZWNyeXB0KFxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ0FFUy1HQ00nLFxuICAgICAgICAgIGl2OiBpdlxuICAgICAgICB9LFxuICAgICAgICB0aGlzLiNrZXksXG4gICAgICAgIGNpcGhlcnRleHRcbiAgICAgICk7XG5cbiAgICAgIC8vIDQuIFx1QkM4NFx1RDM3QyBcdTIxOTIgXHVCQjM4XHVDNzkwXHVDNUY0IFx1MjE5MiBKU09OIFx1RDMwQ1x1QzJGMVxuICAgICAgY29uc3QgcGxhaW50ZXh0ID0gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHBsYWludGV4dEJ1ZmZlcik7XG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShwbGFpbnRleHQpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAvLyBcdUQwQzBcdUM3NzRcdUJDMEQgXHVBQ0Y1XHVBQ0E5IFx1QkMyOVx1QzlDMDogXHVDNUQwXHVCN0VDIFx1RDBDMFx1Qzc4NSBcdUIxNzhcdUNEOUMgXHVBRTA4XHVDOUMwXG4gICAgICAvLyAoQUVTLUdDTSBcdUM3NzhcdUM5OUQgXHVDMkU0XHVEMzI4LCBKU09OIFx1RDMwQ1x1QzJGMSBcdUM1RDBcdUI3RUMgXHVCQUE4XHVCNDUwIFx1QjNEOVx1Qzc3Q1x1RDU1QyBcdUM1RDBcdUI3RUMpXG4gICAgICBjb25zb2xlLmVycm9yKCdbRW5jcnlwdGlvbl0gRGVjcnlwdGlvbiBmYWlsZWQnKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcignRGVjcnlwdGlvbiBmYWlsZWQnKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogXHVEMEE0IFx1RDMwQ1x1QzBERCBcdUM1RUNcdUJEODAgXHVENjU1XHVDNzc4XG4gICAqXG4gICAqIEByZXR1cm5zIHtib29sZWFufVxuICAgKi9cbiAgaGFzS2V5KCkge1xuICAgIHJldHVybiB0aGlzLiNrZXkgIT09IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogXHVEMEE0IFx1RDNEMFx1QUUzMCAoXHVCODVDXHVBREY4XHVDNTQ0XHVDNkMzIFx1QzJEQyBcdUQ2MzhcdUNEOUMpXG4gICAqXG4gICAqIFx1MjZBMFx1RkUwRiBcdUM4RkNcdUM3NTg6IFx1RDBBNFx1QjI5NCBleHRyYWN0YWJsZTogZmFsc2VcdUM3NzRcdUJCQzBcdUI4NUMgXHVDN0FDXHVEMzBDXHVDMEREIFx1RDU0NFx1QzY5NFxuICAgKi9cbiAgY2xlYXJLZXkoKSB7XG4gICAgdGhpcy4ja2V5ID0gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIFx1QzJGMVx1QUUwMFx1RDFBNCBcdUM3NzhcdUMyQTRcdUQxMzRcdUMyQTQgKFx1QzEyMFx1RDBERFx1QzgwMSBcdUMwQUNcdUM2QTkpXG4gKlxuICogXHVDMEFDXHVDNkE5IFx1QzYwODpcbiAqIGltcG9ydCB7IGVuY3J5cHRpb25FbmdpbmUgfSBmcm9tICcuL2xpYi9lbmNyeXB0aW9uLmpzJztcbiAqIGF3YWl0IGVuY3J5cHRpb25FbmdpbmUuZGVyaXZlS2V5KHVzZXJJZCwgc2VydmVyU2FsdCk7XG4gKiBjb25zdCBlbmNyeXB0ZWQgPSBhd2FpdCBlbmNyeXB0aW9uRW5naW5lLmVuY3J5cHQoZGF0YSk7XG4gKi9cbmV4cG9ydCBjb25zdCBlbmNyeXB0aW9uRW5naW5lID0gbmV3IEVuY3J5cHRpb25FbmdpbmUoKTtcbiIsICIvKipcbiAqIENvbmZpZ3VyYXRpb24gZm9yIERhaWx5IFNjcnVtIEV4dGVuc2lvblxuICpcbiAqIFN1cGFiYXNlIFx1RDY1OFx1QUNCRCBcdUJDQzBcdUMyMTggXHVBRDAwXHVCOUFDXG4gKiBcdUQ1MDRcdUI4NUNcdUIzNTVcdUMxNTggXHVCQzMwXHVEM0VDIFx1QzJEQyBcdUQ2NThcdUFDQkQgXHVCQ0MwXHVDMjE4XHVCODVDIFx1QzhGQ1x1Qzc4NVx1RDU1OFx1QUM3MFx1QjA5OCBcdUJDQzRcdUIzQzQgXHVDMTI0XHVDODE1IFx1RDMwQ1x1Qzc3Q1x1Qjg1QyBcdUFEMDBcdUI5QUNcbiAqXG4gKiBAc2VlIGRvY3MvcmVzZWFyY2gubWQgNC4xXHVDODA4XG4gKi9cblxuLyoqXG4gKiBTdXBhYmFzZSBcdUQ1MDRcdUI4NUNcdUM4MURcdUQyQjggVVJMXG4gKiBAY29uc3RhbnQge3N0cmluZ31cbiAqL1xuZXhwb3J0IGNvbnN0IFNVUEFCQVNFX1VSTCA9IGltcG9ydC5tZXRhLmVudj8uVklURV9TVVBBQkFTRV9VUkwgfHwgJ2h0dHBzOi8vem9xdHZyY3JxbmFhdGtkd21haWwuc3VwYWJhc2UuY28nO1xuXG5cbi8qKlxuICogU3VwYWJhc2UgQW5vbnltb3VzIEtleSAoXHVBQ0Y1XHVBQzFDIFx1QUMwMFx1QjJBNSlcbiAqIEBjb25zdGFudCB7c3RyaW5nfVxuICovXG5leHBvcnQgY29uc3QgU1VQQUJBU0VfQU5PTl9LRVkgPSBpbXBvcnQubWV0YS5lbnY/LlZJVEVfU1VQQUJBU0VfQU5PTl9LRVkgfHwgJ2V5SmhiR2NpT2lKSVV6STFOaUlzSW5SNWNDSTZJa3BYVkNKOS5leUpwYzNNaU9pSnpkWEJoWW1GelpTSXNJbkpsWmlJNklucHZjWFIyY21OeWNXNWhZWFJyWkhkdFlXbHNJaXdpY205c1pTSTZJbUZ1YjI0aUxDSnBZWFFpT2pFM05qazBNRGc1T0Rrc0ltVjRjQ0k2TWpBNE5EazRORGs0T1gwLmoyTk5DNTdqbVdQQU5qR3VmZExaYjBGUHo4bGhPZGFxOVYzMkZ2MHpacEUnO1xuXG4vLyBEZWJ1ZzogTG9nIGNvbmZpZ3VyYXRpb24gdmFsdWVzXG5cbi8qKlxuICogR29vZ2xlIE9BdXRoIFx1RDA3NFx1Qjc3Q1x1Qzc3NFx1QzVCOFx1RDJCOCBJRCAoQ2hyb21lIEV4dGVuc2lvbiBcdUQwQzBcdUM3ODUpXG4gKiBHb29nbGUgV29ya3NwYWNlIEFQSVx1QzZBOSAtIGNocm9tZS5pZGVudGl0eS5nZXRBdXRoVG9rZW4oKVx1QzVEMFx1QzExQyBcdUMwQUNcdUM2QTlcbiAqIEBjb25zdGFudCB7c3RyaW5nfVxuICovXG5leHBvcnQgY29uc3QgR09PR0xFX0NMSUVOVF9JRCA9IGltcG9ydC5tZXRhLmVudj8uVklURV9HT09HTEVfQ0xJRU5UX0lEIHx8ICcxNjcyOTA5MDIxMDQtaW1ocnF0bjMxb3JxNnRubzU1Y2VvZG84ZzRiNDU0NzguYXBwcy5nb29nbGV1c2VyY29udGVudC5jb20nO1xuXG4vKipcbiAqIEdvb2dsZSBPQXV0aCBcdUQwNzRcdUI3N0NcdUM3NzRcdUM1QjhcdUQyQjggSUQgKFx1QzZGOSBcdUM1NjBcdUQ1MENcdUI5QUNcdUNGMDBcdUM3NzRcdUMxNTggXHVEMEMwXHVDNzg1KVxuICogU3VwYWJhc2UgXHVDNzc4XHVDOTlEXHVDNkE5IC0gY2hyb21lLmlkZW50aXR5LmxhdW5jaFdlYkF1dGhGbG93KClcdUM1RDBcdUMxMUMgXHVDMEFDXHVDNkE5XG4gKiBAY29uc3RhbnQge3N0cmluZ31cbiAqL1xuZXhwb3J0IGNvbnN0IEdPT0dMRV9BVVRIX0NMSUVOVF9JRCA9IGltcG9ydC5tZXRhLmVudj8uVklURV9HT09HTEVfQVVUSF9DTElFTlRfSUQgfHwgJzE2NzI5MDkwMjEwNC1tMzF2MWxpbW85cWplYzlzN2Y5cjlrOWx0dTRuMjViMy5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbSc7XG5cbi8qKlxuICogR29vZ2xlIE9BdXRoIFJlZGlyZWN0IFVSSVxuICogY2hyb21lLmlkZW50aXR5LmxhdW5jaFdlYkF1dGhGbG93XHVDNUQwXHVDMTFDIFx1QzBBQ1x1QzZBOVxuICogQHJldHVybnMge3N0cmluZ30gUmVkaXJlY3QgVVJJXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRHb29nbGVSZWRpcmVjdFVSSSgpIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYGh0dHBzOi8vJHtjaHJvbWUucnVudGltZS5pZH0uY2hyb21pdW1hcHAub3JnL2A7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignW0NvbmZpZ10gRmFpbGVkIHRvIGdldCBjaHJvbWUucnVudGltZS5pZDonLCBlcnJvcik7XG4gICAgcmV0dXJuICdodHRwczovL3Vua25vd24uY2hyb21pdW1hcHAub3JnLyc7XG4gIH1cbn1cbiIsICIvKipcbiAqIEdvb2dsZSBXb3Jrc3BhY2UgQVBJIENsaWVudFxuICpcbiAqIEdvb2dsZSBEb2NzLCBTaGVldHMsIFNsaWRlcywgRHJpdmUgQVBJIFx1QzgxMVx1QURGQ1x1Qzc0NCBcdUM3MDRcdUQ1NUMgT0F1dGgyIFx1RDA3NFx1Qjc3Q1x1Qzc3NFx1QzVCOFx1RDJCOFxuICpcbiAqIE9BdXRoIEZsb3c6XG4gKiAxLiBjaHJvbWUuaWRlbnRpdHkubGF1bmNoV2ViQXV0aEZsb3dcdUI4NUMgXHVDNzc4XHVDOTlEXG4gKiAyLiBhY2Nlc3NfdG9rZW4gXHVENjhEXHVCNEREIChHb29nbGUgV29ya3NwYWNlIEFQSVx1QzZBOSlcbiAqIDMuIFJFU1QgQVBJIFx1RDYzOFx1Q0Q5Q1xuICpcbiAqIEBzZWUgaHR0cHM6Ly9kZXZlbG9wZXJzLmdvb2dsZS5jb20vZG9jcy9hcGkvcmVmZXJlbmNlL3Jlc3RcbiAqIEBzZWUgaHR0cHM6Ly9kZXZlbG9wZXJzLmdvb2dsZS5jb20vc2hlZXRzL2FwaS9yZWZlcmVuY2UvcmVzdFxuICogQHNlZSBodHRwczovL2RldmVsb3BlcnMuZ29vZ2xlLmNvbS9zbGlkZXMvYXBpL3JlZmVyZW5jZS9yZXN0XG4gKi9cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gT0F1dGgyIFx1Qzc3OFx1Qzk5RCAoY2hyb21lLmlkZW50aXR5LmdldEF1dGhUb2tlbiBcdUJDMjlcdUMyREQpXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogR29vZ2xlIFdvcmtzcGFjZSBBUEkgXHVDODExXHVBREZDXHVDNzQ0IFx1QzcwNFx1RDU1QyBPQXV0aDIgXHVDNzc4XHVDOTlEXG4gKiBjaHJvbWUuaWRlbnRpdHkuZ2V0QXV0aFRva2VuKClcdUM3NDQgXHVDMEFDXHVDNkE5XHVENTU4XHVDNUVDIENocm9tZVx1Qzc3NCBcdUQxQTBcdUQwNzAgXHVBRDAwXHVCOUFDXG4gKlxuICogQHBhcmFtIHtib29sZWFufSBpbnRlcmFjdGl2ZSAtIFx1QzBBQ1x1QzZBOVx1Qzc5MCBcdUMwQzFcdUQ2MzhcdUM3OTFcdUM2QTkgXHVENUM4XHVDNkE5IFx1QzVFQ1x1QkQ4MFxuICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nPn0gQWNjZXNzIHRva2VuXG4gKiBAdGhyb3dzIHtFcnJvcn0gXHVDNzc4XHVDOTlEIFx1QzJFNFx1RDMyOCBcdUMyRENcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGF1dGhvcml6ZUdvb2dsZVdvcmtzcGFjZShpbnRlcmFjdGl2ZSA9IHRydWUpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblxuICAgIGNocm9tZS5pZGVudGl0eS5nZXRBdXRoVG9rZW4oeyBpbnRlcmFjdGl2ZSB9LCAodG9rZW4pID0+IHtcbiAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcignW0dvb2dsZSBBUEldIE9BdXRoIGZsb3cgZXJyb3I6JywgY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yKTtcbiAgICAgICAgcmV0dXJuIHJlamVjdChuZXcgRXJyb3IoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yLm1lc3NhZ2UpKTtcbiAgICAgIH1cblxuICAgICAgaWYgKCF0b2tlbikge1xuICAgICAgICByZXR1cm4gcmVqZWN0KG5ldyBFcnJvcignTm8gdG9rZW4gcmVjZWl2ZWQnKSk7XG4gICAgICB9XG5cbiAgICAgIHJlc29sdmUodG9rZW4pO1xuICAgIH0pO1xuICB9KTtcbn1cblxuLyoqXG4gKiBcdUM4MDBcdUM3QTVcdUI0MUMgYWNjZXNzIHRva2VuIFx1QUMwMFx1QzgzOFx1QzYyNFx1QUUzMCAoXHVDRTkwXHVDMkRDXHVCNDFDIFx1RDFBMFx1RDA3MCBcdUJDMThcdUQ2NTgpXG4gKiBDaHJvbWVcdUM3NzQgXHVEMUEwXHVEMDcwIFx1QjlDQ1x1QjhDQ1x1Qjk3QyBcdUM3OTBcdUIzRDkgXHVBRDAwXHVCOUFDXG4gKlxuICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nfG51bGw+fSBBY2Nlc3MgdG9rZW4gb3IgbnVsbFxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0QWNjZXNzVG9rZW4oKSB7XG4gIHRyeSB7XG4gICAgLy8gaW50ZXJhY3RpdmU6IGZhbHNlXHVCODVDIFx1Q0U5MFx1QzJEQ1x1QjQxQyBcdUQxQTBcdUQwNzBcdUI5Q0MgXHVENjU1XHVDNzc4XG4gICAgY29uc3QgdG9rZW4gPSBhd2FpdCBhdXRob3JpemVHb29nbGVXb3Jrc3BhY2UoZmFsc2UpO1xuICAgIHJldHVybiB0b2tlbjtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIFx1RDFBMFx1RDA3MCBcdUM3MjBcdUQ2QThcdUMxMzEgXHVENjU1XHVDNzc4IFx1QkMwRiBcdUM3OTBcdUIzRDkgXHVDN0FDXHVDNzc4XHVDOTlEXG4gKlxuICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nPn0gVmFsaWQgYWNjZXNzIHRva2VuXG4gKiBAdGhyb3dzIHtFcnJvcn0gXHVDN0FDXHVDNzc4XHVDOTlEIFx1QzJFNFx1RDMyOCBcdUMyRENcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZW5zdXJlVmFsaWRUb2tlbigpIHtcbiAgLy8gaW50ZXJhY3RpdmU6IHRydWVcdUI4NUMgXHVENTQ0XHVDNjk0XHVDMkRDIFx1QzBBQ1x1QzZBOVx1Qzc5MFx1QzVEMFx1QUM4QyBcdUM3NzhcdUM5OUQgXHVDNjk0XHVDQ0FEXG4gIHJldHVybiBhd2FpdCBhdXRob3JpemVHb29nbGVXb3Jrc3BhY2UodHJ1ZSk7XG59XG5cbi8qKlxuICogXHVDRTkwXHVDMkRDXHVCNDFDIFx1RDFBMFx1RDA3MCBcdUM4MUNcdUFDNzAgKFx1Qjg1Q1x1QURGOFx1QzU0NFx1QzZDMyBcdUI2MTBcdUIyOTQgXHVEMUEwXHVEMDcwIFx1QUMzMVx1QzJFMCBcdUQ1NDRcdUM2OTQgXHVDMkRDKVxuICpcbiAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmV2b2tlVG9rZW4oKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY2hyb21lLmlkZW50aXR5LmdldEF1dGhUb2tlbih7IGludGVyYWN0aXZlOiBmYWxzZSB9LCAodG9rZW4pID0+IHtcbiAgICAgIGlmICh0b2tlbikge1xuICAgICAgICBjaHJvbWUuaWRlbnRpdHkucmVtb3ZlQ2FjaGVkQXV0aFRva2VuKHsgdG9rZW4gfSwgKCkgPT4ge1xuICAgICAgICAgIHJlc29sdmUoKTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBHb29nbGUgRG9jcyBBUElcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBHb29nbGUgRG9jcyBcdUJCMzhcdUMxMUMgXHVCMEI0XHVDNkE5IFx1QUMwMFx1QzgzOFx1QzYyNFx1QUUzMFxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSBkb2N1bWVudElkIC0gXHVCQjM4XHVDMTFDIElEXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxPYmplY3Q+fSBEb2N1bWVudCBvYmplY3RcbiAqIEB0aHJvd3Mge0Vycm9yfSBBUEkgXHVENjM4XHVDRDlDIFx1QzJFNFx1RDMyOCBcdUMyRENcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldERvY3VtZW50KGRvY3VtZW50SWQpIHtcbiAgY29uc3QgdG9rZW4gPSBhd2FpdCBlbnN1cmVWYWxpZFRva2VuKCk7XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcbiAgICBgaHR0cHM6Ly9kb2NzLmdvb2dsZWFwaXMuY29tL3YxL2RvY3VtZW50cy8ke2RvY3VtZW50SWR9YCxcbiAgICB7XG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3Rva2VufWBcbiAgICAgIH1cbiAgICB9XG4gICk7XG5cbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIGNvbnN0IGVycm9yID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgIHRocm93IG5ldyBFcnJvcihgRG9jcyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAtICR7ZXJyb3J9YCk7XG4gIH1cblxuICByZXR1cm4gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xufVxuXG4vKipcbiAqIEdvb2dsZSBEb2NzIFx1QkIzOFx1QzExQ1x1QzVEMFx1QzExQyBcdUQxNERcdUMyQTRcdUQyQjggXHVDRDk0XHVDRDlDXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IGRvY3VtZW50SWQgLSBcdUJCMzhcdUMxMUMgSURcbiAqIEByZXR1cm5zIHtQcm9taXNlPHN0cmluZz59IFx1QkIzOFx1QzExQyBcdUQxNERcdUMyQTRcdUQyQjhcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldERvY3VtZW50VGV4dChkb2N1bWVudElkKSB7XG4gIGNvbnN0IGRvYyA9IGF3YWl0IGdldERvY3VtZW50KGRvY3VtZW50SWQpO1xuXG4gIGxldCB0ZXh0ID0gJyc7XG5cbiAgLy8gRG9jdW1lbnQgYm9keSBcdUMyMUNcdUQ2OENcdUQ1NThcdUJBNzAgXHVEMTREXHVDMkE0XHVEMkI4IFx1Q0Q5NFx1Q0Q5Q1xuICBpZiAoZG9jLmJvZHkgJiYgZG9jLmJvZHkuY29udGVudCkge1xuICAgIGZvciAoY29uc3QgZWxlbWVudCBvZiBkb2MuYm9keS5jb250ZW50KSB7XG4gICAgICBpZiAoZWxlbWVudC5wYXJhZ3JhcGgpIHtcbiAgICAgICAgZm9yIChjb25zdCBlbCBvZiBlbGVtZW50LnBhcmFncmFwaC5lbGVtZW50cyB8fCBbXSkge1xuICAgICAgICAgIGlmIChlbC50ZXh0UnVuICYmIGVsLnRleHRSdW4uY29udGVudCkge1xuICAgICAgICAgICAgdGV4dCArPSBlbC50ZXh0UnVuLmNvbnRlbnQ7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHRleHQ7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEdvb2dsZSBTaGVldHMgQVBJXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogR29vZ2xlIFNoZWV0cyBcdUMyQTRcdUQ1MDRcdUI4MDhcdUI0RENcdUMyRENcdUQyQjggXHVCQTU0XHVEMEMwXHVCMzcwXHVDNzc0XHVEMTMwIFx1QUMwMFx1QzgzOFx1QzYyNFx1QUUzMFxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSBzcHJlYWRzaGVldElkIC0gXHVDMkE0XHVENTA0XHVCODA4XHVCNERDXHVDMkRDXHVEMkI4IElEXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxPYmplY3Q+fSBTcHJlYWRzaGVldCBvYmplY3RcbiAqIEB0aHJvd3Mge0Vycm9yfSBBUEkgXHVENjM4XHVDRDlDIFx1QzJFNFx1RDMyOCBcdUMyRENcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFNwcmVhZHNoZWV0KHNwcmVhZHNoZWV0SWQpIHtcbiAgY29uc3QgdG9rZW4gPSBhd2FpdCBlbnN1cmVWYWxpZFRva2VuKCk7XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcbiAgICBgaHR0cHM6Ly9zaGVldHMuZ29vZ2xlYXBpcy5jb20vdjQvc3ByZWFkc2hlZXRzLyR7c3ByZWFkc2hlZXRJZH1gLFxuICAgIHtcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7dG9rZW59YFxuICAgICAgfVxuICAgIH1cbiAgKTtcblxuICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgY29uc3QgZXJyb3IgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBTaGVldHMgQVBJIGVycm9yOiAke3Jlc3BvbnNlLnN0YXR1c30gLSAke2Vycm9yfWApO1xuICB9XG5cbiAgcmV0dXJuIGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcbn1cblxuLyoqXG4gKiBHb29nbGUgU2hlZXRzIFx1RDJCOVx1QzgxNSBcdUJDOTRcdUM3MDQgXHVCMzcwXHVDNzc0XHVEMTMwIFx1QUMwMFx1QzgzOFx1QzYyNFx1QUUzMFxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSBzcHJlYWRzaGVldElkIC0gXHVDMkE0XHVENTA0XHVCODA4XHVCNERDXHVDMkRDXHVEMkI4IElEXG4gKiBAcGFyYW0ge3N0cmluZ30gcmFuZ2UgLSBcdUJDOTRcdUM3MDQgKFx1QzYwODogJ1NoZWV0MSFBMTpEMTAnKVxuICogQHJldHVybnMge1Byb21pc2U8QXJyYXk8QXJyYXk8c3RyaW5nPj4+fSAyRCBcdUJDMzBcdUM1RjQgXHVCMzcwXHVDNzc0XHVEMTMwXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRTaGVldFZhbHVlcyhzcHJlYWRzaGVldElkLCByYW5nZSkge1xuICBjb25zdCB0b2tlbiA9IGF3YWl0IGVuc3VyZVZhbGlkVG9rZW4oKTtcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFxuICAgIGBodHRwczovL3NoZWV0cy5nb29nbGVhcGlzLmNvbS92NC9zcHJlYWRzaGVldHMvJHtzcHJlYWRzaGVldElkfS92YWx1ZXMvJHtlbmNvZGVVUklDb21wb25lbnQocmFuZ2UpfWAsXG4gICAge1xuICAgICAgaGVhZGVyczoge1xuICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHt0b2tlbn1gXG4gICAgICB9XG4gICAgfVxuICApO1xuXG4gIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICBjb25zdCBlcnJvciA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFNoZWV0cyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAtICR7ZXJyb3J9YCk7XG4gIH1cblxuICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xuICByZXR1cm4gZGF0YS52YWx1ZXMgfHwgW107XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEdvb2dsZSBTbGlkZXMgQVBJXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogR29vZ2xlIFNsaWRlcyBcdUQ1MDRcdUI4MDhcdUM4MjBcdUQxNENcdUM3NzRcdUMxNTggXHVBQzAwXHVDODM4XHVDNjI0XHVBRTMwXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IHByZXNlbnRhdGlvbklkIC0gXHVENTA0XHVCODA4XHVDODIwXHVEMTRDXHVDNzc0XHVDMTU4IElEXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxPYmplY3Q+fSBQcmVzZW50YXRpb24gb2JqZWN0XG4gKiBAdGhyb3dzIHtFcnJvcn0gQVBJIFx1RDYzOFx1Q0Q5QyBcdUMyRTRcdUQzMjggXHVDMkRDXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRQcmVzZW50YXRpb24ocHJlc2VudGF0aW9uSWQpIHtcbiAgY29uc3QgdG9rZW4gPSBhd2FpdCBlbnN1cmVWYWxpZFRva2VuKCk7XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcbiAgICBgaHR0cHM6Ly9zbGlkZXMuZ29vZ2xlYXBpcy5jb20vdjEvcHJlc2VudGF0aW9ucy8ke3ByZXNlbnRhdGlvbklkfWAsXG4gICAge1xuICAgICAgaGVhZGVyczoge1xuICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHt0b2tlbn1gXG4gICAgICB9XG4gICAgfVxuICApO1xuXG4gIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICBjb25zdCBlcnJvciA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFNsaWRlcyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAtICR7ZXJyb3J9YCk7XG4gIH1cblxuICByZXR1cm4gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xufVxuXG4vKipcbiAqIEdvb2dsZSBTbGlkZXMgXHVENTA0XHVCODA4XHVDODIwXHVEMTRDXHVDNzc0XHVDMTU4XHVDNUQwXHVDMTFDIFx1RDE0RFx1QzJBNFx1RDJCOCBcdUNEOTRcdUNEOUNcbiAqXG4gKiBAcGFyYW0ge3N0cmluZ30gcHJlc2VudGF0aW9uSWQgLSBcdUQ1MDRcdUI4MDhcdUM4MjBcdUQxNENcdUM3NzRcdUMxNTggSURcbiAqIEByZXR1cm5zIHtQcm9taXNlPHtzbGlkZXM6IEFycmF5PHtzbGlkZU51bWJlcjogbnVtYmVyLCB0ZXh0OiBzdHJpbmd9PiwgZnVsbFRleHQ6IHN0cmluZ30+fVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0UHJlc2VudGF0aW9uVGV4dChwcmVzZW50YXRpb25JZCkge1xuICBjb25zdCBwcmVzZW50YXRpb24gPSBhd2FpdCBnZXRQcmVzZW50YXRpb24ocHJlc2VudGF0aW9uSWQpO1xuXG4gIGNvbnN0IHNsaWRlcyA9IFtdO1xuICBsZXQgZnVsbFRleHQgPSAnJztcblxuICBpZiAocHJlc2VudGF0aW9uLnNsaWRlcykge1xuICAgIHByZXNlbnRhdGlvbi5zbGlkZXMuZm9yRWFjaCgoc2xpZGUsIGluZGV4KSA9PiB7XG4gICAgICBsZXQgc2xpZGVUZXh0ID0gJyc7XG5cbiAgICAgIC8vIFx1QzJBQ1x1Qjc3Q1x1Qzc3NFx1QjREQ1x1Qzc1OCBcdUJBQThcdUI0RTAgXHVDNjk0XHVDMThDIFx1QzIxQ1x1RDY4Q1xuICAgICAgaWYgKHNsaWRlLnBhZ2VFbGVtZW50cykge1xuICAgICAgICBmb3IgKGNvbnN0IGVsZW1lbnQgb2Ygc2xpZGUucGFnZUVsZW1lbnRzKSB7XG4gICAgICAgICAgLy8gU2hhcGUgXHVDNjk0XHVDMThDXHVDNzU4IFx1RDE0RFx1QzJBNFx1RDJCOCBcdUNEOTRcdUNEOUNcbiAgICAgICAgICBpZiAoZWxlbWVudC5zaGFwZSAmJiBlbGVtZW50LnNoYXBlLnRleHQpIHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdGV4dEVsZW1lbnQgb2YgZWxlbWVudC5zaGFwZS50ZXh0LnRleHRFbGVtZW50cyB8fCBbXSkge1xuICAgICAgICAgICAgICBpZiAodGV4dEVsZW1lbnQudGV4dFJ1biAmJiB0ZXh0RWxlbWVudC50ZXh0UnVuLmNvbnRlbnQpIHtcbiAgICAgICAgICAgICAgICBzbGlkZVRleHQgKz0gdGV4dEVsZW1lbnQudGV4dFJ1bi5jb250ZW50O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChzbGlkZVRleHQudHJpbSgpKSB7XG4gICAgICAgIHNsaWRlcy5wdXNoKHtcbiAgICAgICAgICBzbGlkZU51bWJlcjogaW5kZXggKyAxLFxuICAgICAgICAgIHRleHQ6IHNsaWRlVGV4dC50cmltKClcbiAgICAgICAgfSk7XG4gICAgICAgIGZ1bGxUZXh0ICs9IHNsaWRlVGV4dCArICdcXG4nO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHsgc2xpZGVzLCBmdWxsVGV4dDogZnVsbFRleHQudHJpbSgpIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEdvb2dsZSBEcml2ZSBBUElcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBHb29nbGUgRHJpdmUgXHVEMzBDXHVDNzdDIFx1QkE1NFx1RDBDMFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUFDMDBcdUM4MzhcdUM2MjRcdUFFMzBcbiAqXG4gKiBAcGFyYW0ge3N0cmluZ30gZmlsZUlkIC0gXHVEMzBDXHVDNzdDIElEXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxPYmplY3Q+fSBGaWxlIG1ldGFkYXRhXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRGaWxlTWV0YWRhdGEoZmlsZUlkKSB7XG4gIGNvbnN0IHRva2VuID0gYXdhaXQgZW5zdXJlVmFsaWRUb2tlbigpO1xuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXG4gICAgYGh0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL2RyaXZlL3YzL2ZpbGVzLyR7ZmlsZUlkfT9maWVsZHM9aWQsbmFtZSxtaW1lVHlwZSxtb2RpZmllZFRpbWUsb3duZXJzYCxcbiAgICB7XG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3Rva2VufWBcbiAgICAgIH1cbiAgICB9XG4gICk7XG5cbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIGNvbnN0IGVycm9yID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgIHRocm93IG5ldyBFcnJvcihgRHJpdmUgQVBJIGVycm9yOiAke3Jlc3BvbnNlLnN0YXR1c30gLSAke2Vycm9yfWApO1xuICB9XG5cbiAgcmV0dXJuIGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcbn1cblxuIiwgIi8qKlxuICogQmFja2dyb3VuZCBTZXJ2aWNlIFdvcmtlciAoTWFuaWZlc3QgVjMpXG4gKlxuICogXHVDNUVEXHVENTYwOlxuICogMS4gQ29udGVudCBzY3JpcHRcdUI4NUNcdUJEODBcdUQxMzAgXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzIxOFx1QzJFMCAoREFUQV9DQVBUVVJFRCwgVEFCX1RSQU5TSVRJT04pXG4gKiAyLiBUYWIgdHJhbnNpdGlvbiBcdUI5RTRcdUNFNkQgKGZyb20vdG8gXHVDMzBEIFx1QzBERFx1QzEzMSlcbiAqIDMuIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUJDODRcdUQzN0NcdUI5QzEgXHVCQzBGIDVcdUJEODQgXHVBQzA0XHVBQ0E5IFx1QkMzMFx1Q0U1OCBcdUM4MDRcdUMxQTFcbiAqIDQuIFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMwQzFcdUQwREMgXHVBRDAwXHVCOUFDXG4gKlxuICogQHNlZSByZXNlYXJjaC5tZCA0LjNcdUM4MDhcbiAqL1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBJbXBvcnRcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW1wb3J0IHsgdGVtcEJ1ZmZlciB9IGZyb20gJy4vbGliL3RlbXAtYnVmZmVyLmpzJztcbmltcG9ydCB7IGVuY3J5cHRpb25FbmdpbmUgfSBmcm9tICcuL2xpYi9lbmNyeXB0aW9uLmpzJztcbmltcG9ydCB7IFNVUEFCQVNFX1VSTCwgU1VQQUJBU0VfQU5PTl9LRVkgfSBmcm9tICcuL2xpYi9jb25maWcuanMnO1xuaW1wb3J0IHtcbiAgYXV0aG9yaXplR29vZ2xlV29ya3NwYWNlLFxuICBnZXRBY2Nlc3NUb2tlbixcbiAgZ2V0RG9jdW1lbnRUZXh0LFxuICBnZXRTcHJlYWRzaGVldCxcbiAgZ2V0UHJlc2VudGF0aW9uVGV4dFxufSBmcm9tICcuL2xpYi9nb29nbGUtYXBpLWNsaWVudC5qcyc7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1QzBDMVx1QzIxOFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5jb25zdCBCQVRDSF9TRU5EX0lOVEVSVkFMID0gMTsgLy8gMVx1QkQ4NCAoY2hyb21lLmFsYXJtcyBcdUNENUNcdUMxOEMgXHVDOEZDXHVBRTMwKVxuY29uc3QgTUFYX1JFVFJZX0FUVEVNUFRTID0gMzsgLy8gXHVDN0FDXHVDMkRDXHVCM0M0IFx1RDY5Rlx1QzIxOFxuY29uc3QgSU5JVElBTF9SRVRSWV9ERUxBWSA9IDEwMDA7IC8vIFx1Q0QwOFx1QUUzMCBcdUM3QUNcdUMyRENcdUIzQzQgXHVDOUMwXHVDNUYwIChtcylcblxuY29uc3QgU1RPUkFHRV9LRVlTID0ge1xuICBDT05TRU5UX0dJVkVOOiAnY29uc2VudEdpdmVuJyxcbiAgSVNfTE9HR0VEX0lOOiAnaXNMb2dnZWRJbicsXG4gIFVTRVJfSUQ6ICd1c2VySWQnLFxuICBTRU5EX1FVRVVFOiAnc2VuZFF1ZXVlJyxcbiAgTEFTVF9UUkFOU0lUSU9OOiAnbGFzdFRyYW5zaXRpb24nLFxuICBBQ1RJVkVfVEFCX0lORk86ICdhY3RpdmVUYWJJbmZvJyxcbiAgU0VSVkVSX1NBTFQ6ICdzZXJ2ZXJTYWx0JyxcbiAgQVVUSF9UT0tFTjogJ2F1dGhUb2tlbicsXG4gIFJFRlJFU0hfVE9LRU46ICdyZWZyZXNoVG9rZW4nXG59O1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUb2tlbiBSZWZyZXNoIExvZ2ljIChTZXJ2aWNlIFdvcmtlciBcdUM3QUNcdUMyRENcdUM3OTEgXHVCMzAwXHVDNzUxKVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFN1cGFiYXNlIHJlZnJlc2ggdG9rZW5cdUM3NDQgXHVDMEFDXHVDNkE5XHVENTc0XHVDMTFDIFx1QzBDOFx1Qjg1Q1x1QzZCNCBhY2Nlc3MgdG9rZW4gXHVENjhEXHVCNEREXG4gKiBTZXJ2aWNlIFdvcmtlclx1QUMwMCBcdUJFNDRcdUQ2NUNcdUMxMzFcdUQ2NTRcdUI0MThcdUM1QzhcdUIyRTRcdUFDMDAgXHVDN0FDXHVENjVDXHVDMTMxXHVENjU0XHVCNDIwIFx1QjU0QyBcdUQ1NDRcdUM2OTRcbiAqXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxzdHJpbmd8bnVsbD59IFx1QzBDOCBhY2Nlc3MgdG9rZW4gXHVCNjEwXHVCMjk0IG51bGwgKFx1QzJFNFx1RDMyOCBcdUMyREMpXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hBdXRoVG9rZW4oKSB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFsncmVmcmVzaFRva2VuJ10pO1xuXG4gICAgaWYgKCFzdG9yZWQucmVmcmVzaFRva2VuKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIFx1Mjc0QyBObyByZWZyZXNoIHRva2VuIGluIHN0b3JhZ2UnKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGNvbnNvbGUubG9nKCdbRGFpbHkgU2NydW1dIFx1RDgzRFx1REQwNCBSZWZyZXNoaW5nIGF1dGggdG9rZW4uLi4nKTtcblxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYCR7U1VQQUJBU0VfVVJMfS9hdXRoL3YxL3Rva2VuP2dyYW50X3R5cGU9cmVmcmVzaF90b2tlbmAsIHtcbiAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgaGVhZGVyczoge1xuICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAnYXBpa2V5JzogU1VQQUJBU0VfQU5PTl9LRVlcbiAgICAgIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHJlZnJlc2hfdG9rZW46IHN0b3JlZC5yZWZyZXNoVG9rZW5cbiAgICAgIH0pXG4gICAgfSk7XG5cbiAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICBjb25zdCBlcnJvclRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIFx1Mjc0QyBUb2tlbiByZWZyZXNoIGZhaWxlZDonLCBlcnJvclRleHQpO1xuXG4gICAgICAvLyByZWZyZXNoIHRva2VuXHVCM0M0IFx1QjlDQ1x1QjhDQ1x1QjQxQyBcdUFDQkRcdUM2QjAgXHVCODVDXHVBREY4XHVDNTQ0XHVDNkMzIFx1Q0M5OFx1QjlBQ1xuICAgICAgaWYgKHJlc3BvbnNlLnN0YXR1cyA9PT0gNDAwIHx8IHJlc3BvbnNlLnN0YXR1cyA9PT0gNDAxKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKCdbRGFpbHkgU2NydW1dIFx1RDgzRFx1REQxMiBTZXNzaW9uIGV4cGlyZWQsIGNsZWFyaW5nIGF1dGggc3RhdGUuLi4nKTtcbiAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHtcbiAgICAgICAgICBpc0xvZ2dlZEluOiBmYWxzZSxcbiAgICAgICAgICBhdXRoVG9rZW46IG51bGwsXG4gICAgICAgICAgcmVmcmVzaFRva2VuOiBudWxsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcblxuICAgIC8vIFx1QzBDOCBcdUQxQTBcdUQwNzAgXHVDODAwXHVDN0E1XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHtcbiAgICAgIGF1dGhUb2tlbjogZGF0YS5hY2Nlc3NfdG9rZW4sXG4gICAgICByZWZyZXNoVG9rZW46IGRhdGEucmVmcmVzaF90b2tlbiwgLy8gcmVmcmVzaCB0b2tlblx1QjNDNCBcdUFDMzFcdUMyRTBcdUI0MjhcbiAgICAgIGlzTG9nZ2VkSW46IHRydWVcbiAgICB9KTtcblxuICAgIGNvbnNvbGUubG9nKCdbRGFpbHkgU2NydW1dIFx1MjcwNSBBdXRoIHRva2VuIHJlZnJlc2hlZCBzdWNjZXNzZnVsbHknKTtcbiAgICByZXR1cm4gZGF0YS5hY2Nlc3NfdG9rZW47XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBcdTI3NEMgVG9rZW4gcmVmcmVzaCBlcnJvcjonLCBlcnJvcik7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHVDRDA4XHVBRTMwXHVENjU0XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogU2VydmljZSBXb3JrZXIgXHVDMTI0XHVDRTU4IFx1QzJEQ1xuICovXG5jaHJvbWUucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcihhc3luYyAoZGV0YWlscykgPT4ge1xuICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBTZXJ2aWNlIFdvcmtlciBpbnN0YWxsZWQ6JywgZGV0YWlscy5yZWFzb24pO1xuXG4gIC8vIFx1QkMzMFx1Q0U1OCBcdUM4MDRcdUMxQTEgXHVDNTRDXHVCNzhDIFx1QzEyNFx1QzgxNSAoY2hyb21lLmFsYXJtcyBcdUNENUNcdUMxOEMgMVx1QkQ4NClcbiAgY2hyb21lLmFsYXJtcy5jcmVhdGUoJ2JhdGNoU2VuZCcsIHtcbiAgICBwZXJpb2RJbk1pbnV0ZXM6IEJBVENIX1NFTkRfSU5URVJWQUxcbiAgfSk7XG5cbiAgLy8gXHVDRDA4XHVBRTMwIFx1QzBDMVx1RDBEQyBcdUMxMjRcdUM4MTVcbiAgY29uc3Qgc3RvcmFnZSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXG4gICAgU1RPUkFHRV9LRVlTLkNPTlNFTlRfR0lWRU4sXG4gICAgU1RPUkFHRV9LRVlTLklTX0xPR0dFRF9JTlxuICBdKTtcblxuICAvLyBcdUNENUNcdUNEMDggXHVDMTI0XHVDRTU4IFx1QzJEQ1x1QzVEMFx1QjlDQyBcdUNEMDhcdUFFMzBcdUFDMTIgXHVDMTI0XHVDODE1XG4gIGlmIChzdG9yYWdlW1NUT1JBR0VfS0VZUy5JU19MT0dHRURfSU5dID09PSB1bmRlZmluZWQpIHtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoe1xuICAgICAgW1NUT1JBR0VfS0VZUy5JU19MT0dHRURfSU5dOiBmYWxzZSxcbiAgICAgIFtTVE9SQUdFX0tFWVMuU0VORF9RVUVVRV06IFtdXG4gICAgfSk7XG4gIH1cblxuICAvLyBjb25zZW50R2l2ZW5cdUM3NDAgXHVCQTg1XHVDMkRDXHVDODAxXHVDNzNDXHVCODVDIFx1Q0QwOFx1QUUzMFx1RDY1NFx1RDU1OFx1QzlDMCBcdUM1NEFcdUM3NEMgKHVuZGVmaW5lZCA9IFx1QzU0NFx1QzlDMSBcdUIzRDlcdUM3NTggXHVDNTQ4XHVENTY4KVxuXG4gIGNvbnNvbGUubG9nKCdbRGFpbHkgU2NydW1dIEFsYXJtcyBjb25maWd1cmVkOiBiYXRjaFNlbmQgZXZlcnknLCBCQVRDSF9TRU5EX0lOVEVSVkFMLCAnbWludXRlKHMpJyk7XG59KTtcblxuLyoqXG4gKiBTZXJ2aWNlIFdvcmtlciBcdUMyRENcdUM3OTEgXHVDMkRDXG4gKi9cbmNocm9tZS5ydW50aW1lLm9uU3RhcnR1cC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4gIGNvbnNvbGUubG9nKCdbRGFpbHkgU2NydW1dIFNlcnZpY2UgV29ya2VyIHN0YXJ0ZWQnKTtcbn0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBcdUJBNTRcdUMyRENcdUM5QzAgXHVCNzdDXHVDNkIwXHVEMzA1XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogQ29udGVudCBzY3JpcHRcdUI4NUNcdUJEODBcdUQxMzAgXHVCQTU0XHVDMkRDXHVDOUMwIFx1QzIxOFx1QzJFMFxuICovXG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1lc3NhZ2UsIHNlbmRlciwgc2VuZFJlc3BvbnNlKSA9PiB7XG4gIC8vIE1lc3NhZ2Ugcm91dGluZyAocHJvZHVjdGlvbiBtb2RlKVxuXG4gIGlmIChtZXNzYWdlLmFjdGlvbiA9PT0gJ0RBVEFfQ0FQVFVSRUQnKSB7XG4gICAgaGFuZGxlRGF0YUNhcHR1cmVkKG1lc3NhZ2UucGF5bG9hZCwgc2VuZGVyKTtcbiAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pO1xuICB9IGVsc2UgaWYgKG1lc3NhZ2UuYWN0aW9uID09PSAnVEFCX1RSQU5TSVRJT04nKSB7XG4gICAgaGFuZGxlVGFiVHJhbnNpdGlvbihtZXNzYWdlLnBheWxvYWQsIHNlbmRlcik7XG4gICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KTtcbiAgfSBlbHNlIGlmIChtZXNzYWdlLmFjdGlvbiA9PT0gJ0dPT0dMRV9BUElfUkVRVUVTVCcpIHtcbiAgICAvLyBHb29nbGUgQVBJIFx1QzY5NFx1Q0NBRCAoXHVCRTQ0XHVCM0Q5XHVBRTMwIFx1Q0M5OFx1QjlBQylcbiAgICBoYW5kbGVHb29nbGVBcGlSZXF1ZXN0KG1lc3NhZ2UucGF5bG9hZClcbiAgICAgIC50aGVuKHJlc3VsdCA9PiBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlLCBkYXRhOiByZXN1bHQgfSkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlcnJvci5tZXNzYWdlIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTsgLy8gXHVCRTQ0XHVCM0Q5XHVBRTMwIFx1Qzc1MVx1QjJGNVxuICB9IGVsc2UgaWYgKG1lc3NhZ2UuYWN0aW9uID09PSAnQVVUSE9SSVpFX0dPT0dMRV9XT1JLU1BBQ0UnKSB7XG4gICAgLy8gR29vZ2xlIFdvcmtzcGFjZSBPQXV0aCBcdUM3NzhcdUM5OURcbiAgICBhdXRob3JpemVHb29nbGVXb3Jrc3BhY2UoKVxuICAgICAgLnRoZW4odG9rZW4gPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSwgdG9rZW4gfSkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlcnJvci5tZXNzYWdlIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTsgLy8gXHVCRTQ0XHVCM0Q5XHVBRTMwIFx1Qzc1MVx1QjJGNVxuICB9IGVsc2Uge1xuICAgIGNvbnNvbGUud2FybignW0RhaWx5IFNjcnVtXSBVbmtub3duIGFjdGlvbjonLCBtZXNzYWdlLmFjdGlvbik7XG4gICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiAnVW5rbm93biBhY3Rpb24nIH0pO1xuICB9XG5cbiAgcmV0dXJuIHRydWU7IC8vIFx1QkU0NFx1QjNEOVx1QUUzMCBzZW5kUmVzcG9uc2UgXHVDNzIwXHVDOUMwXG59KTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gR29vZ2xlIEFQSSBcdUQ1NzhcdUI0RTRcdUI3RUNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBHb29nbGUgQVBJIFx1QzY5NFx1Q0NBRCBcdUNDOThcdUI5QUNcbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gcGF5bG9hZCAtIHsgYXBpVHlwZTogJ2RvY3MnfCdzaGVldHMnfCdzbGlkZXMnLCBkb2N1bWVudElkOiBzdHJpbmcgfVxuICogQHJldHVybnMge1Byb21pc2U8T2JqZWN0Pn0gQVBJIFx1Qzc1MVx1QjJGNSBcdUIzNzBcdUM3NzRcdUQxMzBcbiAqL1xuYXN5bmMgZnVuY3Rpb24gaGFuZGxlR29vZ2xlQXBpUmVxdWVzdChwYXlsb2FkKSB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBhcGlUeXBlLCBkb2N1bWVudElkIH0gPSBwYXlsb2FkO1xuXG4gICAgLy8gXHVEMUEwXHVEMDcwIFx1RDY1NVx1Qzc3OCAoXHVDNUM2XHVDNzNDXHVCQTc0IFx1Qzc5MFx1QjNEOSBcdUM3NzhcdUM5OUQgXHVDMkRDXHVCM0M0KVxuICAgIGxldCB0b2tlbiA9IGF3YWl0IGdldEFjY2Vzc1Rva2VuKCk7XG4gICAgaWYgKCF0b2tlbikge1xuICAgICAgLy8gUmVxdWVzdGluZyBHb29nbGUgQVBJIGF1dGhvcml6YXRpb25cbiAgICAgIHRva2VuID0gYXdhaXQgYXV0aG9yaXplR29vZ2xlV29ya3NwYWNlKCk7XG4gICAgfVxuXG4gICAgLy8gQVBJIFx1RDBDMFx1Qzc4NVx1QkNDNCBcdUNDOThcdUI5QUNcbiAgICBzd2l0Y2ggKGFwaVR5cGUpIHtcbiAgICAgIGNhc2UgJ2RvY3MnOlxuICAgICAgICBjb25zdCBkb2NUZXh0ID0gYXdhaXQgZ2V0RG9jdW1lbnRUZXh0KGRvY3VtZW50SWQpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGRvY3VtZW50SWQsXG4gICAgICAgICAgdGV4dDogZG9jVGV4dCxcbiAgICAgICAgICB0eXBlOiAnZG9jcydcbiAgICAgICAgfTtcblxuICAgICAgY2FzZSAnc2hlZXRzJzpcbiAgICAgICAgY29uc3Qgc3ByZWFkc2hlZXQgPSBhd2FpdCBnZXRTcHJlYWRzaGVldChkb2N1bWVudElkKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBkb2N1bWVudElkLFxuICAgICAgICAgIHRpdGxlOiBzcHJlYWRzaGVldC5wcm9wZXJ0aWVzPy50aXRsZSxcbiAgICAgICAgICBzaGVldHM6IHNwcmVhZHNoZWV0LnNoZWV0cz8ubWFwKHMgPT4gcy5wcm9wZXJ0aWVzPy50aXRsZSksXG4gICAgICAgICAgdHlwZTogJ3NoZWV0cydcbiAgICAgICAgfTtcblxuICAgICAgY2FzZSAnc2xpZGVzJzpcbiAgICAgICAgY29uc3QgcHJlc2VudGF0aW9uID0gYXdhaXQgZ2V0UHJlc2VudGF0aW9uVGV4dChkb2N1bWVudElkKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBkb2N1bWVudElkLFxuICAgICAgICAgIHNsaWRlczogcHJlc2VudGF0aW9uLnNsaWRlcyxcbiAgICAgICAgICBmdWxsVGV4dDogcHJlc2VudGF0aW9uLmZ1bGxUZXh0LFxuICAgICAgICAgIHR5cGU6ICdzbGlkZXMnXG4gICAgICAgIH07XG5cbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBBUEkgdHlwZTogJHthcGlUeXBlfWApO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIEdvb2dsZSBBUEkgcmVxdWVzdCBlcnJvcjonLCBlcnJvcik7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHVCMzcwXHVDNzc0XHVEMTMwIFx1QzIxOFx1QzlEMSBcdUQ1NzhcdUI0RTRcdUI3RUNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBEQVRBX0NBUFRVUkVEIFx1QzU2MVx1QzE1OCBcdUNDOThcdUI5QUNcbiAqL1xuYXN5bmMgZnVuY3Rpb24gaGFuZGxlRGF0YUNhcHR1cmVkKHBheWxvYWQsIHNlbmRlcikge1xuICB0cnkge1xuICAgIC8vIFx1QjNEOVx1Qzc1OCBcdUQ2NTVcdUM3NzggKFx1Q0Q1Q1x1QzZCMFx1QzEyMClcbiAgICBjb25zdCB7IGNvbnNlbnRHaXZlbiB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFsnY29uc2VudEdpdmVuJ10pO1xuICAgIGlmIChjb25zZW50R2l2ZW4gIT09IHRydWUpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCB7IGlzTG9nZ2VkSW4gfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbU1RPUkFHRV9LRVlTLklTX0xPR0dFRF9JTl0pO1xuXG4gICAgLy8gXHVCQTU0XHVEMEMwXHVCMzcwXHVDNzc0XHVEMTMwIFx1Q0Q5NFx1QUMwMFxuICAgIGNvbnN0IGVucmljaGVkUGF5bG9hZCA9IHtcbiAgICAgIC4uLnBheWxvYWQsXG4gICAgICB0YWJJZDogc2VuZGVyLnRhYj8uaWQsXG4gICAgICBjYXB0dXJlZEF0OiBEYXRlLm5vdygpXG4gICAgfTtcblxuICAgIC8vIFRhYiB0cmFuc2l0aW9uIChpbnRlcmFjdGlvbiBzb3VyY2UpXHVDNzQwIFx1Qzc3NFx1QkJGOCBmcm9tL3RvIGhvc3RuYW1lXHVDNzc0IFx1Qzc4OFx1QzczQ1x1QkJDMFx1Qjg1Q1xuICAgIC8vIHNlbmRlci50YWI/LnVybCBcdUNEOTRcdUFDMDBcdUQ1NThcdUM5QzAgXHVDNTRBXHVDNzRDIChcdUIyRTRcdUI5NzggXHVEMEVEIFVSTFx1Qzc3NCBcdUI0RTRcdUM1QjRcdUFDMDggXHVDMjE4IFx1Qzc4OFx1Qzc0QylcbiAgICAvLyBcdUIyRTRcdUI5NzggXHVDMThDXHVDMkE0XHVCNEU0XHVDNzQwIFx1RDYwNFx1QzdBQyBcdUQwRURcdUM3NTggVVJMIFx1Q0Q5NFx1QUMwMFxuICAgIGlmIChwYXlsb2FkLnNvdXJjZSAhPT0gJ2ludGVyYWN0aW9uJykge1xuICAgICAgZW5yaWNoZWRQYXlsb2FkLnVybCA9IHNlbmRlci50YWI/LnVybDtcbiAgICB9XG5cbiAgICBpZiAoaXNMb2dnZWRJbikge1xuICAgICAgLy8gXHVCODVDXHVBREY4XHVDNzc4IFx1QzBDMVx1RDBEQzogXHVDNTU0XHVENjM4XHVENjU0IFx1RDZDNCBcdUM4MDRcdUMxQTEgXHVEMDUwXHVDNUQwIFx1Q0Q5NFx1QUMwMFxuICAgICAgaWYgKCFlbmNyeXB0aW9uRW5naW5lLmhhc0tleSgpKSB7XG4gICAgICAgIGNvbnNvbGUud2FybignW0RhaWx5IFNjcnVtXSBFbmNyeXB0aW9uIGtleSBub3QgZGVyaXZlZCwgaW5pdGlhbGl6aW5nLi4uJyk7XG4gICAgICAgIGF3YWl0IGluaXRpYWxpemVFbmNyeXB0aW9uKCk7XG4gICAgICB9XG5cbiAgICAgIC8vIHNvdXJjZSBcdUQ1NDRcdUI0RENcdUI5N0MgXHVDNTU0XHVENjM4XHVENjU0IFx1QzgwNFx1QzVEMCBcdUJEODRcdUI5QUMgKGluZ2VzdCBlbmRwb2ludFx1QzVEMFx1QzExQyBcdUJDQzRcdUIzQzQgXHVENTQ0XHVCNERDXHVCODVDIFx1RDU0NFx1QzY5NClcbiAgICAgIGNvbnN0IHsgc291cmNlLCB0eXBlLCAuLi5kYXRhVG9FbmNyeXB0IH0gPSBlbnJpY2hlZFBheWxvYWQ7XG4gICAgICBjb25zdCBlbmNyeXB0ZWQgPSBhd2FpdCBlbmNyeXB0aW9uRW5naW5lLmVuY3J5cHQoZGF0YVRvRW5jcnlwdCk7XG5cbiAgICAgIC8vIGluZ2VzdCBlbmRwb2ludCBcdUQ2MTVcdUMyRERcdUM1RDAgXHVCOURFXHVBQzhDIFx1QkNDMFx1RDY1OFxuICAgICAgY29uc3QgaW5nZXN0SXRlbSA9IHtcbiAgICAgICAgc291cmNlOiBzb3VyY2UgfHwgdHlwZSB8fCAndW5rbm93bicsXG4gICAgICAgIGl2OiBKU09OLnN0cmluZ2lmeShlbmNyeXB0ZWQuaXYpLFxuICAgICAgICBjaXBoZXJ0ZXh0OiBKU09OLnN0cmluZ2lmeShlbmNyeXB0ZWQuY2lwaGVydGV4dCksXG4gICAgICAgIGFsZ29yaXRobTogZW5jcnlwdGVkLmFsZ29yaXRobSxcbiAgICAgICAgdGltZXN0YW1wOiBlbmNyeXB0ZWQudGltZXN0YW1wLFxuICAgICAgICBtZXRhZGF0YToge31cbiAgICAgIH07XG5cbiAgICAgIGF3YWl0IGFkZFRvU2VuZFF1ZXVlKGluZ2VzdEl0ZW0pO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBcdUJFNDRcdUI4NUNcdUFERjhcdUM3NzggXHVDMEMxXHVEMERDOiBcdUM3ODRcdUMyREMgXHVCQzg0XHVEMzdDXHVDNUQwIFx1QzgwMFx1QzdBNSAoXHVEM0M5XHVCQjM4KVxuICAgICAgYXdhaXQgYWRkVG9UZW1wQnVmZmVyKGVucmljaGVkUGF5bG9hZCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gaGFuZGxlRGF0YUNhcHR1cmVkIGVycm9yOicsIGVycm9yKTtcbiAgfVxufVxuXG4vKipcbiAqIFx1QzgwNFx1QzFBMSBcdUQwNTBcdUM1RDAgXHVCMzcwXHVDNzc0XHVEMTMwIFx1Q0Q5NFx1QUMwMFxuICovXG5hc3luYyBmdW5jdGlvbiBhZGRUb1NlbmRRdWV1ZShwYXlsb2FkKSB7XG4gIGNvbnN0IHsgc2VuZFF1ZXVlID0gW10gfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbU1RPUkFHRV9LRVlTLlNFTkRfUVVFVUVdKTtcbiAgc2VuZFF1ZXVlLnB1c2gocGF5bG9hZCk7XG4gIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtTVE9SQUdFX0tFWVMuU0VORF9RVUVVRV06IHNlbmRRdWV1ZSB9KTtcbn1cblxuLyoqXG4gKiBcdUM3ODRcdUMyREMgXHVCQzg0XHVEMzdDXHVDNUQwIFx1QjM3MFx1Qzc3NFx1RDEzMCBcdUNEOTRcdUFDMDAgKEluZGV4ZWREQilcbiAqL1xuYXN5bmMgZnVuY3Rpb24gYWRkVG9UZW1wQnVmZmVyKHBheWxvYWQpIHtcbiAgdHJ5IHtcbiAgICBhd2FpdCB0ZW1wQnVmZmVyLmFkZChwYXlsb2FkKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIGFkZFRvVGVtcEJ1ZmZlciBlcnJvcjonLCBlcnJvcik7XG4gIH1cbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gVGFiIFRyYW5zaXRpb24gXHVCOUU0XHVDRTZEXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogVEFCX1RSQU5TSVRJT04gXHVDNTYxXHVDMTU4IFx1Q0M5OFx1QjlBQ1xuICogaW50ZXJhY3Rpb24tdHJhY2tlci5qc1x1QzVEMFx1QzExQyB2aXNpYmlsaXR5Y2hhbmdlIFx1Qzc3NFx1QkNBNFx1RDJCOFx1Qjg1QyBcdUM4MDRcdUMxQTFcbiAqL1xuYXN5bmMgZnVuY3Rpb24gaGFuZGxlVGFiVHJhbnNpdGlvbihwYXlsb2FkLCBzZW5kZXIpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHR5cGUsIGhvc3RuYW1lLCBhdCB9ID0gcGF5bG9hZDtcbiAgICBjb25zdCB0YWJJZCA9IHNlbmRlci50YWI/LmlkO1xuXG4gICAgaWYgKHR5cGUgPT09ICdsZWF2ZScpIHtcbiAgICAgIC8vIFx1RDBFRFx1Qzc0NCBcdUI1QTBcdUIwQTAgXHVCNTRDOiBsYXN0VHJhbnNpdGlvbiBcdUM4MDBcdUM3QTVcbiAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7XG4gICAgICAgIFtTVE9SQUdFX0tFWVMuTEFTVF9UUkFOU0lUSU9OXToge1xuICAgICAgICAgIHR5cGU6ICdsZWF2ZScsXG4gICAgICAgICAgaG9zdG5hbWUsXG4gICAgICAgICAgYXQsXG4gICAgICAgICAgdGFiSWRcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICAvLyBUYWIgbGVmdFxuICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ2VudGVyJykge1xuICAgICAgLy8gXHVEMEVEXHVDNUQwIFx1QzlDNFx1Qzc4NVx1RDU2MCBcdUI1NEM6IFx1Qzc3NFx1QzgwNCBsZWF2ZVx1QzY0MCBcdUI5RTRcdUNFNkRcbiAgICAgIGNvbnN0IHsgbGFzdFRyYW5zaXRpb24gfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbU1RPUkFHRV9LRVlTLkxBU1RfVFJBTlNJVElPTl0pO1xuXG4gICAgICBpZiAobGFzdFRyYW5zaXRpb24gJiYgbGFzdFRyYW5zaXRpb24udHlwZSA9PT0gJ2xlYXZlJykge1xuICAgICAgICAvLyBUcmFuc2l0aW9uIFx1QzMwRCBcdUMwRERcdUMxMzFcbiAgICAgICAgY29uc3QgdHJhbnNpdGlvbiA9IHtcbiAgICAgICAgICBmcm9tOiBsYXN0VHJhbnNpdGlvbi5ob3N0bmFtZSxcbiAgICAgICAgICB0bzogaG9zdG5hbWUsXG4gICAgICAgICAgbGVmdEF0OiBsYXN0VHJhbnNpdGlvbi5hdCxcbiAgICAgICAgICBlbnRlcmVkQXQ6IGF0LFxuICAgICAgICAgIGdhcDogYXQgLSBsYXN0VHJhbnNpdGlvbi5hdCxcbiAgICAgICAgICB0aW1lc3RhbXA6IGF0XG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gVHJhbnNpdGlvblx1Qzc0NCBcdUIzNzBcdUM3NzRcdUQxMzBcdUI4NUMgXHVDODAwXHVDN0E1XG4gICAgICAgIGF3YWl0IGhhbmRsZURhdGFDYXB0dXJlZCh7XG4gICAgICAgICAgdHlwZTogJ0RBSUxZX1NDUlVNX0NBUFRVUkUnLFxuICAgICAgICAgIHNvdXJjZTogJ2ludGVyYWN0aW9uJyxcbiAgICAgICAgICBkYXRhOiB0cmFuc2l0aW9uXG4gICAgICAgIH0sIHNlbmRlcik7XG5cbiAgICAgICAgLy8gbGFzdFRyYW5zaXRpb24gXHVDRDA4XHVBRTMwXHVENjU0XG4gICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnJlbW92ZShTVE9SQUdFX0tFWVMuTEFTVF9UUkFOU0lUSU9OKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFRhYiBlbnRlcmVkIHdpdGhvdXQgbWF0Y2hpbmcgbGVhdmVcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBoYW5kbGVUYWJUcmFuc2l0aW9uIGVycm9yOicsIGVycm9yKTtcbiAgfVxufVxuXG4vKipcbiAqIGNocm9tZS50YWJzLm9uQWN0aXZhdGVkXHVCODVDIFx1RDY1Q1x1QzEzMSBcdUQwRUQgXHVDRDk0XHVDODAxXG4gKiAoXHVDRDk0XHVBQzAwXHVDODAxXHVDNzc4IFx1RDBFRCBcdUM4MDRcdUQ2NTggXHVBQzEwXHVDOUMwKVxuICovXG5jaHJvbWUudGFicy5vbkFjdGl2YXRlZC5hZGRMaXN0ZW5lcihhc3luYyAoYWN0aXZlSW5mbykgPT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHRhYiA9IGF3YWl0IGNocm9tZS50YWJzLmdldChhY3RpdmVJbmZvLnRhYklkKTtcbiAgICBjb25zdCBob3N0bmFtZSA9IG5ldyBVUkwodGFiLnVybCkuaG9zdG5hbWU7XG5cbiAgICAvLyBcdUQ2NUNcdUMxMzEgXHVEMEVEIFx1QzgxNVx1QkNGNCBcdUM4MDBcdUM3QTVcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoe1xuICAgICAgW1NUT1JBR0VfS0VZUy5BQ1RJVkVfVEFCX0lORk9dOiB7XG4gICAgICAgIHRhYklkOiBhY3RpdmVJbmZvLnRhYklkLFxuICAgICAgICBob3N0bmFtZSxcbiAgICAgICAgYWN0aXZhdGVkQXQ6IERhdGUubm93KClcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIFRhYiBhY3RpdmF0ZWRcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBjaHJvbWU6Ly8gXHVCNEYxIFx1QzgxMVx1QURGQyBcdUJEODhcdUFDMDAgVVJMXHVDNzQwIFx1QkIzNFx1QzJEQ1xuICB9XG59KTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHVCQzMwXHVDRTU4IFx1QzgwNFx1QzFBMVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFx1QkMzMFx1Q0U1OCBcdUM4MDRcdUMxQTEgXHVDNTRDXHVCNzhDIFx1QjlBQ1x1QzJBNFx1QjEwOFxuICovXG5jaHJvbWUuYWxhcm1zLm9uQWxhcm0uYWRkTGlzdGVuZXIoYXN5bmMgKGFsYXJtKSA9PiB7XG4gIGlmIChhbGFybS5uYW1lID09PSAnYmF0Y2hTZW5kJykge1xuICAgIGF3YWl0IHByb2Nlc3NCYXRjaFNlbmQoKTtcbiAgfVxufSk7XG5cbi8qKlxuICogXHVCQzMwXHVDRTU4IFx1QzgwNFx1QzFBMSBcdUNDOThcdUI5QUNcbiAqL1xuYXN5bmMgZnVuY3Rpb24gcHJvY2Vzc0JhdGNoU2VuZCgpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHNlbmRRdWV1ZSA9IFtdLCBpc0xvZ2dlZEluIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1xuICAgICAgU1RPUkFHRV9LRVlTLlNFTkRfUVVFVUUsXG4gICAgICBTVE9SQUdFX0tFWVMuSVNfTE9HR0VEX0lOXG4gICAgXSk7XG5cbiAgICBpZiAoIWlzTG9nZ2VkSW4pIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoc2VuZFF1ZXVlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFN1cGFiYXNlIEVkZ2UgRnVuY3Rpb25cdUM3M0NcdUI4NUMgXHVDODA0XHVDMUExXG4gICAgY29uc3Qgc3VjY2VzcyA9IGF3YWl0IHNlbmRUb1N1cGFiYXNlKHNlbmRRdWV1ZSk7XG5cbiAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgLy8gXHVDODA0XHVDMUExIFx1QzEzMVx1QUNGNSBcdUMyREMgXHVEMDUwIFx1QkU0NFx1QzZCMFx1QUUzMFxuICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW1NUT1JBR0VfS0VZUy5TRU5EX1FVRVVFXTogW10gfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gQmF0Y2ggc2VuZCBmYWlsZWQgYWZ0ZXIgcmV0cmllcycpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIHByb2Nlc3NCYXRjaFNlbmQgZXJyb3I6JywgZXJyb3IpO1xuICB9XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMwQzFcdUQwREMgXHVBRDAwXHVCOUFDXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogY2hyb21lLnN0b3JhZ2UgXHVCQ0MwXHVBQ0JEIFx1QUMxMFx1QzlDMCAoXHVCODVDXHVBREY4XHVDNzc4IFx1QzBDMVx1RDBEQyBcdUI0RjEpXG4gKi9cbmNocm9tZS5zdG9yYWdlLm9uQ2hhbmdlZC5hZGRMaXN0ZW5lcihhc3luYyAoY2hhbmdlcywgYXJlYU5hbWUpID0+IHtcbiAgaWYgKGFyZWFOYW1lICE9PSAnbG9jYWwnKSByZXR1cm47XG5cbiAgLy8gXHVCODVDXHVBREY4XHVDNzc4IFx1QzBDMVx1RDBEQyBcdUJDQzBcdUFDQkQgXHVBQzEwXHVDOUMwXG4gIGlmIChjaGFuZ2VzW1NUT1JBR0VfS0VZUy5JU19MT0dHRURfSU5dKSB7XG4gICAgY29uc3QgeyBuZXdWYWx1ZSB9ID0gY2hhbmdlc1tTVE9SQUdFX0tFWVMuSVNfTE9HR0VEX0lOXTtcbiAgICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBMb2dpbiBzdGF0ZSBjaGFuZ2VkOicsIG5ld1ZhbHVlKTtcblxuICAgIGlmIChuZXdWYWx1ZSA9PT0gdHJ1ZSkge1xuICAgICAgLy8gXHVCODVDXHVBREY4XHVDNzc4IFx1QzJEQzogXHVDNTU0XHVENjM4XHVENjU0IFx1RDBBNCBcdUNEMDhcdUFFMzBcdUQ2NTQgXHVENkM0IFx1Qzc4NFx1QzJEQyBcdUJDODRcdUQzN0MgXHVENTBDXHVCN0VDXHVDMkRDXG4gICAgICBhd2FpdCBpbml0aWFsaXplRW5jcnlwdGlvbigpO1xuICAgICAgYXdhaXQgZmx1c2hUZW1wQnVmZmVyVG9RdWV1ZSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBcdUI4NUNcdUFERjhcdUM1NDRcdUM2QzMgXHVDMkRDOiBcdUM1NTRcdUQ2MzhcdUQ2NTQgXHVEMEE0IFx1RDNEMFx1QUUzMFxuICAgICAgZW5jcnlwdGlvbkVuZ2luZS5jbGVhcktleSgpO1xuICAgIH1cbiAgfVxufSk7XG5cbi8qKlxuICogXHVDNzg0XHVDMkRDIFx1QkM4NFx1RDM3QyBcdUIzNzBcdUM3NzRcdUQxMzBcdUI5N0MgXHVDNTU0XHVENjM4XHVENjU0XHVENTU4XHVDNUVDIFx1QzgwNFx1QzFBMSBcdUQwNTBcdUI4NUMgXHVDNzc0XHVCM0Q5XG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZsdXNoVGVtcEJ1ZmZlclRvUXVldWUoKSB7XG4gIHRyeSB7XG4gICAgY29uc3QgY291bnQgPSBhd2FpdCB0ZW1wQnVmZmVyLmdldENvdW50KCk7XG5cbiAgICBpZiAoY291bnQgPT09IDApIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBcdUM1NTRcdUQ2MzhcdUQ2NTQgXHVEMEE0IFx1Q0QwOFx1QUUzMFx1RDY1NCAoXHVCODVDXHVBREY4XHVDNzc4IFx1QzlDMVx1RDZDNCBcdUQ2MzhcdUNEOUNcdUI0MThcdUJCQzBcdUI4NUMgXHVENTQ0XHVDMjE4KVxuICAgIGlmICghZW5jcnlwdGlvbkVuZ2luZS5oYXNLZXkoKSkge1xuICAgICAgYXdhaXQgaW5pdGlhbGl6ZUVuY3J5cHRpb24oKTtcbiAgICB9XG5cbiAgICAvLyBJbmRleGVkREJcdUM1RDBcdUMxMUMgXHVCMzcwXHVDNzc0XHVEMTMwXHVCOTdDIFx1QzU1NFx1RDYzOFx1RDY1NFx1RDU1OFx1QzVFQyBcdUM4MDRcdUMxQTEgXHVEMDUwXHVCODVDIFx1Qzc3NFx1QjNEOVxuICAgIGF3YWl0IHRlbXBCdWZmZXIuZmx1c2hUb1NlcnZlcihhc3luYyAoZGF0YUFycmF5KSA9PiB7XG4gICAgICBjb25zdCB7IHNlbmRRdWV1ZSA9IFtdIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1NUT1JBR0VfS0VZUy5TRU5EX1FVRVVFXSk7XG5cbiAgICAgIC8vIFx1QUMwMSBcdUIzNzBcdUM3NzRcdUQxMzAgXHVDNTU0XHVENjM4XHVENjU0XG4gICAgICBjb25zdCBlbmNyeXB0ZWRJdGVtcyA9IFtdO1xuICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGRhdGFBcnJheSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIC8vIHNvdXJjZSBcdUQ1NDRcdUI0RENcdUI5N0MgXHVDNTU0XHVENjM4XHVENjU0IFx1QzgwNFx1QzVEMCBcdUJEODRcdUI5QUNcbiAgICAgICAgICBjb25zdCB7IHNvdXJjZSwgdHlwZSwgLi4uZGF0YVRvRW5jcnlwdCB9ID0gaXRlbTtcbiAgICAgICAgICBjb25zdCBlbmNyeXB0ZWQgPSBhd2FpdCBlbmNyeXB0aW9uRW5naW5lLmVuY3J5cHQoZGF0YVRvRW5jcnlwdCk7XG5cbiAgICAgICAgICAvLyBpbmdlc3QgZW5kcG9pbnQgXHVENjE1XHVDMkREXHVDNUQwIFx1QjlERVx1QUM4QyBcdUJDQzBcdUQ2NThcbiAgICAgICAgICBjb25zdCBpbmdlc3RJdGVtID0ge1xuICAgICAgICAgICAgc291cmNlOiBzb3VyY2UgfHwgdHlwZSB8fCAndW5rbm93bicsXG4gICAgICAgICAgICBpdjogSlNPTi5zdHJpbmdpZnkoZW5jcnlwdGVkLml2KSwgICAgIC8vIG51bWJlcltdIFx1MjE5MiBzdHJpbmdcbiAgICAgICAgICAgIGNpcGhlcnRleHQ6IEpTT04uc3RyaW5naWZ5KGVuY3J5cHRlZC5jaXBoZXJ0ZXh0KSwgLy8gbnVtYmVyW10gXHUyMTkyIHN0cmluZ1xuICAgICAgICAgICAgYWxnb3JpdGhtOiBlbmNyeXB0ZWQuYWxnb3JpdGhtLFxuICAgICAgICAgICAgdGltZXN0YW1wOiBlbmNyeXB0ZWQudGltZXN0YW1wLFxuICAgICAgICAgICAgbWV0YWRhdGE6IHt9XG4gICAgICAgICAgfTtcblxuICAgICAgICAgIGVuY3J5cHRlZEl0ZW1zLnB1c2goaW5nZXN0SXRlbSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gRmFpbGVkIHRvIGVuY3J5cHQgdGVtcCBidWZmZXIgaXRlbTonLCBlcnIpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG1lcmdlZFF1ZXVlID0gWy4uLnNlbmRRdWV1ZSwgLi4uZW5jcnlwdGVkSXRlbXNdO1xuICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW1NUT1JBR0VfS0VZUy5TRU5EX1FVRVVFXTogbWVyZ2VkUXVldWUgfSk7XG4gICAgfSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBmbHVzaFRlbXBCdWZmZXJUb1F1ZXVlIGVycm9yOicsIGVycm9yKTtcbiAgfVxufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBcdUM3MjBcdUQyRjhcdUI5QUNcdUQyRjBcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBcdUI4NUNcdUFERjhcdUM3NzggXHVDMEMxXHVEMERDIFx1RDY1NVx1Qzc3OCAoXHVCMkU0XHVCOTc4IFx1QkFBOFx1QjRDOFx1QzVEMFx1QzExQyBcdUQ2MzhcdUNEOUMgXHVBQzAwXHVCMkE1KVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0TG9naW5TdGF0ZSgpIHtcbiAgY29uc3QgeyBpc0xvZ2dlZEluLCB1c2VySWQgfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXG4gICAgU1RPUkFHRV9LRVlTLklTX0xPR0dFRF9JTixcbiAgICBTVE9SQUdFX0tFWVMuVVNFUl9JRFxuICBdKTtcbiAgcmV0dXJuIHsgaXNMb2dnZWRJbjogaXNMb2dnZWRJbiB8fCBmYWxzZSwgdXNlcklkOiB1c2VySWQgfHwgbnVsbCB9O1xufVxuXG4vKipcbiAqIFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMxMjRcdUM4MTUgKHBvcHVwXHVDNzc0XHVCMDk4IFx1QjJFNFx1Qjk3OCBcdUJBQThcdUI0QzhcdUM1RDBcdUMxMUMgXHVENjM4XHVDRDlDKVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2V0TG9naW5TdGF0ZShpc0xvZ2dlZEluLCB1c2VySWQgPSBudWxsKSB7XG4gIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7XG4gICAgW1NUT1JBR0VfS0VZUy5JU19MT0dHRURfSU5dOiBpc0xvZ2dlZEluLFxuICAgIFtTVE9SQUdFX0tFWVMuVVNFUl9JRF06IHVzZXJJZFxuICB9KTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHVDNTU0XHVENjM4XHVENjU0IFx1Q0QwOFx1QUUzMFx1RDY1NFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFx1QzU1NFx1RDYzOFx1RDY1NCBcdUQwQTQgXHVEMzBDXHVDMEREIChcdUI4NUNcdUFERjhcdUM3NzggXHVDMkRDIFx1RDYzOFx1Q0Q5QylcbiAqXG4gKiB1c2VySWRcdUM2NDAgc2VydmVyU2FsdFx1Qjk3QyBcdUMwQUNcdUM2QTlcdUQ1NThcdUM1RUMgUEJLREYyXHVCODVDIFx1RDBBNCBcdUQzMENcdUMwRERcbiAqL1xuYXN5bmMgZnVuY3Rpb24gaW5pdGlhbGl6ZUVuY3J5cHRpb24oKSB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyB1c2VySWQsIHNlcnZlclNhbHQsIGF1dGhUb2tlbiB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtcbiAgICAgIFNUT1JBR0VfS0VZUy5VU0VSX0lELFxuICAgICAgU1RPUkFHRV9LRVlTLlNFUlZFUl9TQUxULFxuICAgICAgU1RPUkFHRV9LRVlTLkFVVEhfVE9LRU5cbiAgICBdKTtcblxuICAgIGlmICghdXNlcklkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VzZXIgSUQgbm90IGZvdW5kIGluIHN0b3JhZ2UnKTtcbiAgICB9XG5cbiAgICAvLyBTYWx0IFx1QjNEOVx1QUUzMFx1RDY1NCBcdUI4NUNcdUM5QzEgKFx1QjJFNFx1QzkxMSBcdUI1MTRcdUJDMTRcdUM3NzRcdUMyQTQgXHVDOUMwXHVDNkQwKVxuICAgIGxldCBzYWx0ID0gc2VydmVyU2FsdDtcbiAgICBsZXQgc2FsdFdhc0dlbmVyYXRlZCA9IGZhbHNlO1xuXG4gICAgaWYgKCFzYWx0KSB7XG4gICAgICAvLyBTdGVwIDE6IFx1Qjg1Q1x1Q0VFQ1x1QzVEMCBzYWx0XHVBQzAwIFx1QzVDNlx1QzczQ1x1QkE3NCBcdUMxMUNcdUJDODRcdUM1RDBcdUMxMUMgXHVCQTNDXHVDODAwIFx1Qzg3MFx1RDY4QyAoXHVCMkU0XHVDOTExIFx1QjUxNFx1QkMxNFx1Qzc3NFx1QzJBNCBcdUM5QzBcdUM2RDApXG4gICAgICBpZiAoYXV0aFRva2VuKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgZXhpc3RpbmdTYWx0ID0gYXdhaXQgZmV0Y2hTYWx0RnJvbVN1cGFiYXNlKHVzZXJJZCwgYXV0aFRva2VuKTtcbiAgICAgICAgICBpZiAoZXhpc3RpbmdTYWx0KSB7XG4gICAgICAgICAgICAvLyBcdUMxMUNcdUJDODRcdUM1RDAgXHVDNzc0XHVCQkY4IHNhbHQgXHVDODc0XHVDN0FDIFx1MjE5MiBcdUIyRTRcdUM2QjRcdUI4NUNcdUI0RENcdUQ1NThcdUM1RUMgXHVDMEFDXHVDNkE5XG4gICAgICAgICAgICBzYWx0ID0gZXhpc3RpbmdTYWx0O1xuICAgICAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW1NUT1JBR0VfS0VZUy5TRVJWRVJfU0FMVF06IHNhbHQgfSk7XG4gICAgICAgICAgICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBcdTI3MDUgRG93bmxvYWRlZCBleGlzdGluZyBzYWx0IGZyb20gc2VydmVyIChtdWx0aS1kZXZpY2Ugc3luYyknKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgY29uc29sZS53YXJuKCdbRGFpbHkgU2NydW1dIFx1MjZBMFx1RkUwRiBGYWlsZWQgdG8gZmV0Y2ggZXhpc3Rpbmcgc2FsdCBmcm9tIHNlcnZlcjonLCBlcnJvci5tZXNzYWdlKTtcbiAgICAgICAgICAvLyBcdUMxMUNcdUJDODQgXHVDODcwXHVENjhDIFx1QzJFNFx1RDMyOCBcdUMyREMgXHVBQ0M0XHVDMThEIFx1QzlDNFx1RDU4OSAoXHVDMEM4IHNhbHQgXHVDMEREXHVDMTMxIFx1QzJEQ1x1QjNDNClcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBTdGVwIDI6IFx1QzExQ1x1QkM4NFx1QzVEMFx1QjNDNCBcdUM1QzZcdUM3M0NcdUJBNzQgXHVDMEM4XHVCODVDIFx1QzBERFx1QzEzMSAoXHVDRDVDXHVDRDA4IFx1Qjg1Q1x1QURGOFx1Qzc3OClcbiAgICAgIGlmICghc2FsdCkge1xuICAgICAgICBzYWx0ID0gYXdhaXQgZ2VuZXJhdGVTZXJ2ZXJTYWx0KCk7XG4gICAgICAgIHNhbHRXYXNHZW5lcmF0ZWQgPSB0cnVlO1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbU1RPUkFHRV9LRVlTLlNFUlZFUl9TQUxUXTogc2FsdCB9KTtcbiAgICAgICAgY29uc29sZS5sb2coJ1tEYWlseSBTY3J1bV0gXHUyNzA1IEdlbmVyYXRlZCBuZXcgc2VydmVyIHNhbHQgKGZpcnN0IGxvZ2luKScpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFx1QzU1NFx1RDYzOFx1RDY1NCBcdUQwQTQgXHVEMzBDXHVDMEREXG4gICAgYXdhaXQgZW5jcnlwdGlvbkVuZ2luZS5kZXJpdmVLZXkodXNlcklkLCBzYWx0KTtcbiAgICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBcdTI3MDUgRW5jcnlwdGlvbiBpbml0aWFsaXplZCcpO1xuXG4gICAgLy8gXHVDMEM4XHVCODVDIFx1QzBERFx1QzEzMVx1QjQxQyBzYWx0XHVCOTdDIFN1cGFiYXNlXHVDNUQwIFx1QzgwMFx1QzdBNSAoXHVDRDVDXHVDRDA4IFx1Qjg1Q1x1QURGOFx1Qzc3OCBcdUMyRENcdUI5Q0MpXG4gICAgaWYgKHNhbHRXYXNHZW5lcmF0ZWQgJiYgYXV0aFRva2VuKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBzYXZlU2FsdFRvU3VwYWJhc2VXaXRoUmV0cnkodXNlcklkLCBzYWx0LCBhdXRoVG9rZW4pO1xuICAgICAgICBjb25zb2xlLmxvZygnW0RhaWx5IFNjcnVtXSBcdTI3MDUgU2FsdCBzYXZlZCB0byBTdXBhYmFzZScpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgLy8gQ1JJVElDQUw6IFNhbHQgXHVDODAwXHVDN0E1IFx1QzJFNFx1RDMyOCBcdUMyREMgXHVDNTU0XHVENjM4XHVENjU0IFx1Q0QwOFx1QUUzMFx1RDY1NCBcdUNERThcdUMxOENcbiAgICAgICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSBcdTI3NEMgRmFpbGVkIHRvIHNhdmUgc2FsdCB0byBTdXBhYmFzZSBhZnRlciByZXRyaWVzOicsIGVycm9yKTtcblxuICAgICAgICAvLyBcdUMwQUNcdUM2QTlcdUM3OTBcdUM1RDBcdUFDOEMgXHVDNTRDXHVCOUJDXG4gICAgICAgIGNocm9tZS5ub3RpZmljYXRpb25zLmNyZWF0ZSh7XG4gICAgICAgICAgdHlwZTogJ2Jhc2ljJyxcbiAgICAgICAgICBpY29uVXJsOiAnaWNvbnMvaWNvbi00OC5wbmcnLFxuICAgICAgICAgIHRpdGxlOiAnRGFpbHkgU2NydW0gU2V0dXAgRmFpbGVkJyxcbiAgICAgICAgICBtZXNzYWdlOiAnQ2Fubm90IGNvbm5lY3QgdG8gc2VydmVyLiBQbGVhc2UgY2hlY2sgeW91ciBpbnRlcm5ldCBjb25uZWN0aW9uIGFuZCB0cnkgbG9nZ2luZyBpbiBhZ2Fpbi4nLFxuICAgICAgICAgIHByaW9yaXR5OiAyXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFx1QzU1NFx1RDYzOFx1RDY1NCBcdUMwQzFcdUQwREMgXHVDRDA4XHVBRTMwXHVENjU0IChkZWdyYWRlZCBtb2RlIFx1QkMyOVx1QzlDMClcbiAgICAgICAgZW5jcnlwdGlvbkVuZ2luZS5jbGVhcktleSgpO1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5yZW1vdmUoU1RPUkFHRV9LRVlTLlNFUlZFUl9TQUxUKTtcblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ZhaWxlZCB0byBzYXZlIGVuY3J5cHRpb24gc2FsdCAtIGNhbm5vdCBwcm9jZWVkIHdpdGhvdXQgc2VydmVyIHN5bmNocm9uaXphdGlvbicpO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIFx1Mjc0QyBGYWlsZWQgdG8gaW5pdGlhbGl6ZSBlbmNyeXB0aW9uOicsIGVycm9yKTtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG4vKipcbiAqIFNhbHRcdUI5N0MgU3VwYWJhc2VcdUM1RDAgXHVDODAwXHVDN0E1IChcdUM3QUNcdUMyRENcdUIzQzQgXHVCODVDXHVDOUMxIFx1RDNFQ1x1RDU2OClcbiAqXG4gKiBDUklUSUNBTDogU2FsdCBcdUM4MDBcdUM3QTUgXHVDMkU0XHVEMzI4IFx1QzJEQyBcdUM1NTRcdUQ2MzhcdUQ2NTRcdUI0MUMgXHVCMzcwXHVDNzc0XHVEMTMwXHVCOTdDIFx1QzExQ1x1QkM4NFx1QzVEMFx1QzExQyBcdUJDRjVcdUQ2MzhcdUQ2NTRcdUQ1NjAgXHVDMjE4IFx1QzVDNlx1QzczQ1x1QkJDMFx1Qjg1QyxcbiAqIFx1QkMxOFx1QjREQ1x1QzJEQyBcdUMxMzFcdUFDRjVcdUQ1NzRcdUM1N0MgXHVENTY5XHVCMkM4XHVCMkU0LiAzXHVENjhDIFx1QzdBQ1x1QzJEQ1x1QjNDNCBcdUQ2QzQgXHVDMkU0XHVEMzI4XHVENTU4XHVCQTc0IFx1QzYwOFx1QzY3OFx1Qjk3QyBcdUIzNThcdUM5RDFcdUIyQzhcdUIyRTQuXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IHVzZXJJZCAtIFVzZXIgSURcbiAqIEBwYXJhbSB7c3RyaW5nfSBzYWx0IC0gR2VuZXJhdGVkIHNhbHRcbiAqIEBwYXJhbSB7c3RyaW5nfSBhdXRoVG9rZW4gLSBTdXBhYmFzZSBhdXRoIHRva2VuXG4gKiBAdGhyb3dzIHtFcnJvcn0gM1x1RDY4QyBcdUM3QUNcdUMyRENcdUIzQzQgXHVENkM0XHVDNUQwXHVCM0M0IFx1QzJFNFx1RDMyOCBcdUMyRENcbiAqL1xuYXN5bmMgZnVuY3Rpb24gc2F2ZVNhbHRUb1N1cGFiYXNlV2l0aFJldHJ5KHVzZXJJZCwgc2FsdCwgYXV0aFRva2VuKSB7XG4gIGNvbnN0IG1heEF0dGVtcHRzID0gMztcbiAgY29uc3QgYmFzZUJhY2tvZmZNcyA9IDEwMDA7IC8vIDFcdUNEMDhcblxuICBmb3IgKGxldCBhdHRlbXB0ID0gMTsgYXR0ZW1wdCA8PSBtYXhBdHRlbXB0czsgYXR0ZW1wdCsrKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYCR7U1VQQUJBU0VfVVJMfS9yZXN0L3YxL3VzZXJfZW5jcnlwdGlvbl9zYWx0c2AsIHtcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke2F1dGhUb2tlbn1gLFxuICAgICAgICAgICdhcGlrZXknOiBTVVBBQkFTRV9BTk9OX0tFWSxcbiAgICAgICAgICAnUHJlZmVyJzogJ3Jlc29sdXRpb249aWdub3JlLWR1cGxpY2F0ZXMnIC8vIFx1Qzc3NFx1QkJGOCBcdUM3ODhcdUM3M0NcdUJBNzQgXHVCQjM0XHVDMkRDXG4gICAgICAgIH0sXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICB1c2VyX2lkOiB1c2VySWQsXG4gICAgICAgICAgc2FsdDogc2FsdFxuICAgICAgICB9KVxuICAgICAgfSk7XG5cbiAgICAgIGlmIChyZXNwb25zZS5vayB8fCByZXNwb25zZS5zdGF0dXMgPT09IDQwOSkge1xuICAgICAgICAvLyBcdUMxMzFcdUFDRjUgKDIwMSBDcmVhdGVkKSBcdUI2MTBcdUIyOTQgXHVDNzc0XHVCQkY4IFx1Qzg3NFx1QzdBQ1x1RDU2OCAoNDA5IENvbmZsaWN0KVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIC8vIDR4eC81eHggXHVDNUQwXHVCN0VDXG4gICAgICBjb25zdCBlcnJvclRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9OiAke2Vycm9yVGV4dH1gKTtcblxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKGBbRGFpbHkgU2NydW1dIFNhbHQgc2F2ZSBhdHRlbXB0ICR7YXR0ZW1wdH0vJHttYXhBdHRlbXB0c30gZmFpbGVkOmAsIGVycm9yLm1lc3NhZ2UpO1xuXG4gICAgICBpZiAoYXR0ZW1wdCA+PSBtYXhBdHRlbXB0cykge1xuICAgICAgICAvLyBcdUNENUNcdUM4ODUgXHVDMkU0XHVEMzI4XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIHNhdmUgc2FsdCBhZnRlciAke21heEF0dGVtcHRzfSBhdHRlbXB0czogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgICAgfVxuXG4gICAgICAvLyBFeHBvbmVudGlhbCBiYWNrb2ZmOiAxXHVDRDA4LCAyXHVDRDA4LCA0XHVDRDA4XG4gICAgICBjb25zdCBiYWNrb2ZmTXMgPSBiYXNlQmFja29mZk1zICogTWF0aC5wb3coMiwgYXR0ZW1wdCAtIDEpO1xuICAgICAgY29uc29sZS5sb2coYFtEYWlseSBTY3J1bV0gUmV0cnlpbmcgaW4gJHtiYWNrb2ZmTXN9bXMuLi5gKTtcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCBiYWNrb2ZmTXMpKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBTdXBhYmFzZVx1QzVEMFx1QzExQyBcdUFFMzBcdUM4NzQgc2FsdCBcdUM4NzBcdUQ2OEMgKFx1QjJFNFx1QzkxMSBcdUI1MTRcdUJDMTRcdUM3NzRcdUMyQTQgXHVDOUMwXHVDNkQwKVxuICpcbiAqIFx1QjJFNFx1Qjk3OCBcdUI1MTRcdUJDMTRcdUM3NzRcdUMyQTRcdUM1RDBcdUMxMUMgXHVDNzc0XHVCQkY4IHNhbHRcdUI5N0MgXHVDMEREXHVDMTMxXHVENTg4XHVDNzQ0IFx1QzIxOCBcdUM3ODhcdUM3M0NcdUJCQzBcdUI4NUMsXG4gKiBcdUMwQzggc2FsdFx1Qjk3QyBcdUMwRERcdUMxMzFcdUQ1NThcdUFFMzAgXHVDODA0XHVDNUQwIFx1QzExQ1x1QkM4NFx1QzVEMCBcdUFFMzBcdUM4NzQgc2FsdFx1QUMwMCBcdUM3ODhcdUIyOTRcdUM5QzAgXHVENjU1XHVDNzc4XHVENTY5XHVCMkM4XHVCMkU0LlxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSB1c2VySWQgLSBVc2VyIElEXG4gKiBAcGFyYW0ge3N0cmluZ30gYXV0aFRva2VuIC0gU3VwYWJhc2UgYXV0aCB0b2tlblxuICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nfG51bGw+fSBcdUMxMUNcdUJDODRcdUM1RDAgXHVDODAwXHVDN0E1XHVCNDFDIHNhbHQsIFx1QzVDNlx1QzczQ1x1QkE3NCBudWxsXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZldGNoU2FsdEZyb21TdXBhYmFzZSh1c2VySWQsIGF1dGhUb2tlbikge1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXG4gICAgICBgJHtTVVBBQkFTRV9VUkx9L3Jlc3QvdjEvdXNlcl9lbmNyeXB0aW9uX3NhbHRzP3VzZXJfaWQ9ZXEuJHt1c2VySWR9JnNlbGVjdD1zYWx0YCxcbiAgICAgIHtcbiAgICAgICAgbWV0aG9kOiAnR0VUJyxcbiAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke2F1dGhUb2tlbn1gLFxuICAgICAgICAgICdhcGlrZXknOiBTVVBBQkFTRV9BTk9OX0tFWVxuICAgICAgICB9XG4gICAgICB9XG4gICAgKTtcblxuICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c306ICR7YXdhaXQgcmVzcG9uc2UudGV4dCgpfWApO1xuICAgIH1cblxuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG5cbiAgICBpZiAoZGF0YSAmJiBkYXRhLmxlbmd0aCA+IDAgJiYgZGF0YVswXS5zYWx0KSB7XG4gICAgICByZXR1cm4gZGF0YVswXS5zYWx0O1xuICAgIH1cblxuICAgIHJldHVybiBudWxsOyAvLyBTYWx0IG5vdCBmb3VuZCBvbiBzZXJ2ZXJcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIEZhaWxlZCB0byBmZXRjaCBzYWx0IGZyb20gc2VydmVyOicsIGVycm9yLm1lc3NhZ2UpO1xuICAgIHRocm93IGVycm9yO1xuICB9XG59XG5cbi8qKlxuICogXHVDMTFDXHVCQzg0IFNhbHQgXHVDMEREXHVDMTMxIChcdUNENUNcdUMxOEMgMTZcdUJDMTRcdUM3NzRcdUQyQjgsIENTUFJORylcbiAqXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxzdHJpbmc+fVxuICovXG5hc3luYyBmdW5jdGlvbiBnZW5lcmF0ZVNlcnZlclNhbHQoKSB7XG4gIC8vIDJcdUFDMUNcdUM3NTggVVVJRCBcdUFDQjBcdUQ1NjkgXHUyMTkyIDMyXHVCQzE0XHVDNzc0XHVEMkI4ICgyNTZcdUJFNDRcdUQyQjgpXG4gIHJldHVybiBjcnlwdG8ucmFuZG9tVVVJRCgpICsgY3J5cHRvLnJhbmRvbVVVSUQoKTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gU3VwYWJhc2UgXHVDODA0XHVDMUExXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogXHVDNTU0XHVENjM4XHVENjU0XHVCNDFDIFx1QjM3MFx1Qzc3NFx1RDEzMFx1Qjk3QyBTdXBhYmFzZSBFZGdlIEZ1bmN0aW9uXHVDNUQwIFx1QzgwNFx1QzFBMVxuICpcbiAqIFx1QzdBQ1x1QzJEQ1x1QjNDNCBcdUI4NUNcdUM5QzE6IFx1Q0Q1Q1x1QjMwMCAzXHVENjhDLCBleHBvbmVudGlhbCBiYWNrb2ZmXG4gKlxuICogQHBhcmFtIHtBcnJheTx7aXY6IG51bWJlcltdLCBjaXBoZXJ0ZXh0OiBudW1iZXJbXSwgYWxnb3JpdGhtOiBzdHJpbmcsIHRpbWVzdGFtcDogbnVtYmVyfT59IGVuY3J5cHRlZEl0ZW1zXG4gKiBAcmV0dXJucyB7UHJvbWlzZTxib29sZWFuPn0gXHVDMTMxXHVBQ0Y1IFx1QzVFQ1x1QkQ4MFxuICovXG5hc3luYyBmdW5jdGlvbiBzZW5kVG9TdXBhYmFzZShlbmNyeXB0ZWRJdGVtcykge1xuICBjb25zdCBlbmRwb2ludCA9IGAke1NVUEFCQVNFX1VSTH0vZnVuY3Rpb25zL3YxL2luZ2VzdC1kYXRhYDtcblxuICAvLyBTZW5kaW5nIGJhdGNoIHRvIFN1cGFiYXNlXG5cbiAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPCBNQVhfUkVUUllfQVRURU1QVFM7IGF0dGVtcHQrKykge1xuICAgIHRyeSB7XG4gICAgICAvLyBjaHJvbWUuc3RvcmFnZVx1QzVEMFx1QzExQyBhdXRoVG9rZW4gXHVBQzAwXHVDODM4XHVDNjI0XHVBRTMwIChTZXJ2aWNlIFdvcmtlclx1QjI5NCBzdGF0ZWxlc3MpXG4gICAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoWydhdXRoVG9rZW4nXSk7XG5cbiAgICAgIGlmICghc3RvcmVkLmF1dGhUb2tlbikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbRGFpbHkgU2NydW1dIFx1Mjc0QyBObyBhdXRoIHRva2VuIGluIHN0b3JhZ2UnKTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuXG4gICAgICAvLyBQT1NUIFx1QzY5NFx1Q0NBRFxuICAgICAgY29uc3QgcGF5bG9hZCA9IHsgaXRlbXM6IGVuY3J5cHRlZEl0ZW1zIH07XG4gICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGVuZHBvaW50LCB7XG4gICAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHtzdG9yZWQuYXV0aFRva2VufWBcbiAgICAgICAgfSxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkocGF5bG9hZClcbiAgICAgIH0pO1xuXG4gICAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICAgIGNvbnN0IGVycm9yVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICAgICAgY29uc29sZS5lcnJvcignW0RhaWx5IFNjcnVtXSAtIEVycm9yIHJlc3BvbnNlOicsIGVycm9yVGV4dCk7XG5cbiAgICAgICAgLy8gNDAxIFx1QzVEMFx1QjdFQzogXHVEMUEwXHVEMDcwIFx1QjlDQ1x1QjhDQyBcdTIxOTIgXHVBQzMxXHVDMkUwIFx1QzJEQ1x1QjNDNCBcdUQ2QzQgXHVDN0FDXHVDMkRDXHVCM0M0XG4gICAgICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQwMSkge1xuICAgICAgICAgIGNvbnN0IG5ld1Rva2VuID0gYXdhaXQgcmVmcmVzaEF1dGhUb2tlbigpO1xuXG4gICAgICAgICAgaWYgKG5ld1Rva2VuKSB7XG4gICAgICAgICAgICAvLyBcdUQxQTBcdUQwNzAgXHVBQzMxXHVDMkUwIFx1QzEzMVx1QUNGNSBcdTIxOTIgXHVBQzE5XHVDNzQwIGF0dGVtcHRcdUM1RDBcdUMxMUMgXHVDN0FDXHVDMkRDXHVCM0M0XG4gICAgICAgICAgICBjb25zdCByZXRyeVJlc3BvbnNlID0gYXdhaXQgZmV0Y2goZW5kcG9pbnQsIHtcbiAgICAgICAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke25ld1Rva2VufWBcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkocGF5bG9hZClcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAocmV0cnlSZXNwb25zZS5vaykge1xuICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgcmV0cnlFcnJvclRleHQgPSBhd2FpdCByZXRyeVJlc3BvbnNlLnRleHQoKTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3JldHJ5UmVzcG9uc2Uuc3RhdHVzfSBhZnRlciB0b2tlbiByZWZyZXNoOiAke3JldHJ5RXJyb3JUZXh0fWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c306ICR7ZXJyb3JUZXh0fWApO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc29sZS5lcnJvcihgW0RhaWx5IFNjcnVtXSBTZW5kIGF0dGVtcHQgJHthdHRlbXB0ICsgMX0vJHtNQVhfUkVUUllfQVRURU1QVFN9IGZhaWxlZDpgLCBlcnJvci5tZXNzYWdlKTtcblxuICAgICAgLy8gXHVCOUM4XHVDOUMwXHVCOUM5IFx1QzJEQ1x1QjNDNFx1QUMwMCBcdUM1NDRcdUIyQzhcdUJBNzQgXHVDN0FDXHVDMkRDXHVCM0M0XG4gICAgICBpZiAoYXR0ZW1wdCA8IE1BWF9SRVRSWV9BVFRFTVBUUyAtIDEpIHtcbiAgICAgICAgLy8gRXhwb25lbnRpYWwgYmFja29mZjogMVx1Q0QwOCwgMlx1Q0QwOCwgNFx1Q0QwOFxuICAgICAgICBjb25zdCBkZWxheSA9IElOSVRJQUxfUkVUUllfREVMQVkgKiBNYXRoLnBvdygyLCBhdHRlbXB0KTtcbiAgICAgICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNvbnNvbGUuZXJyb3IoJ1tEYWlseSBTY3J1bV0gRmFpbGVkIHRvIHNlbmQgZGF0YSBhZnRlcicsIE1BWF9SRVRSWV9BVFRFTVBUUywgJ2F0dGVtcHRzJyk7XG4gIHJldHVybiBmYWxzZTtcbn1cblxuLyoqXG4gKiBTbGVlcCBcdUM3MjBcdUQyRjhcdUI5QUNcdUQyRjBcbiAqXG4gKiBAcGFyYW0ge251bWJlcn0gbXMgLSBcdUJDMDBcdUI5QUNcdUNEMDhcbiAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fVxuICovXG5mdW5jdGlvbiBzbGVlcChtcykge1xuICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIG1zKSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBU0EsSUFBTSxVQUFVO0FBQ2hCLElBQU0sYUFBYTtBQUNuQixJQUFNLGFBQWE7QUFDbkIsSUFBTSxpQkFBaUIsS0FBSyxLQUFLO0FBSzFCLElBQU0sYUFBTixNQUFpQjtBQUFBLEVBQ3RCLGNBQWM7QUFDWixTQUFLLEtBQUs7QUFBQSxFQUNaO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU1BLE1BQU0sVUFBVTtBQUNkLFFBQUksS0FBSyxHQUFJ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
