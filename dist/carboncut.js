var CarbonCut = (function () {
  'use strict';

  /**
   * Get tracker token from URL parameter
   * @returns {string|null} Tracker token
   */
  function getTrackerFromURL() {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    return params.get('cc_tracker');
  }

  /**
   * Get browser metadata
   * @returns {Object} Browser metadata
   */
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

  /**
   * Get current page info
   * @returns {Object} Page info
   */
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

  /**
   * Check if code is running in browser
   * @returns {boolean}
   */
  function isBrowser() {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
  }

  /**
   * Configuration manager
   */
  class Config {
    constructor() {
      this.defaults = {
        trackerToken: null,
        apiUrl: 'http://127.0.0.1:8000/api/v1/events/',
        sessionId: null,
        pingInterval: 15000, // 15 seconds
        debug: false,
        autoTrack: true, 
        respectDoNotTrack: true, 
        maxRetries: 3,
        retryDelay: 1000,
        domain: null,
      };
      
      this.config = { ...this.defaults };
    }

    /**
     * Initialize configuration
     * @param {Object} options User options
     * @returns {boolean} Success status
     */
    init(options = {}) {
      this.config = {
        ...this.defaults,
        ...options,
        trackerToken: options.trackerToken || getTrackerFromURL()
      };

      return this.validate();
    }

    /**
     * Validate configuration
     * @returns {boolean} Is valid
     */
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

    /**
     * Get configuration value
     * @param {string} key Configuration key
     * @returns {*} Configuration value
     */
    get(key) {
      return this.config[key];
    }

    /**
     * Set configuration value
     * @param {string} key Configuration key
     * @param {*} value Configuration value
     */
    set(key, value) {
      this.config[key] = value;
    }

    /**
     * Get all configuration
     * @returns {Object} All configuration
     */
    getAll() {
      return { ...this.config };
    }
  }

  /**
   * Global state management
   */
  class State {
    constructor() {
      this.state = {
        isInitialized: false,
        timeSpent: 0,
        lastPath: null,
        retryCount: 0
      };
    }

    /**
     * Get state value
     * @param {string} key State key
     * @returns {*} State value
     */
    get(key) {
      return this.state[key];
    }

    /**
     * Set state value
     * @param {string} key State key
     * @param {*} value State value
     */
    set(key, value) {
      this.state[key] = value;
    }

    /**
     * Increment time spent
     * @param {number} seconds Seconds to add
     */
    incrementTimeSpent(seconds) {
      this.state.timeSpent += seconds;
    }

    /**
     * Reset state
     */
    reset() {
      this.state = {
        isInitialized: false,
        timeSpent: 0,
        lastPath: null,
        retryCount: 0
      };
    }

    /**
     * Get all state
     * @returns {Object} All state
     */
    getAll() {
      return { ...this.state };
    }
  }

  /**
   * Generate a UUID v4
   * @returns {string} UUID
   */
  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    
    // Fallback for older browsers
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Session management
   */
  class Session {
    constructor(config, logger) {
      this.config = config;
      this.logger = logger;
      this.sessionId = null;
    }

    /**
     * Start a new session
     * @returns {string} Session ID
     */
    start() {
      this.sessionId = generateUUID();
      this.config.set('sessionId', this.sessionId);
      
      // Store in window for external access
      if (typeof window !== 'undefined') {
        window.__CC_SESSION_ID = this.sessionId;
        window.__CC_TRACKER_TOKEN = this.config.get('trackerToken');
      }
      
      this.logger.log('Session started:', this.sessionId);
      return this.sessionId;
    }

    /**
     * Get current session ID
     * @returns {string|null} Session ID
     */
    getId() {
      return this.sessionId;
    }

    /**
     * End current session
     */
    end() {
      this.logger.log('Session ended:', this.sessionId);
      this.sessionId = null;
      this.config.set('sessionId', null);
    }

    /**
     * Check if session is active
     * @returns {boolean} Is active
     */
    isActive() {
      return this.sessionId !== null;
    }
  }

  /**
   * Logger utility with debug mode support
   */
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

  /**
   * API transport layer
   */
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

    /**
     * Setup online/offline listener
     */
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

    /**
     * Send event to API
     * @param {Object} payload Event payload
     * @returns {Promise<boolean>} Success status
     */
    async send(payload) {
      if (!this.isOnline) {
        this.logger.warn('Offline, queueing event');
        this.queue.push(payload);
        return false;
      }

      const apiUrl = this.config.get('apiUrl');
      
      try {
        // Try sendBeacon first (for session_end and critical events)
        if (this.shouldUseSendBeacon(payload.event)) {
          const success = this.sendViaBeacon(apiUrl, payload);
          if (success) {
            this.logger.log('Event sent via sendBeacon:', payload.event);
            return true;
          }
        }

        // Fallback to fetch
        await this.sendViaFetch(apiUrl, payload);
        this.logger.log('Event sent via fetch:', payload.event);
        return true;

      } catch (error) {
        this.logger.error('Failed to send event:', error);
        this.queue.push(payload);
        return false;
      }
    }

    /**
     * Send via sendBeacon
     * @param {string} url API URL
     * @param {Object} payload Event payload
     * @returns {boolean} Success status
     */
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

    /**
     * Send via fetch
     * @param {string} url API URL
     * @param {Object} payload Event payload
     * @returns {Promise<Response>} Fetch response
     */
    async sendViaFetch(url, payload) {
      this.logger.log('Sending via fetch to:', url, payload);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tracker-Token': this.config.get('trackerToken')
        },
        body: JSON.stringify(payload),
        keepalive: true
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return response;
    }

    /**
     * Check if event should use sendBeacon
     * @param {string} eventType Event type
     * @returns {boolean} Should use sendBeacon
     */
    shouldUseSendBeacon(eventType) {
      return ['session_end', 'page_unload'].includes(eventType);
    }

    /**
     * Flush queued events
     */
    async flushQueue() {
      if (this.queue.length === 0) return;

      this.logger.log(`Flushing ${this.queue.length} queued events`);
      const queue = [...this.queue];
      this.queue = [];

      for (const payload of queue) {
        const success = await this.send(payload);
        if (!success) {
          // Re-queue if failed
          this.queue.push(payload);
        }
      }
    }

    /**
     * Get queue size
     * @returns {number} Queue size
     */
    getQueueSize() {
      return this.queue.length;
    }
  }

  /**
   * API Transport using Web Worker
   */
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

    /**
     * Check if Web Workers are supported
     */
    checkWorkerSupport() {
      return typeof Worker !== 'undefined';
    }

    /**
     * Initialize Web Worker
     */
    initWorker() {
      try {
        // Inline worker using Blob URL
        const workerCode = this.getWorkerCode();
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(blob);
        
        this.worker = new Worker(workerUrl);
        
        // Listen for messages from worker
        this.worker.addEventListener('message', (event) => {
          this.handleWorkerMessage(event.data);
        });
        
        // Listen for errors
        this.worker.addEventListener('error', (error) => {
          this.logger.error('Worker error:', error);
        });
        
        // Initialize worker with config
        this.worker.postMessage({
          type: 'INIT',
          payload: {
            apiUrl: this.config.get('apiUrl'),
            trackerToken: this.config.get('trackerToken'),
            batchSize: 10,
            batchInterval: 5000 // Flush every 5 seconds
          }
        });
        
        // Setup online/offline detection
        this.setupOnlineListener();
        
        this.logger.log('Web Worker initialized for event processing');
      } catch (error) {
        this.logger.error('Failed to initialize worker:', error);
        this.worker = null;
      }
    }

    /**
     * Get worker code as string
     */
    getWorkerCode() {
      // Return the worker code from event-worker.js as string
      // In production, this would be bundled separately
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
          const response = await fetch(config.apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Tracker-Token': config.trackerToken
            },
            body: JSON.stringify({ events: batch, batch: true }),
            keepalive: true
          });
          
          if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
          
          self.postMessage({ type: 'FLUSH_SUCCESS', count: batch.length });
        } catch (error) {
          eventQueue.push(...batch);
          self.postMessage({ type: 'FLUSH_ERROR', error: error.message, count: batch.length });
        }
      }
    `;
    }

    /**
     * Handle messages from worker
     */
    handleWorkerMessage(data) {
      const { type, count, error, size } = data;
      
      switch (type) {
        case 'INIT_SUCCESS':
          this.logger.log('Worker ready');
          break;
        
        case 'FLUSH_SUCCESS':
          this.logger.log(`Worker flushed ${count} events`);
          break;
        
        case 'FLUSH_ERROR':
          this.logger.error(`Worker flush failed: ${error}`);
          break;
        
        case 'QUEUE_SIZE':
          this.queueSize = size;
          break;
      }
    }

    /**
     * Setup online/offline listener
     */
    setupOnlineListener() {
      window.addEventListener('online', () => {
        this.worker?.postMessage({ type: 'ONLINE' });
      });

      window.addEventListener('offline', () => {
        this.worker?.postMessage({ type: 'OFFLINE' });
      });
    }

    /**
     * Send event (queued in worker)
     */
    async send(payload) {
      if (!this.worker) {
        // Fallback to direct fetch if worker not available
        return this.sendDirect(payload);
      }
      
      this.worker.postMessage({
        type: 'TRACK_EVENT',
        payload
      });
      
      return true; // Event queued in worker
    }

    /**
     * Direct send fallback (no worker)
     */
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
        
        return response.ok;
      } catch (error) {
        this.logger.error('Direct send failed:', error);
        return false;
      }
    }

    /**
     * Flush queue immediately
     */
    async flushQueue() {
      this.worker?.postMessage({ type: 'FLUSH_QUEUE' });
    }

    /**
     * Get queue size
     */
    getQueueSize() {
      if (!this.worker) return 0;
      
      this.worker.postMessage({ type: 'GET_QUEUE_SIZE' });
      return this.queueSize;
    }

    /**
     * Terminate worker
     */
    terminate() {
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
        this.logger.log('Worker terminated');
      }
    }
  }

  /**
   * Event tracker
   */
  class EventTracker {
    constructor(config, session, transport, logger) {
      this.config = config;
      this.session = session;
      this.transport = transport;
      this.logger = logger;
      this.sentEvents = new Map(); // ← ADD: Track sent events to prevent duplicates
    }

    /**
     * Send event to transport
     * @param {string} event Event type
     * @param {Object} data Event data
     */
    send(event, data = {}) {
      if (!this.session.isActive()) {
        this.logger.error('Cannot send event without active session');
        return;
      }

      const payload = {
        event,
        session_id: this.session.getId(),
        tracker_token: this.config.get('trackerToken'),
        timestamp: new Date().toISOString(),
        ...data
      };

      // Create unique event key to prevent duplicates
      const eventKey = `${event}_${payload.timestamp}_${JSON.stringify(data)}`;
      
      // Check if event was already sent in last 1 second
      if (this.sentEvents.has(eventKey)) {
        this.logger.warn('Duplicate event prevented:', event);
        return;
      }

      // Mark event as sent
      this.sentEvents.set(eventKey, Date.now());
      
      // Clean up old entries after 2 seconds
      setTimeout(() => {
        this.sentEvents.delete(eventKey);
      }, 2000);

      // Send to transport
      this.transport.send(payload);
    }

    /**
     * Track custom event
     * @param {string} eventName Custom event name
     * @param {Object} data Event data
     */
    trackCustomEvent(eventName, data = {}) {
      this.send('custom_event', {
        event_name: eventName,
        event_data: data,
        page_url: typeof window !== 'undefined' ? window.location.href : null
      });
      
      this.logger.log('Custom event tracked:', eventName);
    }
  }

  /**
   * Ping mechanism for time tracking
   */
  class PingTracker {
    constructor(config, state, eventTracker, logger) {
      this.config = config;
      this.state = state;
      this.eventTracker = eventTracker;
      this.logger = logger;
      this.timer = null;
    }

    /**
     * Start ping timer
     */
    start() {
      this.stop(); // Clear any existing timer

      const interval = this.config.get('pingInterval');
      
      this.timer = setInterval(() => {
        const seconds = interval / 1000;
        this.state.incrementTimeSpent(seconds);
        this.ping();
      }, interval);

      this.logger.log(`Ping timer started. Interval: ${interval / 1000}s`);
    }

    /**
     * Stop ping timer
     */
    stop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        this.logger.log('Ping timer stopped');
      }
    }

    /**
     * Send ping event
     */
    ping() {
      this.eventTracker.send('ping', {
        time_spent_seconds: this.state.get('timeSpent'),
        page_url: typeof window !== 'undefined' ? window.location.href : null,
        is_visible: typeof document !== 'undefined' ? !document.hidden : true
      });
    }

    /**
     * Manually trigger ping
     */
    trigger() {
      this.ping();
    }

    /**
     * Check if timer is running
     * @returns {boolean} Is running
     */
    isRunning() {
      return this.timer !== null;
    }
  }

  /**
   * Page view tracking
   */
  class PageViewTracker {
    constructor(config, state, eventTracker, logger) {
      this.config = config;
      this.state = state;
      this.eventTracker = eventTracker;
      this.logger = logger;
    }

    /**
     * Track page view
     * @param {string} pagePath Page path (optional)
     */
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

  /**
   * Browser event listeners
   */
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

    /**
     * Setup all browser event listeners
     */
    setup() {
      if (typeof window === 'undefined') return;

      this.setupUnloadListener();
      this.setupVisibilityListener();
      
      if (this.config.get('autoTrack')) {
        this.setupNavigationListeners();
      }
    }

    /**
     * Setup beforeunload listener
     */
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

    /**
     * Setup visibility change listener
     */
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

    /**
     * Setup navigation listeners for SPAs
     */
    setupNavigationListeners() {
      this.state.set('lastPath', window.location.pathname);

      const checkPathChange = () => {
        const currentPath = window.location.pathname;
        const lastPath = this.state.get('lastPath');
        
        if (currentPath !== lastPath) {
          this.pageViewTracker.track(currentPath);
        }
      };

      // Listen for history changes
      window.addEventListener('popstate', checkPathChange);

      // Intercept pushState and replaceState
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

  /**
   * CarbonCut SDK Main Class
   */
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
      this.googleAds = null;
      this.autoInitAttempted = false;
    }

    /**
     * Extract tracker token and domain from script tag
     * @returns {Object} Configuration from script tag
     */
    getScriptConfig() {
      // if (typeof document === 'undefined') return null;

      const scripts = document.getElementsByTagName('script');
      let scriptConfig = null;

      for (let script of scripts) {
        const src = script.getAttribute('src');
        
        if (src && (src.includes('carboncut.min.js') || src.includes('carboncut.js'))) {
          scriptConfig = {
            trackerToken: script.getAttribute('data-token') || script.getAttribute('data-tracker-token'),
            apiUrl: script.getAttribute('data-api-url') || 'http://127.0.0.1:8000/api/v1/events/',
            debug: script.getAttribute('data-debug') === 'true',
            domain: script.getAttribute('data-domain') || window.location.hostname,
            useWorker: script.getAttribute('data-use-worker') !== 'false' // Default true
          };
          break;
        }
      }

      return scriptConfig;
    }

    /**
     * Auto-initialize from script tag attributes
     */
    autoInit() {
      // Prevent multiple auto-init calls
      if (this.autoInitAttempted || this.isInitializing) {
        this.logger.warn('Auto-init already attempted or in progress');
        return;
      }
      
      this.autoInitAttempted = true;
      this.isInitializing = true;

      const scriptConfig = this.getScriptConfig();
      
      if (!scriptConfig || !scriptConfig.trackerToken) {
        console.error('CarbonCut: No tracker token found. Add data-token attribute to script tag.');
        this.isInitializing = false;
        return;
      }

      this.init(scriptConfig);
      this.isInitializing = false;
    }

    /**
     * Initialize the SDK
     */
    init(options = {}) {
      if (!isBrowser()) {
        this.logger.error('CarbonCut SDK can only be initialized in a browser environment');
        return false;
      }

      if (this.state.get('isInitialized')) {
        this.logger.warn('CarbonCut is already initialized');
        return false;
      }

      // Initialize configuration
      if (!this.config.init(options)) {
        return false;
      }

      // Set debug mode
      this.logger.setDebug(this.config.get('debug'));

      // Check Do Not Track
      if (this.config.get('respectDoNotTrack') && navigator.doNotTrack === '1') {
        this.logger.warn('Do Not Track is enabled, tracking disabled');
        return false;
      }

      // Initialize components
      this.session = new Session(this.config, this.logger);
      
      // Use Worker Transport if supported, fallback to regular transport
      const useWorker = this.config.get('useWorker') !== false; // Default true
      
      if (useWorker && typeof Worker !== 'undefined') {
        this.transport = new ApiWorkerTransport(this.config, this.logger);
        this.logger.log('Using Web Worker for event processing');
      } else {
        this.transport = new ApiTransport(this.config, this.logger);
        this.logger.log('Using main thread for event processing');
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


      // Start session
      this.session.start();

      // Send session start event
      this.eventTracker.send('session_start', getBrowserMetadata());

      // Start ping timer
      this.pingTracker.start();

      // Setup event listeners
      this.browserListeners.setup();

      // Mark as initialized
      this.state.set('isInitialized', true);

      this.logger.log('CarbonCut SDK initialized successfully', {
        sessionId: this.session.getId(),
        trackerToken: this.config.get('trackerToken'),
        workerEnabled: useWorker
      });

      // Auto-trigger Google Ads OAuth if enabled
      if (this.config.get('autoAuth')) {
        // Run OAuth in next tick to not block initialization
        setTimeout(() => {
          this.initiateGoogleAdsAuth();
        }, 0);
      }

      return true;
    }

    /**
     * Track a custom event
     * @param {string} eventName Event name
     * @param {Object} data Event data
     */
    trackEvent(eventName, data = {}) {
      if (!this.state.get('isInitialized')) {
        this.logger.error('SDK not initialized. Call init() first');
        return;
      }

      this.eventTracker.trackCustomEvent(eventName, data);
    }

    /**
     * Track a page view
     * @param {string} pagePath Page path
     */
    trackPageView(pagePath) {
      if (!this.state.get('isInitialized')) {
        this.logger.error('SDK not initialized. Call init() first');
        return;
      }

      this.pageViewTracker.track(pagePath);
    }

    /**
     * Manually trigger a ping
     */
    ping() {
      if (!this.state.get('isInitialized')) {
        this.logger.error('SDK not initialized. Call init() first');
        return;
      }

      this.pingTracker.trigger();
    }

    /**
     * Get session information
     * @returns {Object} Session info
     */
    getSessionInfo() {
      return {
        sessionId: this.session?.getId() || null,
        trackerToken: this.config.get('trackerToken'),
        timeSpent: this.state.get('timeSpent'),
        isInitialized: this.state.get('isInitialized'),
        queueSize: this.transport?.getQueueSize() || 0
      };
    }

    /**
     * Enable debug mode
     */
    enableDebug() {
      this.logger.setDebug(true);
      this.config.set('debug', true);
    }

    /**
     * Disable debug mode
     */
    disableDebug() {
      this.logger.setDebug(false);
      this.config.set('debug', false);
    }

    /**
     * Cleanup and terminate
     */
    destroy() {
      this.pingTracker?.stop();
      this.transport?.terminate?.(); // Terminate worker if exists
      this.session?.end();
      this.state.reset();
      this.logger.log('SDK destroyed');
    }
  }

  // Create singleton instance
  const carbonCut = new CarbonCutSDK();

  // Auto-initialize when DOM is ready (ONLY ONCE)
  if (typeof document !== 'undefined') {
    // Only attach listener if document is still loading
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        carbonCut.autoInit();
      }, { once: true }); // ← ADD 'once: true' to ensure single execution
    } else {
      // DOM already loaded, init immediately
      carbonCut.autoInit();
    }
  }

  // Export for different module systems
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = carbonCut;
  }

  if (typeof window !== 'undefined') {
    window.CarbonCut = carbonCut;
  }

  return carbonCut;

})();
//# sourceMappingURL=carboncut.js.map
