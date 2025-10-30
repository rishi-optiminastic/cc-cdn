'use strict';

function getTrackerFromURL() {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get('cc_tracker');
}


function getBrowserMetadata() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return {};
  }

  return {
    user_agent: navigator.userAgent,
    screen_resolution: `${window.screen.width}x${window.screen.height}`,
    viewport_size: `${window.innerWidth}x${window.innerHeight}`,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    referrer: document.referrer || 'direct',
    page_url: window.location.href,
    page_title: document.title
  };
}


function getPageInfo() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return {};
  }

  return {
    page_path: window.location.pathname,
    page_url: window.location.href,
    page_title: document.title,
    referrer: document.referrer
  };
}


function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

class Config {
  constructor() {
    this.defaults = {
      trackerToken: null,
      // Ensure trailing slash is always present
      apiUrl: 'http://127.0.0.1:8000/api/v1/events/', 
      sessionId: null,
      pingInterval: 15000,
      debug: false,
      autoTrack: true, 
      respectDoNotTrack: true, 
      maxRetries: 3,
      retryDelay: 1000,
      domain: null,
    };
    
    this.config = { ...this.defaults };
  }

  
  init(options = {}) {
    this.config = {
      ...this.defaults,
      ...options,
      trackerToken: options.trackerToken || getTrackerFromURL()
    };

    return this.validate();
  }

  
  validate() {
    if (!this.config.trackerToken) {
      console.error('CarbonCut: No tracker token provided. Add data-token="YOUR_TOKEN" to script tag.');
      return false;
    }

    if (!this.config.apiUrl) {
      console.error('CarbonCut: API URL is required');
      return false;
    }

    return true;
  }

  
  get(key) {
    return this.config[key];
  }

  
  set(key, value) {
    this.config[key] = value;
  }

  
  getAll() {
    return { ...this.config };
  }
}

class State {
  constructor() {
    this.state = {
      isInitialized: false,
      timeSpent: 0,
      lastPath: null,
      retryCount: 0
    };
  }

  
  get(key) {
    return this.state[key];
  }

  
  set(key, value) {
    this.state[key] = value;
  }

  
  incrementTimeSpent(seconds) {
    this.state.timeSpent += seconds;
  }

  
  reset() {
    this.state = {
      isInitialized: false,
      timeSpent: 0,
      lastPath: null,
      retryCount: 0
    };
  }

  
  getAll() {
    return { ...this.state };
  }
}

function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  
 
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

class Session {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.sessionId = null;
  }

  
  start() {
    this.sessionId = generateUUID();
    this.config.set('sessionId', this.sessionId);
    
   
    if (typeof window !== 'undefined') {
      window.__CC_SESSION_ID = this.sessionId;
      window.__CC_TRACKER_TOKEN = this.config.get('trackerToken');
    }
    
    this.logger.log('Session started:', this.sessionId);
    return this.sessionId;
  }

  
  getId() {
    return this.sessionId;
  }

  
  end() {
    this.logger.log('Session ended:', this.sessionId);
    this.sessionId = null;
    this.config.set('sessionId', null);
  }

  
  isActive() {
    return this.sessionId !== null;
  }
}

class Logger {
  constructor(debug = false) {
    this.debug = debug;
    this.prefix = 'CarbonCut:';
  }

  setDebug(debug) {
    this.debug = debug;
  }

  log(...args) {
    if (this.debug) {
      console.log(this.prefix, ...args);
    }
  }

  warn(...args) {
    if (this.debug) {
      console.warn(this.prefix, ...args);
    }
  }

  error(...args) {
    console.error(this.prefix, ...args);
  }

  info(...args) {
    if (this.debug) {
      console.info(this.prefix, ...args);
    }
  }
}

class ApiTransport {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.queue = [];
    this.isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    
    if (typeof window !== 'undefined') {
      this.setupOnlineListener();
    }
  }

  setupOnlineListener() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.logger.log('Connection restored, flushing queue');
      this.flushQueue();
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.logger.warn('Connection lost, events will be queued');
    });
  }

  async send(payload) {
    if (!this.isOnline) {
      this.logger.warn('Offline, queueing event');
      this.queue.push(payload);
      return false;
    }

    const apiUrl = this.config.get('apiUrl');
    
    try {
      if (this.shouldUseSendBeacon(payload.event)) {
        const success = this.sendViaBeacon(apiUrl, payload);
        if (success) {
          this.logger.log('Event sent via sendBeacon:', payload.event);
          return true;
        }
      }

      const response = await this.sendViaFetch(apiUrl, payload);
      this.logger.log('Event sent via fetch:', payload.event, 'Status:', response.status);
      return true;

    } catch (error) {
      this.logger.error('Failed to send event:', error);
      this.queue.push(payload);
      return false;
    }
  }

  sendViaBeacon(url, payload) {
    if (typeof navigator === 'undefined' || !navigator.sendBeacon) {
      return false;
    }

    try {
      const blob = new Blob([JSON.stringify(payload)], { 
        type: 'application/json' 
      });
      return navigator.sendBeacon(url, blob);
    } catch (error) {
      this.logger.error('sendBeacon failed:', error);
      return false;
    }
  }

  async sendViaFetch(url, payload) {
    if (!url.endsWith('/')) {
      url = url + '/';
    }
    
    this.logger.log('Sending payload to:', url, payload);
    
    const response = await fetch(url, {
      method: 'POST',  // Explicitly set POST
      headers: {
        'Content-Type': 'application/json',
        'X-Tracker-Token': this.config.get('trackerToken')
      },
      body: JSON.stringify(payload),
      keepalive: true,
      redirect: 'error'  // Don't follow redirects that might change method
    });

    // Handle responses
    if (response.status === 202 || response.status === 200) {
      return response;
    } else if (response.status === 500) {
      // Parse error details
      try {
        const errorData = await response.json();
        throw new Error(`API Error: ${errorData.message || 'Unknown error'}`);
      } catch (parseError) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    } else {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  }

  shouldUseSendBeacon(eventType) {
    return ['session_end', 'page_unload'].includes(eventType);
  }

  async flushQueue() {
    if (this.queue.length === 0) return;

    this.logger.log(`Flushing ${this.queue.length} queued events`);
    const queue = [...this.queue];
    this.queue = [];

    for (const payload of queue) {
      const success = await this.send(payload);
      if (!success) {
        this.queue.push(payload);
      }
    }
  }

  getQueueSize() {
    return this.queue.length;
  }
}

class ApiWorkerTransport {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.worker = null;
    this.isSupported = this.checkWorkerSupport();
    this.queueSize = 0;
    
    if (this.isSupported) {
      this.initWorker();
    } else {
      this.logger.warn('Web Workers not supported, falling back to main thread');
    }
  }

  checkWorkerSupport() {
    return typeof Worker !== 'undefined';
  }

  initWorker() {
    try {
      const workerCode = this.getWorkerCode();
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      
      this.worker = new Worker(workerUrl);
      
      this.worker.addEventListener('message', (event) => {
        this.handleWorkerMessage(event.data);
      });
      
      this.worker.addEventListener('error', (error) => {
        this.logger.error('Worker error:', error);
      });
      
      this.worker.postMessage({
        type: 'INIT',
        payload: {
          apiUrl: this.config.get('apiUrl'),
          trackerToken: this.config.get('trackerToken'),
          batchSize: 10,
          batchInterval: 5000
        }
      });
      
      this.setupOnlineListener();
      
      this.logger.log('Web Worker initialized for v2 event processing');
    } catch (error) {
      this.logger.error('Failed to initialize worker:', error);
      this.worker = null;
    }
  }

  getWorkerCode() {
    return `
      let config = null;
      let eventQueue = [];
      let flushTimer = null;
      let isOnline = true;

      self.addEventListener('message', async (event) => {
        const { type, payload } = event.data;

        switch (type) {
          case 'INIT':
            config = payload;
            if (config.batchInterval) {
              flushTimer = setInterval(() => {
                if (eventQueue.length > 0) {
                  flushQueue();
                }
              }, config.batchInterval);
            }
            self.postMessage({ type: 'INIT_SUCCESS' });
            break;
          
          case 'TRACK_EVENT':
            eventQueue.push({ ...payload, queuedAt: Date.now() });
            if (eventQueue.length >= (config.batchSize || 10)) {
              flushQueue();
            }
            break;
          
          case 'FLUSH_QUEUE':
            await flushQueue();
            break;
          
          case 'ONLINE':
            isOnline = true;
            await flushQueue();
            break;
          
          case 'OFFLINE':
            isOnline = false;
            break;
          
          case 'GET_QUEUE_SIZE':
            self.postMessage({ type: 'QUEUE_SIZE', size: eventQueue.length });
            break;
        }
      });

      async function flushQueue() {
        if (eventQueue.length === 0 || !isOnline) return;
        
        const batch = [...eventQueue];
        eventQueue = [];
        
        try {
          // Send individual events
          for (const event of batch) {
            // Ensure URL always has trailing slash
            let url = config.apiUrl;
            if (!url.endsWith('/')) {
              url = url + '/';
            }
            
            const response = await fetch(url, {
              method: 'POST',  // Explicitly set POST
              headers: {
                'Content-Type': 'application/json',
                'X-Tracker-Token': config.trackerToken
              },
              body: JSON.stringify(event),
              keepalive: true,
              redirect: 'error'  // Don't follow redirects
            });
            
            if (response.status !== 202 && response.status !== 200) {
              throw new Error(\`HTTP \${response.status}\`);
            }
          }
          
          self.postMessage({ type: 'FLUSH_SUCCESS', count: batch.length });
        } catch (error) {
          eventQueue.push(...batch);
          self.postMessage({ type: 'FLUSH_ERROR', error: error.message, count: batch.length });
        }
      }
    `;
  }

  handleWorkerMessage(data) {
    const { type, count, error, size } = data;
    
    switch (type) {
      case 'INIT_SUCCESS':
        this.logger.log('Worker ready for v2 API');
        break;
      
      case 'FLUSH_SUCCESS':
        this.logger.log(`Worker flushed ${count} v2 events`);
        break;
      
      case 'FLUSH_ERROR':
        this.logger.error(`Worker flush failed: ${error}`);
        break;
      
      case 'QUEUE_SIZE':
        this.queueSize = size;
        break;
    }
  }

  setupOnlineListener() {
    window.addEventListener('online', () => {
      this.worker?.postMessage({ type: 'ONLINE' });
    });

    window.addEventListener('offline', () => {
      this.worker?.postMessage({ type: 'OFFLINE' });
    });
  }

  async send(payload) {
    if (!this.worker) {
      return this.sendDirect(payload);
    }
    
    this.worker.postMessage({
      type: 'TRACK_EVENT',
      payload
    });
    
    return true;
  }

  async sendDirect(payload) {
    try {
      const response = await fetch(this.config.get('apiUrl'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tracker-Token': this.config.get('trackerToken')
        },
        body: JSON.stringify(payload),
        keepalive: true
      });
      
      return response.status === 202;
    } catch (error) {
      this.logger.error('Direct send failed:', error);
      return false;
    }
  }

  async flushQueue() {
    this.worker?.postMessage({ type: 'FLUSH_QUEUE' });
  }

  getQueueSize() {
    if (!this.worker) return 0;
    
    this.worker.postMessage({ type: 'GET_QUEUE_SIZE' });
    return this.queueSize;
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.logger.log('Worker terminated');
    }
  }
}

/**
 * Extract UTM parameters from URL or provide defaults
 * @returns {Object} UTM parameters object
 */
function getUTMParams() {
  if (typeof window === 'undefined') {
    return getDefaultUTMParams();
  }

  const urlParams = new URLSearchParams(window.location.search);
  
  return {
    utm_campaign: urlParams.get('utm_campaign') || getSessionStorage('utm_campaign') || '',
    utm_source: urlParams.get('utm_source') || getSessionStorage('utm_source') || '',
    utm_medium: urlParams.get('utm_medium') || getSessionStorage('utm_medium') || '',
    utm_term: urlParams.get('utm_term') || getSessionStorage('utm_term') || '',
    utm_content: urlParams.get('utm_content') || getSessionStorage('utm_content') || ''
  };
}

/**
 * Store UTM parameters in session storage for persistence
 * @param {Object} utmParams UTM parameters
 */
function storeUTMParams(utmParams) {
  if (typeof window === 'undefined') return;

  Object.entries(utmParams).forEach(([key, value]) => {
    if (value && value !== 'direct' && value !== 'none') {
      try {
        sessionStorage.setItem(key, value);
      } catch (e) {
        // Silent fail if sessionStorage is not available
      }
    }
  });
}

/**
 * Get UTM parameter from session storage
 * @param {string} key Parameter key
 * @returns {string|null} Parameter value
 */
function getSessionStorage(key) {
  if (typeof window === 'undefined') return null;
  
  try {
    return sessionStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

/**
 * Get default UTM parameters for server-side or fallback
 * @returns {Object} Default UTM parameters
 */
function getDefaultUTMParams() {
  return {
    utm_campaign: '',
    utm_source: '',
    utm_medium: '',
    utm_term: '',
    utm_content: ''
  };
}

/**
 * Generate unique event ID
 * @returns {string} Unique event ID
 */
function generateEventId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  
  return 'evt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

class EventTracker {
  constructor(config, session, transport, logger) {
    this.config = config;
    this.session = session;
    this.transport = transport;
    this.logger = logger;
    this.sentEvents = new Map();
    this.utmParams = null;
    this.conversionRulesApplied = false;

    // Initialize and store UTM parameters
    this.initializeUTMParams();
  }

  /**
   * Initialize UTM parameters from URL
   */
  initializeUTMParams() {
    this.utmParams = getUTMParams();
    storeUTMParams(this.utmParams);
    this.logger.log("UTM parameters initialized:", this.utmParams);
  }

  /**
   * Send event with new v2 format
   * @param {string} event Event type
   * @param {Object} data Additional event data
   */
  send(event, data = {}) {
    if (!this.session.isActive()) {
      this.logger.error("Cannot send event without active session");
      return;
    }
    if (!this.state.get("isInitialized")) {
      this.logger.error(
        "Cannot send event: SDK is not initialized or API key is invalid."
      );
      return false;
    }
    const eventTypeMapping = {
      session_start: "page_view",
      page_view: "page_view",
      ping: "page_view",
      custom_event: "click",
      session_end: "conversion",
      button_click: "click",
      form_submit: "conversion",
      conversion: "conversion",
    };

    const mappedEventType = eventTypeMapping[event] || "click";
    const eventId = generateEventId();

    // Build v2 payload format
    const payload = {
      event: mappedEventType, // Maps to event_type in backend
      session_id: this.session.getId(),
      timestamp: new Date().toISOString(), // Maps to event_time in backend
      tracker_token: this.config.get("trackerToken"), // Maps to api_key in backend
      utm_params: this.utmParams, // MANDATORY for campaign resolution
      event_id: eventId,
      user_id: data.user_id || this.session.getId(), // Use session as fallback
      page_url:
        typeof window !== "undefined"
          ? window.location.href
          : data.page_url || "",
      referrer:
        typeof document !== "undefined"
          ? document.referrer
          : data.referrer || "",
      ...data, // Additional event-specific data
    };

    // Prevent duplicate events
    const eventKey = `${event}_${payload.timestamp}_${JSON.stringify(data)}`;

    if (this.sentEvents.has(eventKey)) {
      this.logger.warn("Duplicate event prevented:", event);
      return;
    }

    this.sentEvents.set(eventKey, Date.now());

    // Clean up old entries after 2 seconds
    setTimeout(() => {
      this.sentEvents.delete(eventKey);
    }, 2000);

    this.logger.log("Sending v2 event:", payload);
    this.transport.send(payload);

    // ✅ CHECK URL CONVERSIONS ON EVERY PAGE VIEW
    if (event === "page_view" || event === "session_start") {
      this.checkUrlConversions();
    }
  }

  /**
   * Track custom event with v2 format
   * @param {string} eventName Custom event name
   * @param {Object} data Event data
   */
  trackCustomEvent(eventName, data = {}) {
    this.send("custom_event", {
      event_name: eventName,
      event_data: data,
      custom_event_type: eventName,
      ...data,
    });

    this.logger.log("Custom event tracked:", eventName);
  }

  /**
   * Update UTM parameters (e.g., for SPA navigation)
   */
  refreshUTMParams() {
    this.utmParams = getUTMParams();
    storeUTMParams(this.utmParams);
    this.logger.log("UTM parameters refreshed:", this.utmParams);
  }
  applyConversionRules() {
    const rules = this.config.get("conversionRules") || [];

    if (!rules.length) {
      this.logger.warn(
        "No conversion rules found. Skipping conversion tracking."
      );
      return;
    }

    this.logger.log(`📋 Applying ${rules.length} conversion rules`);

    // Apply click-based rules (set up event listeners)
    rules.forEach((rule) => {
      if (rule.type === "click") {
        this.trackClickConversion(rule);
      }
    });

    // Check URL-based rules immediately
    this.checkUrlConversions();

    this.conversionRulesApplied = true;
  }

  // ✅ NEW METHOD: Check URL conversions (called on every page view)
  checkUrlConversions() {
    const rules = this.config.get("conversionRules") || [];
    const urlRules = rules.filter((r) => r.type === "url");

    if (urlRules.length === 0) return;

    const currentUrl = window.location.href;
    const currentPath = window.location.pathname;

    this.logger.log("🔍 Checking URL conversions for:", currentPath);

    urlRules.forEach((rule) => {
      let matched = false;
      const pattern = rule.pattern;

      switch (rule.match_type) {
        case "contains":
          matched =
            currentUrl.includes(pattern) || currentPath.includes(pattern);
          break;
        case "exact":
          matched = currentUrl === pattern || currentPath === pattern;
          break;
        case "starts_with":
          matched =
            currentUrl.startsWith(pattern) || currentPath.startsWith(pattern);
          break;
        case "ends_with":
          matched =
            currentUrl.endsWith(pattern) || currentPath.endsWith(pattern);
          break;
        case "regex":
          try {
            const regex = new RegExp(pattern);
            matched = regex.test(currentUrl) || regex.test(currentPath);
          } catch (e) {
            this.logger.error("Invalid regex pattern:", pattern, e);
          }
          break;
      }

      if (matched) {
        this.logger.log("🎯 URL conversion matched:", rule);
        this.send("conversion", {
          conversion_type: "url",
          conversion_label: rule.name,
          conversion_url: currentUrl,
          conversion_rule_id: rule.id,
          match_type: rule.match_type,
          pattern: pattern,
        });
      }
    });
  }

  trackUrlConversion(rule) {
    // This is now handled by checkUrlConversions()
    this.logger.warn(
      "trackUrlConversion is deprecated, use checkUrlConversions instead"
    );
  }

  trackClickConversion(rule) {
    this.logger.log("Setting up click conversion listener for:", rule.selector);

    document.addEventListener("click", (event) => {
      const target = event.target.closest(rule.selector);

      if (target) {
        this.logger.log("🎯 Click conversion matched:", rule);
        this.send("conversion", {
          conversion_type: "click",
          conversion_label: rule.name,
          conversion_selector: rule.selector,
          conversion_element: target.tagName,
          conversion_rule_id: rule.id,
          element_text: target.innerText?.substring(0, 100),
        });
      }
    });
  }
}

class PingTracker {
  constructor(config, state, eventTracker, logger) {
    this.config = config;
    this.state = state;
    this.eventTracker = eventTracker;
    this.logger = logger;
    this.timer = null;
  }

  
  start() {
    this.stop();

    const interval = this.config.get('pingInterval');
    
    this.timer = setInterval(() => {
      const seconds = interval / 1000;
      this.state.incrementTimeSpent(seconds);
      this.ping();
    }, interval);

    this.logger.log(`Ping timer started. Interval: ${interval / 1000}s`);
  }

  
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.log('Ping timer stopped');
    }
  }

  
  ping() {
    this.eventTracker.send('ping', {
      time_spent_seconds: this.state.get('timeSpent'),
      page_url: typeof window !== 'undefined' ? window.location.href : null,
      is_visible: typeof document !== 'undefined' ? !document.hidden : true
    });
  }

  
  trigger() {
    this.ping();
  }

  
  isRunning() {
    return this.timer !== null;
  }
}

class PageViewTracker {
  constructor(config, state, eventTracker, logger) {
    this.config = config;
    this.state = state;
    this.eventTracker = eventTracker;
    this.logger = logger;
  }

  
  track(pagePath) {
    const pageInfo = getPageInfo();
    
    if (pagePath) {
      pageInfo.page_path = pagePath;
    }

    this.eventTracker.send('page_view', pageInfo);
    this.state.set('lastPath', pageInfo.page_path);
    this.logger.log('Page view tracked:', pageInfo.page_path);
  }
}

class BrowserListeners {
  constructor(config, state, session, eventTracker, pingTracker, pageViewTracker, logger) {
    this.config = config;
    this.state = state;
    this.session = session;
    this.eventTracker = eventTracker;
    this.pingTracker = pingTracker;
    this.pageViewTracker = pageViewTracker;
    this.logger = logger;
  }

  setup() {
    if (typeof window === 'undefined') return;

    this.setupUnloadListener();
    this.setupVisibilityListener();
    
    this.setupClickTracking();
    
    if (this.config.get('autoTrack')) {
      this.setupNavigationListeners();
    }
  }

  setupUnloadListener() {
    window.addEventListener('beforeunload', () => {
      this.pingTracker.stop();
      this.eventTracker.send('session_end', {
        total_time_spent_seconds: this.state.get('timeSpent'),
        page_url: window.location.href
      });
      this.session.end();
    });
  }

  setupVisibilityListener() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.pingTracker.stop();
        this.logger.log('Page hidden, ping timer paused');
      } else {
        this.pingTracker.start();
        this.logger.log('Page visible, ping timer resumed');
      }
    });
  }

  setupClickTracking() {
    document.addEventListener('click', (e) => {
      const target = e.target;
      
      const elementInfo = {
        tag: target.tagName.toLowerCase(),
        id: target.id || null,
        class: target.className || null,
        text: target.innerText?.substring(0, 100) || null,
        href: target.href || null
      };

      if (target.tagName === 'BUTTON' || target.closest('button')) {
        this.eventTracker.send('button_click', {
          ...elementInfo,
          button_type: target.type || 'button'
        });
        this.logger.log('Button click tracked:', elementInfo);
      }
      
      else if (target.tagName === 'A' || target.closest('a')) {
        this.eventTracker.send('custom_event', {
          event_name: 'link_click',
          ...elementInfo,
          external: target.hostname !== window.location.hostname
        });
        this.logger.log('Link click tracked:', elementInfo);
      }
      
      else if (target.tagName === 'INPUT' && target.type === 'submit') {
        this.eventTracker.send('form_submit', {
          ...elementInfo,
          form_id: target.form?.id || null,
          form_name: target.form?.name || null
        });
        this.logger.log('Form submit tracked:', elementInfo);
      }
    }, true);

    this.logger.log('Automatic click tracking enabled');
  }

  setupNavigationListeners() {
    this.state.set('lastPath', window.location.pathname);

    const checkPathChange = () => {
      const currentPath = window.location.pathname;
      const lastPath = this.state.get('lastPath');
      
      if (currentPath !== lastPath) {
        this.pageViewTracker.track(currentPath);
      }
    };

    window.addEventListener('popstate', checkPathChange);

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function() {
      originalPushState.apply(this, arguments);
      checkPathChange();
    };

    history.replaceState = function() {
      originalReplaceState.apply(this, arguments);
      checkPathChange();
    };

    this.logger.log('SPA navigation tracking enabled');
  }
}

class CarbonCutSDK {
  constructor() {
    this.logger = new Logger(false);
    this.config = new Config();
    this.state = new State();
    this.session = null;
    this.transport = null;
    this.eventTracker = null;
    this.pingTracker = null;
    this.pageViewTracker = null;
    this.browserListeners = null;
    this.autoInitAttempted = false;
    this.conversionRules = [];
  }

  getScriptConfig() {
    if (typeof document === "undefined") return null;

    const scripts = document.getElementsByTagName("script");
    let scriptConfig = null;

    for (let script of scripts) {
      const src = script.getAttribute("src");

      if (
        src &&
        (src.includes("carboncut.min.js") || src.includes("carboncut.js"))
      ) {
        // Get base URL from data attribute
        let apiUrl =
          script.getAttribute("data-api-url") ||
          "http://127.0.0.1:8000/api/v1/events/";

        // Ensure trailing slash
        if (!apiUrl.endsWith("/")) {
          apiUrl += "/";
        }

        scriptConfig = {
          trackerToken:
            script.getAttribute("data-token") ||
            script.getAttribute("data-tracker-token"),
          apiUrl: apiUrl,
          debug: script.getAttribute("data-debug") === "true",
          domain: script.getAttribute("data-domain") || window.location.origin, // Default to current domain
          useWorker: script.getAttribute("data-use-worker") !== "false",
        };
        break;
      }
    }

    return scriptConfig;
  }

  async fetchConversionRules() {
    const apiUrl = this.config.get("apiUrl");
    const trackerToken = this.config.get("trackerToken");

    if (!trackerToken) {
      this.logger.error(
        "Tracker token is missing. Cannot fetch conversion rules."
      );
      return false; // Stop further processing
    }

    try {
      const configUrl = `${apiUrl.replace(
        "/events/",
        "/keys/config"
      )}?api_key=${trackerToken}`;

      this.logger.log("Fetching conversion rules from:", configUrl);

      const response = await fetch(configUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch conversion rules: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();

      if (!data.success) {
        this.logger.error("Invalid API key:", trackerToken);
        return false; // Stop further processing
      }

      this.conversionRules = data.conversion_rules || [];
      this.config.set("conversionRules", this.conversionRules);
      this.logger.log("✅ Fetched conversion rules:", this.conversionRules);

      // Apply rules after fetching
      if (this.eventTracker && this.conversionRules.length > 0) {
        this.eventTracker.applyConversionRules();
      }

      return true; // API key is valid
    } catch (error) {
      this.logger.error("Error fetching conversion rules:", error);
      return false; // Stop further processing
    }
  }

  autoInit() {
    if (this.autoInitAttempted || this.isInitializing) {
      this.logger.warn("Auto-init already attempted or in progress");
      return;
    }

    this.autoInitAttempted = true;
    this.isInitializing = true;

    const scriptConfig = this.getScriptConfig();

    if (!scriptConfig || !scriptConfig.trackerToken) {
      console.error(
        "CarbonCut: No tracker token found. Add data-token attribute to script tag."
      );
      this.isInitializing = false;
      return;
    }

    // Validate domain before initialization
    const currentDomain = window.location.origin; // Get the current domain (protocol + hostname + port)
    const configuredDomain = scriptConfig.domain;

    if (configuredDomain && configuredDomain !== currentDomain) {
      console.error(
        `CarbonCut: Invalid domain. Configured domain (${configuredDomain}) does not match the current domain (${currentDomain}).`
      );
      this.isInitializing = false;
      return;
    }

    this.init(scriptConfig);
    this.isInitializing = false;
  }

  async init(options = {}) {
  if (!isBrowser()) {
    this.logger.error("CarbonCut SDK can only be initialized in a browser environment");
    return false;
  }

  if (this.state.get("isInitialized")) {
    this.logger.warn("CarbonCut is already initialized");
    return false;
  }

  if (!this.config.init(options)) {
    return false;
  }

  this.logger.setDebug(this.config.get("debug"));

  if (this.config.get("respectDoNotTrack") && navigator.doNotTrack === "1") {
    this.logger.warn("Do Not Track is enabled, tracking disabled");
    return false;
  }

  // Validate API key
  const isValidApiKey = await this.fetchConversionRules();
  if (!isValidApiKey) {
    this.logger.error("Initialization aborted due to invalid API key.");
    return false; // Stop further processing
  }

  this.session = new Session(this.config, this.logger);

  const useWorker = this.config.get("useWorker") !== false;

  if (useWorker && typeof Worker !== "undefined") {
    this.transport = new ApiWorkerTransport(this.config, this.logger);
    this.logger.log("Using Web Worker for v2 event processing");
  } else {
    this.transport = new ApiTransport(this.config, this.logger);
    this.logger.log("Using main thread for v2 event processing");
  }

  this.eventTracker = new EventTracker(this.config, this.session, this.transport, this.logger);
  this.pingTracker = new PingTracker(this.config, this.state, this.eventTracker, this.logger);
  this.pageViewTracker = new PageViewTracker(this.config, this.state, this.eventTracker, this.logger);
  this.browserListeners = new BrowserListeners(
    this.config,
    this.state,
    this.session,
    this.eventTracker,
    this.pingTracker,
    this.pageViewTracker,
    this.logger
  );

  this.session.start();
  this.eventTracker.send("session_start", getBrowserMetadata());
  this.pingTracker.start();
  this.browserListeners.setup();
  this.state.set("isInitialized", true);

  this.logger.log("CarbonCut SDK v2 initialized successfully", {
    sessionId: this.session.getId(),
    trackerToken: this.config.get("trackerToken"),
    workerEnabled: useWorker,
    apiVersion: "v2",
  });

  return true;
}

  trackEvent(eventName, data = {}) {
    if (!this.state.get("isInitialized")) {
      this.logger.error("SDK not initialized. Call init() first");
      return;
    }

    this.eventTracker.trackCustomEvent(eventName, data);
  }

  trackPageView(pagePath) {
    if (!this.state.get("isInitialized")) {
      this.logger.error("SDK not initialized. Call init() first");
      return;
    }

    this.pageViewTracker.track(pagePath);
  }

  ping() {
    if (!this.state.get("isInitialized")) {
      this.logger.error("SDK not initialized. Call init() first");
      return;
    }

    this.pingTracker.trigger();
  }

  getSessionInfo() {
    return {
      sessionId: this.session?.getId() || null,
      trackerToken: this.config.get("trackerToken"),
      timeSpent: this.state.get("timeSpent"),
      isInitialized: this.state.get("isInitialized"),
      queueSize: this.transport?.getQueueSize() || 0,
      apiVersion: "v2",
      utmParams: this.eventTracker?.utmParams || null,
      conversionRules: this.conversionRules, // Add conversion rules to session info
    };
  }

  enableDebug() {
    this.logger.setDebug(true);
    this.config.set("debug", true);
  }

  disableDebug() {
    this.logger.setDebug(false);
    this.config.set("debug", false);
  }

  destroy() {
    this.pingTracker?.stop();
    this.transport?.terminate?.();
    this.session?.end();
    this.state.reset();
    this.logger.log("SDK destroyed");
  }
}

const carbonCut = new CarbonCutSDK();

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        carbonCut.autoInit();
      },
      { once: true }
    );
  } else {
    carbonCut.autoInit();
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = carbonCut;
}

if (typeof window !== "undefined") {
  window.CarbonCut = carbonCut;
}

module.exports = carbonCut;
//# sourceMappingURL=carboncut.cjs.js.map
