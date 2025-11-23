import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import csv from 'csv-parser';
import { createObjectCsvWriter } from 'csv-writer';
import * as cheerio from 'cheerio';
import cliProgress from 'cli-progress';
import winston from 'winston';
import dotenv from 'dotenv';
import path from 'path';
import pLimit from 'p-limit';

dotenv.config();

// Add stealth plugin to avoid bot detection
puppeteer.use(StealthPlugin());

// ==========================================
// CONFIGURATION
// ==========================================

const CONFIG = {
  // Processing Settings
  BATCH_SIZE: 10, // Concurrent pages to process
  RATE_LIMIT: 500, // 0.5 seconds between requests
  MAX_RETRIES: 3,

  // Directories
  SCREENSHOT_DIR: './screenshots',
  OUTPUT_FILE: 'landing_page_features.csv',
  CHECKPOINT_FILE: 'checkpoint_features.json',
};

// ==========================================
// DATA COLLECTOR CLASS
// ==========================================

class LandingPageDataCollector {
  constructor() {
    this.browser = null;
    this.limit = pLimit(CONFIG.BATCH_SIZE);
    this.processedUrls = new Set();
    this.results = [];
    this.progressBar = null;
    this.logger = this.setupLogger();
  }

  setupLogger() {
    return winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
      ),
      transports: [
        new winston.transports.File({ filename: 'data_collection.log' }),
        new winston.transports.Console({
          format: winston.format.simple(),
        })
      ]
    });
  }

  // Realistic user agents to rotate through
  getUserAgent() {
    const userAgents = [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  // Realistic viewport sizes to rotate through
  getViewport() {
    const viewports = [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1536, height: 864 },
      { width: 1440, height: 900 },
      { width: 2560, height: 1440 }
    ];
    return viewports[Math.floor(Math.random() * viewports.length)];
  }

  async initialize() {
    await fs.mkdir(CONFIG.SCREENSHOT_DIR, { recursive: true });
    await this.loadCheckpoint();

    // Launch with stealth settings to appear more human-like
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--lang=en-US,en;q=0.9'
      ]
    });

    this.logger.info('🚀 Landing Page Data Collector initialized with stealth mode');
  }

  async loadCheckpoint() {
    try {
      if (existsSync(CONFIG.CHECKPOINT_FILE)) {
        const checkpoint = await fs.readFile(CONFIG.CHECKPOINT_FILE, 'utf-8');
        const data = JSON.parse(checkpoint);
        this.processedUrls = new Set(data.processedUrls);
        this.results = data.results || [];
        this.logger.info(`✅ Loaded checkpoint: ${this.processedUrls.size} URLs already processed`);
      }
    } catch (error) {
      this.logger.error(`Failed to load checkpoint: ${error.message}`);
    }
  }

  async saveCheckpoint() {
    const checkpoint = {
      processedUrls: Array.from(this.processedUrls),
      results: this.results,
      timestamp: new Date().toISOString()
    };
    await fs.writeFile(CONFIG.CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
  }

  // Helper function to calculate reading level (Flesch-Kincaid)
  calculateReadingLevel(text) {
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
    const words = text.split(/\s+/).filter(w => w.length > 0).length;
    const syllables = text.split(/\s+/).reduce((count, word) => {
      return count + word.toLowerCase().split(/[aeiouy]+/).length - 1;
    }, 0);

    if (sentences === 0 || words === 0) return 0;

    const avgWordsPerSentence = words / sentences;
    const avgSyllablesPerWord = syllables / words;

    // Flesch-Kincaid Grade Level
    return Math.max(0, 0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59);
  }

  // Helper: Detect hero section using multiple strategies
  getHeroSection($) {
    // Strategy 1: Semantic hero classes
    let hero = $('.hero, .hero-section, [class*="hero-"], #hero');
    if (hero.length > 0) return hero.first();

    // Strategy 2: First major section with heading
    const firstSection = $('section').first();
    if (firstSection.find('h1, h2').length > 0) return firstSection;

    // Strategy 3: First element with large heading and CTA
    const topElements = $('header, section, div').filter((_i, el) => {
      const $el = $(el);
      return $el.find('h1, h2').length > 0 &&
             $el.find('button, a.btn, a.button, [role="button"]').length > 0;
    });
    if (topElements.length > 0) return topElements.first();

    // Strategy 4: Area containing first H1
    const h1Parent = $('h1').first().parent();
    if (h1Parent.length > 0) return h1Parent;

    // Fallback: empty jQuery object
    return $();
  }

  // Helper: Improved main content detection
  getMainContent($) {
    // Strategy 1: Semantic main/article tags
    let main = $('main, article, [role="main"]');
    if (main.length > 0) return main;

    // Strategy 2: Content area classes
    main = $('.content, .main-content, #content, #main, [class*="main-"], [class*="content-"]');
    if (main.length > 0) return main;

    // Strategy 3: Largest section by text content
    let largestSection = null;
    let maxLength = 0;
    $('section, article, div[class*="container"]').each((_i, el) => {
      const text = $(el).text().trim();
      if (text.length > maxLength) {
        maxLength = text.length;
        largestSection = $(el);
      }
    });
    if (largestSection) return largestSection;

    // Fallback: body
    return $('body');
  }

  // Helper: Detect sections using multiple strategies
  getSections($) {
    // Count semantic sections
    const semanticSections = $('section').length;

    // Also detect div-based sections with common patterns
    const divSections = $('div[class*="section"], div[id*="section"]').length;

    // Detect sections by structure (large divs with headings)
    const structuralSections = $('div').filter((_i, el) => {
      const $el = $(el);
      // Must have a heading and significant content
      return $el.find('h1, h2, h3').length > 0 &&
             $el.text().trim().split(/\s+/).length > 50 &&
             $el.children().length > 2;
    }).length;

    // Return the maximum as best estimate
    return Math.max(semanticSections, divSections, Math.min(structuralSections, 20));
  }

  // Helper: Intelligent Primary CTA Detection with Scoring
  getPrimaryCTA($, heroSection) {
    // Collect all potential CTAs
    const potentialCTAs = $('button, a.btn, a.button, a[class*="cta"], a[class*="button"], [role="button"]');

    let bestCTA = null;
    let bestScore = 0;

    potentialCTAs.each((i, el) => {
      const $el = $(el);
      const text = $el.text().trim().toLowerCase();
      const classes = ($el.attr('class') || '').toLowerCase();
      const href = ($el.attr('href') || '').toLowerCase();
      let score = 0;

      // ========================================
      // EXCLUSION FILTERS (reject non-CTAs)
      // ========================================

      // Exclude navigation/utility buttons
      const excludePatterns = [
        'close', 'menu', 'toggle', 'dismiss', 'cancel', 'back',
        'previous', 'next', 'slide', 'cookie', 'accept', 'decline',
        'search', 'filter', 'sort', 'expand', 'collapse', 'play', 'pause'
      ];

      if (excludePatterns.some(pattern => text.includes(pattern) || classes.includes(pattern))) {
        return; // Skip this element
      }

      // Exclude if text is too short or too long
      if (text.length < 2 || text.length > 100) {
        return;
      }

      // Exclude hidden elements
      const style = $el.attr('style') || '';
      if (style.includes('display:none') || style.includes('display: none')) {
        return;
      }

      // ========================================
      // SCORING SYSTEM
      // ========================================

      // 1. POSITION SCORING (Most Important)
      // ========================================

      // Is in hero section? (+30 points)
      if (heroSection.find($el).length > 0) {
        score += 30;
      }

      // Is in first screen/above fold containers? (+20 points)
      const aboveFoldContainers = $('.hero, .header, [class*="above-fold"], [class*="hero"], [class*="banner"], [id*="hero"]');
      if (aboveFoldContainers.find($el).length > 0) {
        score += 20;
      }

      // Is near top of page? (+10 points)
      const position = potentialCTAs.index($el);
      if (position <= 2) { // One of first 3 CTAs in DOM
        score += 10;
      }

      // 2. VISUAL PROMINENCE SCORING (Class-based)
      // ========================================

      // Primary/main CTA classes (+25 points)
      if (classes.match(/primary|main|cta-primary|btn-primary|hero-cta|main-cta/)) {
        score += 25;
      }

      // Accent/highlight classes (+15 points)
      if (classes.match(/accent|highlight|featured|emphasis/)) {
        score += 15;
      }

      // Large size indicators (+10 points)
      if (classes.match(/large|lg|big|xl/)) {
        score += 10;
      }

      // Solid/filled button (vs outline) (+8 points)
      if (classes.match(/solid|filled|btn-solid/) && !classes.match(/outline|ghost|hollow/)) {
        score += 8;
      }

      // Standalone CTA section (+10 points)
      if (classes.match(/cta-section|call-to-action|conversion/)) {
        score += 10;
      }

      // 3. TEXT PATTERN SCORING (Conversion Intent)
      // ========================================

      // Strong action verbs (+15 points)
      const strongVerbs = /^(get|start|try|download|claim|join|sign up|subscribe|buy|purchase|order|shop)/;
      if (text.match(strongVerbs)) {
        score += 15;
      }

      // Free trial/demo keywords (+12 points)
      if (text.match(/free trial|free demo|get started free|try.*free|demo/)) {
        score += 12;
      }

      // Request/contact actions (+10 points)
      if (text.match(/request|contact|talk to|schedule|book|reserve/)) {
        score += 10;
      }

      // Conversion-focused text (+8 points)
      if (text.match(/learn more|see how|discover|explore|find out/)) {
        score += 8;
      }

      // Contains "now" urgency (+5 points)
      if (text.match(/\bnow\b|\btoday\b/)) {
        score += 5;
      }

      // 4. TYPE SCORING (Element type)
      // ========================================

      // Actual button elements are usually more important than links (+5 points)
      if ($el.is('button')) {
        score += 5;
      }

      // Links with button-like classes (+3 points)
      if ($el.is('a') && classes.match(/btn|button/)) {
        score += 3;
      }

      // 5. HREF ANALYSIS (for <a> tags)
      // ========================================

      // Links to signup/pricing/demo pages (+10 points)
      if (href.match(/signup|sign-up|register|pricing|demo|trial|contact|get-started/)) {
        score += 10;
      }

      // External links to app/platform (+8 points)
      if (href.match(/app\.|platform\.|dashboard\.|console\./)) {
        score += 8;
      }

      // 6. SURROUNDING CONTEXT
      // ========================================

      // Is the only CTA in its container? (+5 points - likely primary)
      const parent = $el.parent();
      if (parent.find('button, a.btn, a.button, [role="button"]').length === 1) {
        score += 5;
      }

      // ========================================
      // UPDATE BEST CTA
      // ========================================

      if (score > bestScore) {
        bestScore = score;
        bestCTA = $el;
      }
    });

    // Return the best CTA info
    if (bestCTA) {
      return {
        text: bestCTA.text().trim().substring(0, 50),
        score: bestScore,
        classes: bestCTA.attr('class') || '',
        tag: bestCTA.prop('tagName').toLowerCase(),
        href: bestCTA.attr('href') || ''
      };
    }

    // Fallback: if no CTAs scored well, return null
    return {
      text: '',
      score: 0,
      classes: '',
      tag: '',
      href: ''
    };
  }

  async extractObjectiveFeatures(url) {
    const page = await this.browser.newPage();

    try {
      // Set random but realistic viewport
      const viewport = this.getViewport();
      await page.setViewport(viewport);

      // Set random but realistic user agent
      const userAgent = this.getUserAgent();
      await page.setUserAgent(userAgent);

      // Set additional headers to appear more human-like
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      });

      // Override navigator properties to hide automation
      await page.evaluateOnNewDocument(() => {
        // Override the navigator.webdriver property
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
        });

        // Override the navigator.plugins to appear more realistic
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });

        // Override navigator.languages to appear more realistic
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
        });

        // Add Chrome runtime (makes it look less like automation)
        window.chrome = {
          runtime: {},
        };

        // Override permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        );
      });

      // Navigate to page
      this.logger.info(`🌐 Loading: ${url}`);
      await page.goto(url, {
        waitUntil: 'domcontentloaded', // Changed from networkidle0 - more reliable for modern SPAs
        timeout: 30000
      });

      // Wait for dynamic content to load and appear human-like
      // Random delay between 2-4 seconds (allows JS to render + looks human)
      const randomDelay = 2000 + Math.random() * 2000;
      await new Promise(resolve => setTimeout(resolve, randomDelay));

      // Get viewport height for above-fold calculations
      const viewportHeight = await page.evaluate(() => window.innerHeight);

      // Extract HTML for parsing
      const html = await page.content();
      const $ = cheerio.load(html);

      // Remove script and style tags
      $('script').remove();
      $('style').remove();

      // Get all text for analysis
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

      // Use improved helpers for better detection
      const heroSection = this.getHeroSection($);
      const mainContentElement = this.getMainContent($);
      const mainContent = mainContentElement.text().replace(/\s+/g, ' ').trim();
      const sectionCount = this.getSections($);

      // Get primary CTA using intelligent detection
      const primaryCTA = this.getPrimaryCTA($, heroSection);

      // Improved CTA detection
      const allCTAs = $('button:not([type="submit"]):not([aria-label*="close"]):not([aria-label*="menu"]), ' +
                       'a.btn, a.button, a[class*="cta"], a[class*="button-"], ' +
                       '[role="button"]:not([aria-label*="close"]):not([aria-label*="menu"])');

      // Filter out likely non-CTAs
      const ctaElements = allCTAs.filter((_i, el) => {
        const text = $(el).text().trim().toLowerCase();
        const excludeWords = ['close', 'menu', 'toggle', 'dismiss', 'cancel', 'back', 'previous', 'next slide'];
        return !excludeWords.some(word => text.includes(word)) && text.length > 0 && text.length < 100;
      });

      // OBJECTIVE FEATURE EXTRACTION
      const features = {
        // === IDENTIFIERS ===
        url: url,

        // === CONTENT METRICS ===
        total_word_count: bodyText.split(/\s+/).filter(w => w.length > 0).length,
        main_content_word_count: mainContent.split(/\s+/).filter(w => w.length > 0).length,
        reading_level: this.calculateReadingLevel(mainContent),

        // === HEADLINE METRICS ===
        h1_count: $('h1').length,
        h2_count: $('h2').length,
        h3_count: $('h3').length,
        has_hero_headline: heroSection.find('h1, h2').length > 0 ? 1 : 0,
        headline_word_count: $('h1').first().text().trim().split(/\s+/).length,

        // === CTA METRICS (IMPROVED) ===
        total_cta_count: ctaElements.length,
        primary_cta_count: heroSection.find('button, a.btn, a.button, [role="button"]').length,
        form_count: $('form').length,
        form_field_count: $('form input[type!="hidden"], form textarea, form select').length,
        has_email_capture: $('input[type="email"], input[name*="email"], input[placeholder*="email" i]').length > 0 ? 1 : 0,

        // === VISUAL ELEMENTS (IMPROVED) ===
        total_image_count: $('img').length,
        hero_image_count: heroSection.find('img').length,
        has_hero_image: heroSection.find('img').length > 0 ? 1 : 0,
        video_count: $('video, iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="wistia"], iframe[src*="loom"]').length,
        has_video: $('video, iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="wistia"], iframe[src*="loom"]').length > 0 ? 1 : 0,
        svg_icon_count: $('svg').length,

        // === TRUST SIGNALS (IMPROVED) ===
        testimonial_count: $('.testimonial, [class*="testimonial"], [class*="review"], .quote, blockquote, ' +
                           '[data-testid*="testimonial"], [data-testid*="review"]').filter((_i, el) => {
          const text = $(el).text().trim();
          return text.length > 20 && text.length < 1000; // Reasonable testimonial length
        }).length,
        has_testimonials: $('.testimonial, [class*="testimonial"], [class*="review"]').length > 0 ? 1 : 0,
        rating_element_count: $('.rating, [class*="star"], [class*="rating"], [aria-label*="star"], [aria-label*="rating"]').length,
        trust_badge_count: (() => {
          // Strategy 1: Alt text based
          const altBased = $('img[alt*="secure" i], img[alt*="certified" i], img[alt*="badge" i], img[alt*="verified" i], ' +
                            'img[alt*="guarantee" i], img[alt*="trusted" i]').length;
          // Strategy 2: Src path based
          const srcBased = $('img[src*="badge"], img[src*="trust"], img[src*="secure"], img[src*="certified"]').length;
          // Strategy 3: Container based
          const containerBased = $('[class*="trust"], [class*="badge"], [class*="certification"]').find('img').length;
          return Math.max(altBased, srcBased, containerBased);
        })(),

        logo_count: (() => {
          // Strategy 1: Semantic containers
          const semanticBased = $('.logos img, .clients img, .partners img, [class*="logo-grid"] img, ' +
                                 '[class*="client"] img, [class*="partner"] img').length;
          // Strategy 2: Sections with "customer", "partner", or "client" headings
          const headingBased = $('h1, h2, h3, h4').filter((_i, el) =>
            $(el).text().match(/customers?|partners?|clients?|trusted by|used by/i)
          ).parent().find('img').length;
          // Strategy 3: Logo-specific attributes
          const attrBased = $('img[alt*="logo" i], img[class*="logo"], [data-testid*="logo"] img').length;
          return Math.max(semanticBased, headingBased, attrBased);
        })(),

        has_social_proof: (() => {
          // Strategy 1: Class-based detection
          const classBased = $('[class*="social-proof"], [class*="customer"], [class*="users"], [data-testid*="social"]').length > 0;
          // Strategy 2: Content-based - sections mentioning customer counts or testimonials
          const contentBased = bodyText.match(/\d+[,\d]*\s*(customers?|users?|companies|trusted by)/i) !== null;
          // Strategy 3: Has testimonials or customer logos
          const hasTestimonials = $('.testimonial, [class*="testimonial"], blockquote').length > 0;
          const hasLogos = $('.logos, [class*="client"], [class*="partner"]').find('img').length > 0;
          return (classBased || contentBased || hasTestimonials || hasLogos) ? 1 : 0;
        })(),

        // === STRUCTURE METRICS (IMPROVED) ===
        section_count: sectionCount,
        list_count: $('ul, ol').length,
        bullet_point_count: $('li').length,
        paragraph_count: $('p').length,
        link_count: $('a').length,

        // === FEATURE/BENEFIT INDICATORS (IMPROVED) ===
        feature_section_count: (() => {
          // Strategy 1: Class/ID based
          const classBased = $('.features, [class*="feature"], [id*="feature"], [data-section*="feature"]').length;
          // Strategy 2: Heading-based - sections with "feature" in heading
          const headingBased = $('section, div').filter((_i, el) => {
            const heading = $(el).find('h1, h2, h3, h4').first().text();
            return heading.match(/features?|capabilities|what's included|what you get/i);
          }).length;
          return Math.max(classBased, headingBased);
        })(),

        benefit_section_count: (() => {
          // Strategy 1: Class/ID based
          const classBased = $('.benefits, [class*="benefit"], [id*="benefit"], [data-section*="benefit"]').length;
          // Strategy 2: Heading-based - sections with "benefit" in heading
          const headingBased = $('section, div').filter((_i, el) => {
            const heading = $(el).find('h1, h2, h3, h4').first().text();
            return heading.match(/benefits?|why choose|advantages|what you'll get/i);
          }).length;
          return Math.max(classBased, headingBased);
        })(),

        pricing_section_present: (() => {
          // Strategy 1: Class/ID based
          const classBased = $('.pricing, [class*="pricing"], [id*="pricing"], [data-section*="pricing"]').length > 0;
          // Strategy 2: Heading-based
          const headingBased = $('h1, h2, h3, h4').filter((_i, el) =>
            $(el).text().match(/pricing|plans?|packages|costs?/i)
          ).length > 0;
          // Strategy 3: Price symbols present with structural elements
          const priceStructure = $('[class*="price"], [class*="plan"], [data-testid*="pricing"]').length > 0;
          return (classBased || headingBased || priceStructure) ? 1 : 0;
        })(),

        faq_section_present: (() => {
          // Strategy 1: Class/ID/data attributes
          const attrBased = $('.faq, [class*="faq"], [id*="faq"], [data-section*="faq"], [aria-label*="faq" i]').length > 0;
          // Strategy 2: Heading-based
          const headingBased = $('h1, h2, h3, h4').filter((_i, el) =>
            $(el).text().match(/faq|frequently asked|questions|Q&A/i)
          ).length > 0;
          // Strategy 3: Accordion/collapsible structure (common for FAQs)
          const structureBased = $('[class*="accordion"], [class*="collaps"], details, summary').length >= 3;
          return (attrBased || headingBased || structureBased) ? 1 : 0;
        })(),

        // === URGENCY/SCARCITY INDICATORS ===
        has_countdown: (() => {
          // Strategy 1: Class/data attribute based
          const attrBased = $('[class*="countdown"], [data-countdown], [id*="countdown"]').length > 0;
          // Strategy 2: Timer-related elements
          const timerBased = $('[class*="timer"], [class*="clock"], [data-timer]').length > 0;
          // Strategy 3: Script-based detection (countdown libraries)
          const scriptBased = $('script').filter((_i, el) =>
            $(el).html().match(/countdown|timer|setInterval/i)
          ).length > 0;
          return (attrBased || timerBased || scriptBased) ? 1 : 0;
        })(),
        has_limited_offer: (bodyText.match(/limited|exclusive|today only|act now/gi) || []).length,

        // === TECHNICAL SEO ===
        has_meta_description: !!$('meta[name="description"]').attr('content'),
        meta_description_length: ($('meta[name="description"]').attr('content') || '').length,
        has_og_tags: $('meta[property^="og:"]').length > 0 ? 1 : 0,
        has_structured_data: $('script[type="application/ld+json"]').length > 0 ? 1 : 0,
        title_length: $('title').text().trim().length,

        // === LAYOUT INDICATORS ===
        has_navigation: $('nav, [role="navigation"]').length > 0 ? 1 : 0,
        has_footer: $('footer').length > 0 ? 1 : 0,
        column_layout_count: $('.col, [class*="column"], [class*="grid"]').length,

        // === ENGAGEMENT ELEMENTS ===
        has_chat_widget: (() => {
          // Strategy 1: Class/ID based (Intercom, Drift, etc.)
          const classBased = $('[class*="chat"], [id*="chat"], [class*="intercom"], [class*="drift"], [id*="intercom"]').length > 0;
          // Strategy 2: iframe-based chat widgets
          const iframeBased = $('iframe[src*="chat"], iframe[src*="intercom"], iframe[src*="drift"], iframe[src*="zendesk"]').length > 0;
          // Strategy 3: Script-based detection
          const scriptBased = $('script').filter((_i, el) => {
            const src = $(el).attr('src') || '';
            const content = $(el).html() || '';
            return src.match(/intercom|drift|chat|zendesk|livechat/i) || content.match(/intercom|drift/i);
          }).length > 0;
          return (classBased || iframeBased || scriptBased) ? 1 : 0;
        })(),

        has_popup: (() => {
          // Strategy 1: Class-based detection
          const classBased = $('[class*="modal"], [class*="popup"], [class*="overlay"], [role="dialog"]').length > 0;
          // Strategy 2: Hidden modals (popups often start hidden)
          const hiddenModals = $('div').filter((_i, el) => {
            const classes = $(el).attr('class') || '';
            return classes.match(/modal|popup|overlay|dialog/i);
          }).length > 0;
          return (classBased || hiddenModals) ? 1 : 0;
        })(),

        animation_count: (() => {
          // Strategy 1: Animation libraries (AOS, Animate.css)
          const libraryBased = $('[class*="animate"], [data-aos], [class*="fade"], [class*="slide"]').length;
          // Strategy 2: CSS animation classes
          const cssBased = $('[class*="animation"], [class*="transition"]').length;
          return Math.max(libraryBased, cssBased);
        })(),

        // === COMPARISON/ALTERNATIVES ===
        has_comparison_table: (() => {
          // Strategy 1: Actual table elements
          const tableBased = $('table').filter((_i, el) => {
            // Check if table has multiple rows and columns (likely a comparison)
            const rows = $(el).find('tr').length;
            const cols = $(el).find('th, td').length;
            return rows >= 2 && cols >= 2;
          }).length > 0;
          // Strategy 2: Comparison class names
          const classBased = $('[class*="comparison"], [class*="compare"], [class*="vs"], [data-testid*="comparison"]').length > 0;
          // Strategy 3: Structural comparison (multiple columns with checkmarks/crosses)
          const structuralBased = $('[class*="feature-comparison"], [class*="pricing-table"], [class*="plan-comparison"]').length > 0;
          return (tableBased || classBased || structuralBased) ? 1 : 0;
        })(),

        // === MEDIA RICHNESS ===
        has_infographic: (() => {
          // Strategy 1: Alt text based
          const altBased = $('img[alt*="infographic" i], img[alt*="chart" i], img[alt*="graph" i], img[alt*="diagram" i]').length > 0;
          // Strategy 2: Src path based
          const srcBased = $('img[src*="infographic"], img[src*="chart"], img[src*="diagram"]').length > 0;
          // Strategy 3: Large images in content sections (likely infographics)
          const sizeBased = $('img').filter((_i, img) => {
            const src = $(img).attr('src') || '';
            const alt = $(img).attr('alt') || '';
            return (src.match(/data|visual|info/i) || alt.match(/data|visual|process|how it works/i));
          }).length > 0;
          return (altBased || srcBased || sizeBased) ? 1 : 0;
        })(),

        has_demo: (() => {
          // Strategy 1: Text mentions
          const textBased = bodyText.match(/demo|demonstration|watch demo|view demo|schedule demo/gi) !== null;
          // Strategy 2: CTA buttons for demo
          const ctaBased = $('button, a.btn, a.button').filter((_i, el) =>
            $(el).text().match(/demo|see it in action|watch|view demo/i)
          ).length > 0;
          // Strategy 3: Demo-specific sections or videos
          const sectionBased = $('[class*="demo"], [id*="demo"], iframe[src*="demo"]').length > 0;
          return (textBased || ctaBased || sectionBased) ? 1 : 0;
        })(),

        // === MOBILE OPTIMIZATION ===
        has_viewport_meta: !!$('meta[name="viewport"]').attr('content'),

        // === CRO TIER 1: ABOVE-THE-FOLD OPTIMIZATION ===
        above_fold_cta_count: await page.evaluate((vh) => {
          return Array.from(document.querySelectorAll('button, a.btn, a.button, [role="button"], .cta, [class*="cta-"]'))
            .filter(el => {
              const rect = el.getBoundingClientRect();
              return rect.top >= 0 && rect.top < vh;
            }).length;
        }, viewportHeight),

        above_fold_headline_visible: await page.evaluate((vh) => {
          const h1 = document.querySelector('h1');
          if (!h1) return 0;
          const rect = h1.getBoundingClientRect();
          return (rect.top >= 0 && rect.top < vh) ? 1 : 0;
        }, viewportHeight),

        above_fold_image_count: await page.evaluate((vh) => {
          return Array.from(document.querySelectorAll('img'))
            .filter(el => {
              const rect = el.getBoundingClientRect();
              return rect.top >= 0 && rect.top < vh;
            }).length;
        }, viewportHeight),

        hero_cta_text_length: heroSection.find('button, a.btn, a.button, [role="button"]').first().text().trim().length,

        // === CRO TIER 1: VALUE PROPOSITION CLARITY ===
        headline_contains_benefit: !!(
          $('h1').text().match(/save|get|free|instant|easy|fast|guaranteed|proven|better|best|more/i)
        ) ? 1 : 0,

        headline_contains_number: /\d+/.test($('h1').text()) ? 1 : 0,

        subheadline_present: heroSection.find('h2, .subheading, [class*="subhead"], p').length > 0 ? 1 : 0,

        subheadline_word_count: heroSection.find('h2, .subheading, [class*="subhead"], p').first().text().trim().split(/\s+/).filter(w => w.length > 0).length,

        // === CRO TIER 1: CTA QUALITY (Using Intelligent Primary CTA Detection) ===
        primary_cta_text: primaryCTA.text,
        primary_cta_confidence_score: primaryCTA.score,
        primary_cta_in_hero: primaryCTA.score >= 30 ? 1 : 0,
        primary_cta_is_button_element: primaryCTA.tag === 'button' ? 1 : 0,

        cta_uses_action_verb: !!(
          primaryCTA.text.toLowerCase().match(/^(get|start|try|download|claim|join|discover|learn|see|find|build|create|grow|sign|subscribe|buy|purchase)/)
        ) ? 1 : 0,

        cta_uses_first_person: !!(
          primaryCTA.text.match(/\b(my|I'm|I'll|me)\b/i)
        ) ? 1 : 0,

        // === CRO TIER 1: URGENCY & SCARCITY (Enhanced) ===
        specific_deadline_present: !!(bodyText.match(/\d+\s*(hours?|days?|minutes?)\s*(left|remaining)/i)) ? 1 : 0,

        stock_scarcity_present: !!(bodyText.match(/only\s+\d+\s+(left|remaining|in stock)/i)) ? 1 : 0,

        limited_spots_present: !!(bodyText.match(/\d+\s*(spots?|seats?)\s*(left|remaining|available)/i)) ? 1 : 0,

        expiring_offer_present: !!(bodyText.match(/expires?|ending|last chance|don't miss/i)) ? 1 : 0,

        // === CRO TIER 1: SOCIAL PROOF SPECIFICITY ===
        testimonial_has_photo: (() => {
          // Find testimonial containers
          const testimonials = $('.testimonial, [class*="testimonial"], [class*="review"], blockquote, [data-testid*="testimonial"]');
          // Check if any contain images that aren't icons/small decorative images
          return testimonials.find('img').filter((_i, img) => {
            const src = $(img).attr('src') || '';
            const alt = $(img).attr('alt') || '';
            // Exclude obvious icons/decorative images
            return !src.match(/icon|logo|star|rating/i) && !alt.match(/icon|logo|star|rating/i);
          }).length > 0 ? 1 : 0;
        })(),

        testimonial_has_name: !!(
          $('.testimonial, [class*="testimonial"], [class*="review"], blockquote, [data-testid*="testimonial"]')
            .text().match(/[-–—]\s*[A-Z][a-z]+\s+[A-Z]|by\s+[A-Z][a-z]+\s+[A-Z]/)
        ) ? 1 : 0,

        customer_count_mentioned: !!(bodyText.match(/\d+[,\d]*\s*(customers?|users?|clients?|companies|businesses)/i)) ? 1 : 0,

        customer_count_value: (bodyText.match(/(\d+)[,\d]*\s*(?:k|thousand|million|customers?|users?|clients?|companies)/i) || [])[1] || null,

        case_study_present: (() => {
          // Strategy 1: Class-based detection
          const classBased = $('[class*="case-study"], [class*="case_study"], [class*="success-story"], [class*="customer-story"]').length > 0;
          // Strategy 2: Content-based detection - sections with "case study" heading or title
          const contentBased = $('h1, h2, h3, h4, [class*="title"], [class*="heading"]')
            .filter((_i, el) => $(el).text().match(/case study|success story|customer story/i)).length > 0;
          // Strategy 3: Link to case studies
          const linkBased = $('a[href*="case-study"], a[href*="case_study"], a[href*="success-story"]').length > 0;
          return (classBased || contentBased || linkBased) ? 1 : 0;
        })(),

        // === CRO TIER 2: TRUST & SECURITY ===
        money_back_guarantee: !!(bodyText.match(/money.back|refund|guarantee|risk.free/i)) ? 1 : 0,

        free_trial_mentioned: !!(bodyText.match(/free trial|try free|no credit card|start free/i)) ? 1 : 0,

        ssl_visible: (() => {
          // Strategy 1: Badge images
          const imgBased = $('img[alt*="SSL" i], img[alt*="secure" i], img[src*="ssl"], img[src*="secure"]').length > 0;
          // Strategy 2: Text mentions with icons/badges
          const textBased = $('[class*="secure"], [class*="ssl"], [class*="badge"]')
            .filter((_i, el) => $(el).text().match(/SSL|secure|encrypted|256-bit/i)).length > 0;
          return (imgBased || textBased) ? 1 : 0;
        })(),

        privacy_policy_linked: !!$('a[href*="privacy"], a[href*="Privacy"]').length ? 1 : 0,

        terms_conditions_linked: !!$('a[href*="terms"], a[href*="Terms"]').length ? 1 : 0,

        bbb_accredited: !!$('img[alt*="BBB" i], img[alt*="Better Business" i], img[src*="bbb"], a[href*="bbb.org"]').length ? 1 : 0,

        review_platform_badges: (() => {
          // Detect specific review platform badges (G2, Capterra, Software Advice, GetApp)
          const badges = {
            g2: false,
            capterra: false,
            software_advice: false,
            getapp: false
          };

          // Strategy 1: Image alt text
          const images = $('img');
          images.each((_i, img) => {
            const alt = $(img).attr('alt') || '';
            const src = $(img).attr('src') || '';
            const combined = (alt + ' ' + src).toLowerCase();

            if (combined.match(/\bg2\b|g2\.com|g2crowd/i)) badges.g2 = true;
            if (combined.match(/capterra/i)) badges.capterra = true;
            if (combined.match(/software.?advice|softwareadvice/i)) badges.software_advice = true;
            if (combined.match(/getapp/i)) badges.getapp = true;
          });

          // Strategy 2: Links to review platforms
          const links = $('a');
          links.each((_i, link) => {
            const href = $(link).attr('href') || '';
            const text = $(link).text().toLowerCase();
            const combined = (href + ' ' + text).toLowerCase();

            if (combined.match(/\bg2\b|g2\.com|g2crowd/i)) badges.g2 = true;
            if (combined.match(/capterra/i)) badges.capterra = true;
            if (combined.match(/software.?advice|softwareadvice/i)) badges.software_advice = true;
            if (combined.match(/getapp/i)) badges.getapp = true;
          });

          // Strategy 3: Text mentions with badge/award context
          const badgeContainers = $('[class*="badge"], [class*="award"], [class*="review"], [class*="rating"]');
          badgeContainers.each((_i, el) => {
            const text = $(el).text().toLowerCase();

            if (text.match(/\bg2\b|g2\.com|g2crowd/i)) badges.g2 = true;
            if (text.match(/capterra/i)) badges.capterra = true;
            if (text.match(/software.?advice|softwareadvice/i)) badges.software_advice = true;
            if (text.match(/getapp/i)) badges.getapp = true;
          });

          // Return count of platforms present
          return Object.values(badges).filter(v => v).length;
        })(),

        has_g2_badge: (() => {
          const alt = $('img[alt*="G2" i]').length > 0;
          const src = $('img[src*="g2" i]').length > 0;
          const link = $('a[href*="g2.com"], a[href*="g2crowd"]').length > 0;
          return (alt || src || link) ? 1 : 0;
        })(),

        has_capterra_badge: (() => {
          const alt = $('img[alt*="Capterra" i]').length > 0;
          const src = $('img[src*="capterra" i]').length > 0;
          const link = $('a[href*="capterra.com"]').length > 0;
          return (alt || src || link) ? 1 : 0;
        })(),

        has_software_advice_badge: (() => {
          const alt = $('img[alt*="Software Advice" i]').length > 0;
          const src = $('img[src*="softwareadvice" i]').length > 0;
          const link = $('a[href*="softwareadvice.com"]').length > 0;
          return (alt || src || link) ? 1 : 0;
        })(),

        has_getapp_badge: (() => {
          const alt = $('img[alt*="GetApp" i]').length > 0;
          const src = $('img[src*="getapp" i]').length > 0;
          const link = $('a[href*="getapp.com"]').length > 0;
          return (alt || src || link) ? 1 : 0;
        })(),

        security_badges_count: $('img[alt*="secure" i], img[alt*="verified" i], img[alt*="trusted" i], img[alt*="Norton" i], img[alt*="McAfee" i], ' +
                               'img[src*="secure"], img[src*="verified"], img[src*="norton"], img[src*="mcafee"], ' +
                               '[class*="badge"][class*="secure"], [class*="badge"][class*="trust"]').length,

        // === CRO TIER 2: FRICTION REDUCERS ===
        no_credit_card_required: !!(bodyText.match(/no credit card|free forever|cancel anytime|no payment/i)) ? 1 : 0,

        instant_access_mentioned: !!(bodyText.match(/instant|immediate|instant access|download now|get started now/i)) ? 1 : 0,

        form_field_labels_visible: $('form label').length >= $('form input[type!="hidden"]').length ? 1 : 0,

        social_login_available: (() => {
          // Strategy 1: Button/link with social provider text
          const textBased = $('button, a, [role="button"]')
            .filter((_i, el) => $(el).text().match(/sign in with|continue with|login with/i)).length > 0;
          // Strategy 2: Elements with social provider classes/hrefs
          const classBased = $('[class*="google"], [class*="facebook"], [class*="linkedin"], ' +
                              '[href*="google"], [href*="facebook"], [href*="linkedin"]')
            .filter('button, a, [role="button"]').length > 0;
          // Strategy 3: OAuth-related attributes
          const oauthBased = $('[data-provider], [data-oauth]').length > 0;
          return (textBased || classBased || oauthBased) ? 1 : 0;
        })(),

        // === CRO TIER 2: BENEFIT VS FEATURE RATIO ===
        benefit_word_count: (bodyText.match(/you'll|you can|helps you|help you|save time|increase|reduce|faster|easier|better|improve/gi) || []).length,

        feature_word_count: (bodyText.match(/includes|features|our product|we offer|contains|provides|specifications/gi) || []).length,

        benefit_to_feature_ratio: null, // Will calculate after

        // === CRO TIER 2: MOBILE OPTIMIZATION SIGNALS ===
        clickable_phone_number: (() => {
          // Strategy 1: tel: links
          const telBased = $('a[href^="tel:"]').length > 0;
          // Strategy 2: Phone number pattern with link
          const patternBased = $('a').filter((_i, el) => {
            const text = $(el).text();
            return text.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
          }).length > 0;
          return (telBased || patternBased) ? 1 : 0;
        })(),

        click_to_call_button: (() => {
          // Strategy 1: Button/CTA with tel: href
          const hrefBased = $('button[onclick*="tel:"], a.btn[href^="tel:"], a.button[href^="tel:"]').length > 0;
          // Strategy 2: Button with "call" text and phone icon
          const textBased = $('button, a.btn, a.button, [role="button"]').filter((_i, el) =>
            $(el).text().match(/call|phone|contact us/i)
          ).length > 0;
          return (hrefBased || textBased) ? 1 : 0;
        })(),

        mobile_menu_present: (() => {
          // Strategy 1: Class-based detection (hamburger, mobile menu)
          const classBased = $('[class*="mobile-menu"], [class*="hamburger"], [class*="nav-toggle"], ' +
                             '[class*="menu-toggle"], [class*="sidebar-toggle"]').length > 0;
          // Strategy 2: Aria attributes for mobile navigation
          const ariaBased = $('[aria-label*="menu" i], [aria-label*="navigation" i]').filter('button').length > 0;
          // Strategy 3: Icon-based (common hamburger icons)
          const iconBased = $('button').filter((_i, el) => {
            const html = $(el).html();
            return html.match(/☰|≡|三/) || $(el).find('[class*="bar"]').length === 3;
          }).length > 0;
          return (classBased || ariaBased || iconBased) ? 1 : 0;
        })(),

        // === CRO TIER 2: OFFER DETAILS ===
        price_mentioned: /\$\d+|\d+\s*USD|€\d+|£\d+/.test(bodyText) ? 1 : 0,

        discount_percentage: (bodyText.match(/(\d+)%\s*off/i) || [])[1] || null,

        free_shipping_mentioned: !!(bodyText.match(/free shipping|free delivery/i)) ? 1 : 0,

        bonus_offer_present: !!(bodyText.match(/bonus|extra|plus|also get|included/i)) ? 1 : 0,

        // === CRO TIER 3: CONTENT SCANABILITY ===
        has_bullet_points_above_fold: await page.evaluate((vh) => {
          return Array.from(document.querySelectorAll('ul li, ol li'))
            .filter(el => {
              const rect = el.getBoundingClientRect();
              return rect.top >= 0 && rect.top < vh;
            }).length;
        }, viewportHeight),

        average_paragraph_length: $('p').map((_i, el) => {
          const text = $(el).text().trim();
          return text.split(/\s+/).filter(w => w.length > 0).length;
        }).get().reduce((sum, len) => sum + len, 0) / ($('p').length || 1),

        // === CRO TIER 3: EXIT INTENT & RETENTION ===
        exit_popup_present: await page.evaluate(() => {
          // Strategy 1: Exit-related class names
          const classBased = document.querySelectorAll('[class*="exit"], [id*="exit"], [class*="exit-intent"]').length > 0;
          // Strategy 2: Hidden modals (exit popups are typically hidden by default)
          const hiddenModals = Array.from(document.querySelectorAll('[class*="modal"], [class*="popup"], [class*="overlay"]'))
            .filter(el => {
              const style = window.getComputedStyle(el);
              return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
            }).length > 0;
          // Strategy 3: Script tags mentioning exit intent
          const scriptBased = Array.from(document.querySelectorAll('script'))
            .some(script => script.textContent.match(/exit|exitintent|mouseout/i));
          return (classBased || hiddenModals || scriptBased) ? 1 : 0;
        }),

        sticky_header: await page.evaluate(() => {
          const header = document.querySelector('header, nav, [role="banner"]');
          if (!header) return 0;
          const style = window.getComputedStyle(header);
          return (style.position === 'fixed' || style.position === 'sticky') ? 1 : 0;
        }),

        sticky_cta: await page.evaluate(() => {
          // Strategy 1: Class-based detection
          const classBased = document.querySelectorAll('[class*="sticky"][class*="cta"], [class*="sticky"][class*="button"], ' +
                                                       '[class*="fixed"][class*="cta"], [class*="fixed"][class*="button"]').length > 0;
          // Strategy 2: Computed style detection - check for fixed/sticky CTAs
          const styleBased = Array.from(document.querySelectorAll('button, a.btn, a.button, [role="button"], .cta'))
            .some(el => {
              const style = window.getComputedStyle(el);
              return style.position === 'fixed' || style.position === 'sticky';
            });
          return (classBased || styleBased) ? 1 : 0;
        }),

        // === RATIOS (derived features) ===
        cta_to_content_ratio: null, // Will calculate after
        image_to_text_ratio: null,
        testimonial_to_section_ratio: null,

        // === METADATA ===
        page_title: $('title').text().trim(),
        processed_at: new Date().toISOString()
      };

      // Calculate ratios
      features.cta_to_content_ratio = features.main_content_word_count > 0
        ? (features.total_cta_count / features.main_content_word_count * 1000).toFixed(2)
        : 0;

      features.image_to_text_ratio = features.main_content_word_count > 0
        ? (features.total_image_count / features.main_content_word_count * 1000).toFixed(2)
        : 0;

      features.testimonial_to_section_ratio = features.section_count > 0
        ? (features.testimonial_count / features.section_count).toFixed(2)
        : 0;

      features.benefit_to_feature_ratio = features.feature_word_count > 0
        ? (features.benefit_word_count / features.feature_word_count).toFixed(2)
        : 0;

      await page.close();
      return features;

    } catch (error) {
      await page.close();
      throw error;
    }
  }

  async processUrl(url, conversionRate = null, brandPopularity = null) {
    // Skip if already processed
    if (this.processedUrls.has(url)) {
      this.logger.info(`⏭️ Skipping already processed: ${url}`);
      return null;
    }

    let retries = 0;
    while (retries < CONFIG.MAX_RETRIES) {
      try {
        // Extract features
        const features = await this.extractObjectiveFeatures(url);

        // --- Identify internal pages (Capterra/GDM built) ---
        let isInternal = 0;
        
        try {
          const hostname = new URL(url).hostname.toLowerCase();
          if (
            hostname === "landing.capterra.com" ||
            hostname === "info.gartnerdigitalmarkets.com"
          ) {
            isInternal = 1;
          }
        } catch (e) {
          // fallback if URL parsing fails
          isInternal = 0;
        }
        
        // attach flag to your feature row
        features.IsInternal = isInternal;


        // Add target variables if provided
        if (conversionRate !== null) {
          features.conversion_rate = conversionRate;
        }
        if (brandPopularity !== null) {
          features.brand_popularity = brandPopularity;
        }

        // Rate limiting with randomization (appear more human-like)
        const randomRateLimit = CONFIG.RATE_LIMIT + Math.random() * 1000; // Add 0-1s variation
        await new Promise(resolve => setTimeout(resolve, randomRateLimit));

        this.processedUrls.add(url);
        this.results.push(features);

        // Update progress
        if (this.progressBar) {
          this.progressBar.increment();
        }

        this.logger.info(`✅ Extracted features: ${url}`);

        // Save checkpoint every 50 URLs
        if (this.results.length % 50 === 0) {
          await this.saveCheckpoint();
          await this.saveResults();
          this.logger.info(`💾 Checkpoint saved`);
        }

        return features;

      } catch (error) {
        retries++;
        this.logger.error(`❌ Error processing ${url} (attempt ${retries}): ${error.message}`);

        if (retries >= CONFIG.MAX_RETRIES) {
          const errorResult = {
            url,
            error: error.message,
            processed_at: new Date().toISOString()
          };
          this.results.push(errorResult);
          this.processedUrls.add(url);
          return errorResult;
        }

        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  async processCSV(inputFile) {
    const data = [];

    // Read all rows from CSV
    await new Promise((resolve, reject) => {
      createReadStream(inputFile)
        .pipe(csv())
        .on('data', (row) => {
          const url = row.url || row.URL || row.landing_page || row.page_url;
          const conversionRate = parseFloat(row.conversion_rate || row.cr || row.cvr) || null;
          const brandPopularity = parseFloat(row.brand_popularity || row.popularity) || null;

          if (url && !this.processedUrls.has(url)) {
            data.push({ url, conversionRate, brandPopularity });
          }
        })
        .on('end', resolve)
        .on('error', reject);
    });

    this.logger.info(`\n📊 LANDING PAGE DATA COLLECTION`);
    this.logger.info(`════════════════════════════════════════`);
    this.logger.info(`📄 Total URLs to process: ${data.length}`);
    this.logger.info(`⏱️ Estimated time: ${Math.ceil(data.length * CONFIG.RATE_LIMIT / 1000 / 60)} minutes`);
    this.logger.info(`════════════════════════════════════════\n`);

    // Initialize progress bar
    this.progressBar = new cliProgress.SingleBar(
      {
        format: '🔄 Progress |{bar}| {percentage}% | {value}/{total} Pages | ETA: {eta}s',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true
      },
      cliProgress.Presets.shades_classic
    );
    this.progressBar.start(data.length, 0);

    // Process URLs with concurrency limit
    const processingPromises = data.map(({ url, conversionRate, brandPopularity }) =>
      this.limit(() => this.processUrl(url, conversionRate, brandPopularity))
    );

    await Promise.all(processingPromises);

    this.progressBar.stop();

    // Save final results
    await this.saveCheckpoint();
    await this.saveResults();

    this.logger.info(`\n✅ DATA COLLECTION COMPLETE!`);
    this.logger.info(`════════════════════════════════════════`);
    this.logger.info(`📊 Pages processed: ${this.results.filter(r => !r.error).length}`);
    this.logger.info(`📁 Results saved to: ${CONFIG.OUTPUT_FILE}`);
    this.logger.info(`════════════════════════════════════════\n`);
  }

  async saveResults() {
    // Get all unique keys from results
    const allKeys = new Set();
    this.results.forEach(result => {
      Object.keys(result).forEach(key => allKeys.add(key));
    });

    // Sort keys but ensure 'url' is first
    const sortedKeys = Array.from(allKeys).sort();
    const urlIndex = sortedKeys.indexOf('url');
    if (urlIndex > -1) {
      sortedKeys.splice(urlIndex, 1); // Remove 'url' from its position
      sortedKeys.unshift('url'); // Add 'url' to the beginning
    }

    // Create header mapping
    const header = sortedKeys.map(key => ({
      id: key,
      title: key.toUpperCase().replace(/_/g, ' ')
    }));

    const csvWriter = createObjectCsvWriter({
      path: CONFIG.OUTPUT_FILE,
      header: header
    });

    await csvWriter.writeRecords(this.results);
    this.logger.info(`📁 Results saved to ${CONFIG.OUTPUT_FILE}`);
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}

// ==========================================
// MAIN EXECUTION
// ==========================================

async function main() {
  const args = process.argv.slice(2);

  if (!args[0]) {
    console.log('\n🚀 LANDING PAGE DATA COLLECTOR');
    console.log('══════════════════════════════════════\n');
    console.log('Extracts objective, quantifiable features from landing pages');
    console.log('for use in regression models.\n');
    console.log('USAGE:');
    console.log('  node data-collector.js <csv_file>\n');
    console.log('CSV FORMAT:');
    console.log('  Required: url');
    console.log('  Optional: conversion_rate, brand_popularity\n');
    console.log('EXAMPLE:');
    console.log('  node data-collector.js landing_pages_with_metrics.csv\n');
    process.exit(0);
  }

  const collector = new LandingPageDataCollector();

  try {
    await collector.initialize();
    await collector.processCSV(args[0]);
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
  } finally {
    await collector.cleanup();
  }
}

main().catch(console.error);

export { LandingPageDataCollector };
