import OpenAI from 'openai';
import puppeteer from 'puppeteer';
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

// ==========================================
// CONFIGURATION
// ==========================================

const CONFIG = {
  // OpenAI Settings
  MODEL: 'gpt-4o-mini', // Using GPT-4o-mini - fast, affordable, excellent quality

  // Processing Settings
  BATCH_SIZE: 5, // Concurrent pages to process (lower for OpenAI rate limits)
  RATE_LIMIT: 1000, // 1 second between API calls
  MAX_RETRIES: 3,

  // Directories
  SCREENSHOT_DIR: './screenshots',
  CACHE_DIR: './cache',
  OUTPUT_FILE: 'landing_page_analysis_gpt.csv',
  CHECKPOINT_FILE: 'checkpoint_gpt.json',

  // Cost Tracking (GPT-4o-mini pricing)
  COST_PER_1M_INPUT: 0.15,  // $0.15 per million input tokens
  COST_PER_1M_OUTPUT: 0.60, // $0.60 per million output tokens
};

// ==========================================
// CRO SCORING SCHEMA
// ==========================================

const SCORING_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "object",
      properties: {
        headline_value_prop: { 
          type: "number", 
          minimum: 1, 
          maximum: 10,
          description: "Clear and compelling headline and value proposition"
        },
        benefit_focused_content: { 
          type: "number", 
          minimum: 1, 
          maximum: 10,
          description: "Benefit-focused content and descriptions"
        },
        call_to_action: { 
          type: "number", 
          minimum: 1, 
          maximum: 10,
          description: "Strong and clear call-to-action elements"
        },
        visuals_interactive: { 
          type: "number", 
          minimum: 1, 
          maximum: 10,
          description: "High-quality visuals and interactive elements"
        },
        trust_social_proof: { 
          type: "number", 
          minimum: 1, 
          maximum: 10,
          description: "Trust elements and social proof"
        }
      },
      required: ["headline_value_prop", "benefit_focused_content", "call_to_action", "visuals_interactive", "trust_social_proof"]
    },
    total_score: { 
      type: "number",
      description: "Sum of all individual scores (max 50)"
    },
    insights: {
      type: "object",
      properties: {
        strongest_element: { type: "string" },
        weakest_element: { type: "string" },
        quick_wins: {
          type: "array",
          items: { type: "string" },
          maxItems: 3
        }
      }
    },
    recommendations: {
      type: "object",
      properties: {
        headline: { type: "string", maxLength: 200 },
        content: { type: "string", maxLength: 200 },
        cta: { type: "string", maxLength: 200 },
        visuals: { type: "string", maxLength: 200 },
        trust: { type: "string", maxLength: 200 }
      }
    }
  },
  required: ["scores", "total_score", "insights", "recommendations"]
};

// ==========================================
// MAIN ANALYZER CLASS
// ==========================================

class LandingPageAnalyzer {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    this.browser = null;
    this.limit = pLimit(CONFIG.BATCH_SIZE);
    this.processedUrls = new Set();
    this.results = [];
    this.progressBar = null;
    this.logger = this.setupLogger();
    this.costTracker = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCost: 0,
      pagesAnalyzed: 0
    };
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
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'gemini3_analysis.log' }),
        new winston.transports.Console({
          format: winston.format.simple(),
        })
      ]
    });
  }

  async initialize() {
    // Create necessary directories
    await fs.mkdir(CONFIG.SCREENSHOT_DIR, { recursive: true });
    await fs.mkdir(CONFIG.CACHE_DIR, { recursive: true });
    
    // Load checkpoint if exists
    await this.loadCheckpoint();
    
    // Launch Puppeteer browser
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    
    this.logger.info('🚀 GPT-4 Landing Page Analyzer initialized');
    this.logger.info(`📊 Model: ${CONFIG.MODEL}`);
    this.logger.info(`💰 Pricing: $${CONFIG.COST_PER_1M_INPUT}/1M input, $${CONFIG.COST_PER_1M_OUTPUT}/1M output`);
  }

  async loadCheckpoint() {
    try {
      if (existsSync(CONFIG.CHECKPOINT_FILE)) {
        const checkpoint = await fs.readFile(CONFIG.CHECKPOINT_FILE, 'utf-8');
        const data = JSON.parse(checkpoint);
        this.processedUrls = new Set(data.processedUrls);
        this.results = data.results || [];
        this.costTracker = data.costTracker || this.costTracker;
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
      costTracker: this.costTracker,
      timestamp: new Date().toISOString()
    };
    await fs.writeFile(CONFIG.CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
  }

  async scrapePageContent(url) {
    const page = await this.browser.newPage();
    
    try {
      // Configure page
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      
      // Navigate to page
      this.logger.info(`🌐 Loading: ${url}`);
      await page.goto(url, { 
        waitUntil: 'networkidle0',
        timeout: 30000 
      });
      
      // Wait for content to stabilize
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Take screenshot
      const screenshotFilename = `${Buffer.from(url).toString('base64').substring(0, 30)}.png`;
      const screenshotPath = path.join(CONFIG.SCREENSHOT_DIR, screenshotFilename);
      await page.screenshot({ 
        path: screenshotPath,
        fullPage: false // Just viewport for analysis
      });
      
      // Extract page content and metrics
      const html = await page.content();
      const $ = cheerio.load(html);
      
      // Remove script and style tags for cleaner text
      $('script').remove();
      $('style').remove();
      
      // Extract comprehensive page data for CRO analysis
      const pageData = {
        url,
        title: $('title').text().trim(),
        metaDescription: $('meta[name="description"]').attr('content') || '',
        
        // Headlines and value propositions
        headlines: {
          h1: $('h1').map((_, el) => $(el).text().trim()).get().slice(0, 5),
          h2: $('h2').map((_, el) => $(el).text().trim()).get().slice(0, 8),
          hero: $('.hero h1, .hero-section h1, [class*="hero"] h1').first().text().trim(),
          subheadline: $('.hero h2, .hero-section h2, [class*="hero"] h2, .subtitle, .subheadline').first().text().trim()
        },
        
        // Call-to-action elements
        ctas: {
          buttons: $('button, a.btn, a.button, [role="button"], .cta, [class*="cta-"]')
            .map((_, el) => ({
              text: $(el).text().trim(),
              href: $(el).attr('href') || '',
              prominence: $(el).parents('.hero, header, [class*="hero"]').length > 0 ? 'primary' : 'secondary'
            }))
            .get()
            .filter(cta => cta.text.length > 0 && cta.text.length < 50)
            .slice(0, 15),
          forms: $('form').length,
          formFields: $('form input[type!="hidden"], form textarea, form select').length
        },
        
        // Visual and interactive elements
        visuals: {
          images: $('img').length,
          heroImages: $('.hero img, .hero-section img, [class*="hero"] img').length,
          videos: $('video, iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="wistia"]').length,
          animations: $('[class*="animate"], [data-aos], .fade-in, .slide-in').length,
          icons: $('i, svg, [class*="icon"]').length
        },
        
        // Trust and social proof elements
        trust: {
          testimonials: $('.testimonial, [class*="testimonial"], [class*="review"], .quote, blockquote').length,
          ratings: $('.rating, [class*="star"], [class*="rating"]').length,
          badges: $('img[alt*="secure"], img[alt*="certified"], img[alt*="badge"], [class*="badge"], [class*="trust"], [class*="secure"]').length,
          logos: $('.logos, .clients, .partners, [class*="logo-grid"], [class*="client"]').length,
          socialProof: $('[class*="social-proof"], [class*="customer"], [class*="users"]').length
        },
        
        // Benefits and features
        benefits: {
          bulletPoints: $('ul li, ol li').map((_, el) => $(el).text().trim()).get()
            .filter(text => text.length > 10 && text.length < 150)
            .slice(0, 20),
          featureSections: $('.features, .benefits, [class*="feature"], [class*="benefit"]').length,
          valueProps: $('[class*="value"], [class*="benefit"], [class*="advantage"]').length
        },
        
        // Page content samples
        content: {
          firstParagraph: $('p').first().text().trim().substring(0, 500),
          mainContent: $('main, .content, article, [role="main"]').text().replace(/\s+/g, ' ').trim().substring(0, 2000),
          aboveFold: $('body').text().replace(/\s+/g, ' ').trim().substring(0, 1000)
        },
        
        // Technical SEO elements
        seo: {
          hasH1: $('h1').length > 0,
          h1Count: $('h1').length,
          hasMetaDescription: !!$('meta[name="description"]').attr('content'),
          hasOpenGraph: $('meta[property^="og:"]').length > 0,
          hasStructuredData: $('script[type="application/ld+json"]').length > 0
        },
        
        screenshotPath
      };
      
      await page.close();
      return pageData;
      
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  createCROAnalysisPrompt(pageData) {
    return `You are an expert Conversion Rate Optimization (CRO) specialist analyzing landing pages. 
Evaluate this landing page based on CRO best practices and provide detailed scoring.

URL: ${pageData.url}
Page Title: ${pageData.title}
Meta Description: ${pageData.metaDescription}

HEADLINE ANALYSIS:
- H1 Tags (${pageData.headlines.h1.length} found): ${pageData.headlines.h1.slice(0, 3).join(' | ')}
- Hero Headline: ${pageData.headlines.hero || 'Not found'}
- Subheadline: ${pageData.headlines.subheadline || 'Not found'}

CALL-TO-ACTION ANALYSIS:
- Primary CTAs: ${pageData.ctas.buttons.filter(b => b.prominence === 'primary').map(b => b.text).join(', ')}
- Total Buttons/CTAs: ${pageData.ctas.buttons.length}
- Forms: ${pageData.ctas.forms} forms with ${pageData.ctas.formFields} total fields

VISUAL & INTERACTIVE ELEMENTS:
- Total Images: ${pageData.visuals.images} (${pageData.visuals.heroImages} in hero section)
- Videos: ${pageData.visuals.videos}
- Interactive Elements: ${pageData.visuals.animations} animations/transitions
- Icons: ${pageData.visuals.icons}

TRUST & SOCIAL PROOF:
- Testimonials/Reviews: ${pageData.trust.testimonials}
- Trust Badges: ${pageData.trust.badges}
- Client Logos: ${pageData.trust.logos}
- Social Proof Elements: ${pageData.trust.socialProof}
- Rating Elements: ${pageData.trust.ratings}

BENEFITS & VALUE PROPOSITION:
- Feature/Benefit Sections: ${pageData.benefits.featureSections}
- Value Proposition Elements: ${pageData.benefits.valueProps}
- Key Benefits Listed: ${pageData.benefits.bulletPoints.slice(0, 5).join('; ')}

CONTENT SAMPLE:
First Paragraph: ${pageData.content.firstParagraph}

Above-the-fold Content: ${pageData.content.aboveFold}

TECHNICAL FACTORS:
- Has Single H1: ${pageData.seo.hasH1 && pageData.seo.h1Count === 1 ? 'Yes' : `No (${pageData.seo.h1Count} H1s)`}
- Meta Description: ${pageData.seo.hasMetaDescription ? 'Yes' : 'No'}
- Open Graph Tags: ${pageData.seo.hasOpenGraph ? 'Yes' : 'No'}
- Structured Data: ${pageData.seo.hasStructuredData ? 'Yes' : 'No'}

SCORING TASK:
Grade each element on a 1-10 scale based on CRO best practices:

1. **Clear and Compelling Headline and Value Proposition** (1-10)
   - Is the main headline clear and benefit-focused?
   - Does it communicate the unique value proposition?
   - Is it prominent and immediately visible?

2. **Benefit-Focused Content and Description** (1-10)
   - Does the content focus on benefits vs features?
   - Is the value clear to the target audience?
   - Are benefits specific and compelling?

3. **Strong Call-to-Action** (1-10)
   - Are CTAs clear and action-oriented?
   - Do they stand out visually?
   - Are they placed strategically?

4. **High-Quality Visuals and Interactive Elements** (1-10)
   - Do visuals support the message?
   - Is the design professional and trustworthy?
   - Are there engaging interactive elements?

5. **Trust Elements and Social Proof** (1-10)
   - Are there testimonials, reviews, or case studies?
   - Are trust badges and certifications displayed?
   - Is social proof prominently featured?

Provide specific, actionable recommendations for each category.
Focus on quick wins that could improve conversion rates.
Be critical but constructive in your analysis.`;
  }

  async analyzeWithGPT(pageData) {
    const prompt = this.createCROAnalysisPrompt(pageData);

    try {
      this.logger.info(`🤖 Analyzing with ${CONFIG.MODEL}`);

      const completion = await this.openai.chat.completions.create({
        model: CONFIG.MODEL,
        messages: [
          {
            role: "system",
            content: "You are an expert Conversion Rate Optimization (CRO) specialist. Analyze landing pages and return your analysis as valid JSON only, with no additional text or markdown formatting."
          },
          {
            role: "user",
            content: prompt + '\n\nReturn ONLY valid JSON matching this structure:\n' + JSON.stringify(SCORING_SCHEMA, null, 2)
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.7,
        max_tokens: 2048
      });

      const text = completion.choices[0].message.content;
      const analysis = JSON.parse(text);

      // Get actual token usage from OpenAI
      const inputTokens = completion.usage.prompt_tokens;
      const outputTokens = completion.usage.completion_tokens;

      // Update cost tracking
      this.costTracker.totalInputTokens += inputTokens;
      this.costTracker.totalOutputTokens += outputTokens;
      this.costTracker.estimatedCost =
        (this.costTracker.totalInputTokens / 1000000 * CONFIG.COST_PER_1M_INPUT) +
        (this.costTracker.totalOutputTokens / 1000000 * CONFIG.COST_PER_1M_OUTPUT);
      this.costTracker.pagesAnalyzed++;

      return analysis;

    } catch (error) {
      this.logger.error(`GPT analysis failed for ${pageData.url}: ${error.message}`);
      throw error;
    }
  }

  async processUrl(url) {
    // Skip if already processed
    if (this.processedUrls.has(url)) {
      this.logger.info(`⏭️ Skipping already processed: ${url}`);
      return null;
    }

    let retries = 0;
    while (retries < CONFIG.MAX_RETRIES) {
      try {
        // Scrape page content
        const pageData = await this.scrapePageContent(url);
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, CONFIG.RATE_LIMIT));

        // Analyze with GPT
        const analysis = await this.analyzeWithGPT(pageData);
        
        // Compile results
        const result = {
          url,
          title: pageData.title,
          
          // Individual scores
          headline_score: analysis.scores.headline_value_prop,
          content_score: analysis.scores.benefit_focused_content,
          cta_score: analysis.scores.call_to_action,
          visuals_score: analysis.scores.visuals_interactive,
          trust_score: analysis.scores.trust_social_proof,
          total_score: analysis.total_score,
          
          // Insights
          strongest_element: analysis.insights.strongest_element,
          weakest_element: analysis.insights.weakest_element,
          quick_win_1: analysis.insights.quick_wins[0] || '',
          quick_win_2: analysis.insights.quick_wins[1] || '',
          quick_win_3: analysis.insights.quick_wins[2] || '',
          
          // Specific recommendations
          headline_recommendation: analysis.recommendations.headline,
          content_recommendation: analysis.recommendations.content,
          cta_recommendation: analysis.recommendations.cta,
          visuals_recommendation: analysis.recommendations.visuals,
          trust_recommendation: analysis.recommendations.trust,
          
          // Metadata
          has_hero: !!pageData.headlines.hero,
          cta_count: pageData.ctas.buttons.length,
          form_count: pageData.ctas.forms,
          testimonial_count: pageData.trust.testimonials,
          image_count: pageData.visuals.images,
          processed_at: new Date().toISOString()
        };
        
        this.processedUrls.add(url);
        this.results.push(result);
        
        // Update progress
        if (this.progressBar) {
          this.progressBar.increment();
        }
        
        // Log success
        this.logger.info(`✅ Analyzed: ${url} | Score: ${result.total_score}/50`);
        
        // Save checkpoint every 25 URLs
        if (this.results.length % 25 === 0) {
          await this.saveCheckpoint();
          await this.saveResults();
          this.logger.info(`💾 Checkpoint saved | Cost so far: $${this.costTracker.estimatedCost.toFixed(2)}`);
        }
        
        return result;
        
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
    const urls = [];
    
    // Read all URLs from CSV
    await new Promise((resolve, reject) => {
      createReadStream(inputFile)
        .pipe(csv())
        .on('data', (row) => {
          const url = row.url || row.URL || row.landing_page || row.page_url;
          if (url && !this.processedUrls.has(url)) {
            urls.push(url);
          }
        })
        .on('end', resolve)
        .on('error', reject);
    });
    
    this.logger.info(`\n📊 GPT-4 LANDING PAGE ANALYSIS`);
    this.logger.info(`════════════════════════════════════════`);
    this.logger.info(`📄 Total URLs to process: ${urls.length}`);
    this.logger.info(`💰 Estimated cost: $${(urls.length * 0.002).toFixed(2)} - $${(urls.length * 0.005).toFixed(2)}`);
    this.logger.info(`⏱️ Estimated time: ${Math.ceil(urls.length * CONFIG.RATE_LIMIT / 1000 / 60)} minutes`);
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
    this.progressBar.start(urls.length, 0);
    
    // Process URLs with concurrency limit
    const processingPromises = urls.map((url, index) => 
      this.limit(() => this.processUrl(url))
    );
    
    await Promise.all(processingPromises);
    
    this.progressBar.stop();
    
    // Save final results
    await this.saveCheckpoint();
    await this.saveResults();
    
    // Generate summary report
    await this.generateSummaryReport();
    
    this.logger.info(`\n✅ ANALYSIS COMPLETE!`);
    this.logger.info(`════════════════════════════════════════`);
    this.logger.info(`📊 Pages analyzed: ${this.costTracker.pagesAnalyzed}`);
    this.logger.info(`💰 Total cost: $${this.costTracker.estimatedCost.toFixed(2)}`);
    this.logger.info(`📁 Results saved to: ${CONFIG.OUTPUT_FILE}`);
    this.logger.info(`════════════════════════════════════════\n`);
  }

  async saveResults() {
    const csvWriter = createObjectCsvWriter({
      path: CONFIG.OUTPUT_FILE,
      header: [
        { id: 'url', title: 'URL' },
        { id: 'title', title: 'Page Title' },
        { id: 'headline_score', title: 'Headline Score' },
        { id: 'content_score', title: 'Content Score' },
        { id: 'cta_score', title: 'CTA Score' },
        { id: 'visuals_score', title: 'Visuals Score' },
        { id: 'trust_score', title: 'Trust Score' },
        { id: 'total_score', title: 'Total Score' },
        { id: 'strongest_element', title: 'Strongest Element' },
        { id: 'weakest_element', title: 'Weakest Element' },
        { id: 'quick_win_1', title: 'Quick Win 1' },
        { id: 'quick_win_2', title: 'Quick Win 2' },
        { id: 'quick_win_3', title: 'Quick Win 3' },
        { id: 'headline_recommendation', title: 'Headline Rec' },
        { id: 'content_recommendation', title: 'Content Rec' },
        { id: 'cta_recommendation', title: 'CTA Rec' },
        { id: 'visuals_recommendation', title: 'Visuals Rec' },
        { id: 'trust_recommendation', title: 'Trust Rec' },
        { id: 'has_hero', title: 'Has Hero' },
        { id: 'cta_count', title: 'CTA Count' },
        { id: 'form_count', title: 'Form Count' },
        { id: 'testimonial_count', title: 'Testimonials' },
        { id: 'image_count', title: 'Images' },
        { id: 'processed_at', title: 'Processed At' },
        { id: 'error', title: 'Error' }
      ]
    });
    
    await csvWriter.writeRecords(this.results);
    this.logger.info(`📁 Results saved to ${CONFIG.OUTPUT_FILE}`);
  }

  async generateSummaryReport() {
    const validResults = this.results.filter(r => !r.error);
    
    if (validResults.length === 0) return;
    
    // Calculate statistics
    const avgScores = {
      headline: (validResults.reduce((sum, r) => sum + (r.headline_score || 0), 0) / validResults.length).toFixed(1),
      content: (validResults.reduce((sum, r) => sum + (r.content_score || 0), 0) / validResults.length).toFixed(1),
      cta: (validResults.reduce((sum, r) => sum + (r.cta_score || 0), 0) / validResults.length).toFixed(1),
      visuals: (validResults.reduce((sum, r) => sum + (r.visuals_score || 0), 0) / validResults.length).toFixed(1),
      trust: (validResults.reduce((sum, r) => sum + (r.trust_score || 0), 0) / validResults.length).toFixed(1),
      total: (validResults.reduce((sum, r) => sum + (r.total_score || 0), 0) / validResults.length).toFixed(1)
    };
    
    // Find top and bottom performers
    const sortedByScore = [...validResults].sort((a, b) => (b.total_score || 0) - (a.total_score || 0));
    
    // Count common issues
    const weakElements = {};
    validResults.forEach(r => {
      if (r.weakest_element) {
        weakElements[r.weakest_element] = (weakElements[r.weakest_element] || 0) + 1;
      }
    });
    
    const summary = {
      analysis_date: new Date().toISOString(),
      model_used: CONFIG.MODEL,
      
      statistics: {
        total_pages_analyzed: validResults.length,
        pages_with_errors: this.results.filter(r => r.error).length,
        average_processing_time: `${CONFIG.RATE_LIMIT / 1000}s per page`,
        total_cost: `$${this.costTracker.estimatedCost.toFixed(2)}`,
        cost_per_page: `$${(this.costTracker.estimatedCost / validResults.length).toFixed(4)}`
      },
      
      average_scores: avgScores,
      
      score_distribution: {
        excellent: validResults.filter(r => r.total_score >= 40).length,
        good: validResults.filter(r => r.total_score >= 30 && r.total_score < 40).length,
        average: validResults.filter(r => r.total_score >= 20 && r.total_score < 30).length,
        poor: validResults.filter(r => r.total_score < 20).length
      },
      
      top_10_performers: sortedByScore.slice(0, 10).map(r => ({
        url: r.url,
        score: r.total_score,
        strongest: r.strongest_element
      })),
      
      bottom_10_performers: sortedByScore.slice(-10).map(r => ({
        url: r.url,
        score: r.total_score,
        weakest: r.weakest_element,
        quick_win: r.quick_win_1
      })),
      
      common_weaknesses: Object.entries(weakElements)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([element, count]) => ({
          element,
          frequency: count,
          percentage: `${((count / validResults.length) * 100).toFixed(1)}%`
        })),
      
      improvement_priorities: {
        critical: validResults.filter(r => r.total_score < 20).map(r => r.url),
        high: validResults.filter(r => r.total_score >= 20 && r.total_score < 25).map(r => r.url),
        medium: validResults.filter(r => r.total_score >= 25 && r.total_score < 30).map(r => r.url)
      }
    };
    
    // Save summary report
    await fs.writeFile('gemini3_analysis_summary.json', JSON.stringify(summary, null, 2));
    
    // Print summary to console
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║      ANALYSIS SUMMARY REPORT           ║');
    console.log('╚════════════════════════════════════════╝\n');
    
    console.log('📊 AVERAGE SCORES (out of 10):');
    console.log(`   Headline & Value Prop: ${avgScores.headline}`);
    console.log(`   Benefit-Focused Content: ${avgScores.content}`);
    console.log(`   Call-to-Action: ${avgScores.cta}`);
    console.log(`   Visuals & Interactive: ${avgScores.visuals}`);
    console.log(`   Trust & Social Proof: ${avgScores.trust}`);
    console.log(`   📈 OVERALL AVERAGE: ${avgScores.total}/50\n`);
    
    console.log('📈 SCORE DISTRIBUTION:');
    console.log(`   Excellent (40-50): ${summary.score_distribution.excellent} pages`);
    console.log(`   Good (30-39): ${summary.score_distribution.good} pages`);
    console.log(`   Average (20-29): ${summary.score_distribution.average} pages`);
    console.log(`   Poor (<20): ${summary.score_distribution.poor} pages\n`);
    
    console.log('🎯 TOP 3 PERFORMERS:');
    summary.top_10_performers.slice(0, 3).forEach((page, i) => {
      console.log(`   ${i + 1}. ${page.url} (Score: ${page.score}/50)`);
    });
    
    console.log('\n⚠️ BOTTOM 3 PERFORMERS:');
    summary.bottom_10_performers.slice(0, 3).forEach((page, i) => {
      console.log(`   ${i + 1}. ${page.url} (Score: ${page.score}/50)`);
      console.log(`      Quick Win: ${page.quick_win}`);
    });
    
    console.log('\n🔍 MOST COMMON WEAKNESSES:');
    summary.common_weaknesses.forEach(weakness => {
      console.log(`   • ${weakness.element}: ${weakness.frequency} pages (${weakness.percentage})`);
    });
    
    console.log('\n📝 Full report saved to: gemini3_analysis_summary.json');
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}

// ==========================================
// TEST SINGLE URL FUNCTION
// ==========================================

async function testSingleUrl(url) {
  console.log('\n🧪 TESTING SINGLE URL WITH GPT-4\n');

  const analyzer = new LandingPageAnalyzer();
  
  try {
    await analyzer.initialize();
    
    console.log(`🌐 Testing: ${url}`);
    console.log(`📊 Using: ${CONFIG.MODEL}\n`);
    
    const result = await analyzer.processUrl(url);
    
    if (result && !result.error) {
      console.log('\n✅ ANALYSIS RESULTS:');
      console.log('═══════════════════════════════════');
      console.log(`📈 SCORES (out of 10):`);
      console.log(`   Headline & Value Prop: ${result.headline_score}/10`);
      console.log(`   Benefit-Focused Content: ${result.content_score}/10`);
      console.log(`   Call-to-Action: ${result.cta_score}/10`);
      console.log(`   Visuals & Interactive: ${result.visuals_score}/10`);
      console.log(`   Trust & Social Proof: ${result.trust_score}/10`);
      console.log(`   📊 TOTAL SCORE: ${result.total_score}/50\n`);
      
      console.log(`💪 Strongest Element: ${result.strongest_element}`);
      console.log(`⚠️ Weakest Element: ${result.weakest_element}\n`);
      
      console.log(`🎯 QUICK WINS:`);
      if (result.quick_win_1) console.log(`   1. ${result.quick_win_1}`);
      if (result.quick_win_2) console.log(`   2. ${result.quick_win_2}`);
      if (result.quick_win_3) console.log(`   3. ${result.quick_win_3}`);
      
      console.log(`\n📝 RECOMMENDATIONS:`);
      console.log(`   Headline: ${result.headline_recommendation}`);
      console.log(`   Content: ${result.content_recommendation}`);
      console.log(`   CTA: ${result.cta_recommendation}`);
      console.log(`   Visuals: ${result.visuals_recommendation}`);
      console.log(`   Trust: ${result.trust_recommendation}`);
      
      console.log(`\n💰 COST ESTIMATE:`);
      console.log(`   This analysis: ~$${analyzer.costTracker.estimatedCost.toFixed(4)}`);
      console.log(`   For 6,000 pages: ~$${(analyzer.costTracker.estimatedCost * 6000).toFixed(2)}`);
    } else {
      console.error('❌ Analysis failed:', result?.error || 'Unknown error');
    }
    
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
  } finally {
    await analyzer.cleanup();
  }
}

// ==========================================
// MAIN EXECUTION
// ==========================================

async function main() {
  // Check for API key
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ ERROR: OPENAI_API_KEY not found in .env file');
    console.log('\n📝 To get started:');
    console.log('1. Get your API key from: https://platform.openai.com/api-keys');
    console.log('2. Create a .env file with: OPENAI_API_KEY=your-key-here');
    process.exit(1);
  }
  
  const args = process.argv.slice(2);
  
  if (args[0] === 'test' && args[1]) {
    // Test single URL
    await testSingleUrl(args[1]);
  } else if (args[0]) {
    // Process CSV file
    const analyzer = new LandingPageAnalyzer();
    
    try {
      await analyzer.initialize();
      await analyzer.processCSV(args[0]);
    } catch (error) {
      console.error('❌ Fatal error:', error.message);
    } finally {
      await analyzer.cleanup();
    }
  } else {
    // Show usage instructions
    console.log('\n🚀 GPT-4 LANDING PAGE ANALYZER');
    console.log('══════════════════════════════════════\n');
    console.log('USAGE:');
    console.log('  Analyze CSV:    node openai-analyzer.js <csv_file>');
    console.log('  Test single:    node openai-analyzer.js test <url>\n');
    console.log('EXAMPLES:');
    console.log('  node openai-analyzer.js landing_pages.csv');
    console.log('  node openai-analyzer.js test https://example.com\n');
    console.log('CONFIGURATION:');
    console.log(`  Model: ${CONFIG.MODEL}`);
    console.log(`  Batch Size: ${CONFIG.BATCH_SIZE} concurrent pages`);
    console.log(`  Rate Limit: ${CONFIG.RATE_LIMIT}ms between API calls\n`);
    console.log('PRICING:');
    console.log(`  Input: $${CONFIG.COST_PER_1M_INPUT}/million tokens`);
    console.log(`  Output: $${CONFIG.COST_PER_1M_OUTPUT}/million tokens`);
    console.log(`  Estimated: ~$0.002-0.005 per page\n`);
  }
}

// Run the application
main().catch(console.error);

export { LandingPageAnalyzer, testSingleUrl };
