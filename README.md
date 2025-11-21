# Gemini 3 Pro Landing Page Analyzer 🚀

Advanced CRO (Conversion Rate Optimization) analysis tool powered by Google's Gemini 3 Pro model, optimized for high-volume landing page evaluation.

## 🎯 Features

- **Gemini 3 Pro Powered**: Uses Google's latest and most advanced AI model
- **Optimized Thinking Level**: Configured with `low` thinking for efficient pattern matching
- **Comprehensive CRO Analysis**: Grades 5 key conversion elements on a 1-10 scale
- **Detailed Recommendations**: Provides specific, actionable improvements for each element
- **Quick Wins Identification**: Highlights top 3 immediate improvements per page
- **Batch Processing**: Analyzes thousands of pages efficiently with concurrent processing
- **Cost Tracking**: Real-time cost estimation and tracking
- **Checkpoint System**: Resume interrupted analyses without losing progress
- **Visual Documentation**: Captures screenshots for reference

## 📊 Scoring Criteria

Each landing page is evaluated on:

1. **Clear and Compelling Headline and Value Proposition** (1-10)
   - Headline clarity and benefit focus
   - Unique value proposition communication
   - Above-the-fold prominence

2. **Benefit-Focused Content and Description** (1-10)
   - Benefits vs features balance
   - Target audience value clarity
   - Specific and compelling benefits

3. **Strong Call-to-Action** (1-10)
   - CTA clarity and action orientation
   - Visual prominence
   - Strategic placement

4. **High-Quality Visuals and Interactive Elements** (1-10)
   - Visual support for messaging
   - Professional design and trust
   - Interactive engagement elements

5. **Trust Elements and Social Proof** (1-10)
   - Testimonials, reviews, case studies
   - Trust badges and certifications
   - Social proof prominence

## 💰 Cost Analysis

### Gemini 3 Pro Preview Pricing
- **Input**: $2 per million tokens (< 200k context)
- **Output**: $12 per million tokens (< 200k context)
- **Per Page**: ~$0.007-0.010
- **6,000 Pages**: ~$40-60

**Note**: During preview phase, costs may be reduced or waived!

## 🚀 Quick Start

### 1. Installation

```bash
# Clone or download the analyzer
git clone [your-repo]
cd gemini3-landing-analyzer

# Install dependencies
npm install
```

### 2. Get Gemini API Key

1. Visit [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create an API key
3. Copy the key

### 3. Configuration

```bash
# Create .env file
cp .env.example .env

# Edit .env and add your API key
GEMINI_API_KEY=your-api-key-here
```

### 4. Test Single Page

```bash
# Test the analyzer on one URL
npm run test https://example.com
```

### 5. Analyze Multiple Pages

Prepare a CSV file with a column named `url`:

```csv
url
https://example1.com
https://example2.com
https://example3.com
```

Run the analyzer:

```bash
node gemini3-analyzer.js your_landing_pages.csv
```

## 📁 Output Files

### Main Results: `landing_page_analysis_gemini3.csv`

Contains for each page:
- Individual scores (1-10) for each criterion
- Total score (out of 50)
- Strongest and weakest elements
- Top 3 quick wins
- Specific recommendations for each element
- Page metrics (CTA count, images, testimonials, etc.)

### Summary Report: `gemini3_analysis_summary.json`

Includes:
- Average scores across all pages
- Score distribution (Excellent/Good/Average/Poor)
- Top 10 and Bottom 10 performers
- Most common weaknesses
- Priority improvement lists

### Additional Files
- `screenshots/` - Visual captures of each page
- `checkpoint_gemini3.json` - Progress tracking for resume capability
- `gemini3_analysis.log` - Detailed execution log

## 🎯 Why LOW Thinking Level?

This analyzer uses `thinking_level: "low"` because:

1. **Pattern Matching Task**: CRO analysis is about recognizing established patterns
2. **Speed & Efficiency**: Processes pages 2-3x faster than high thinking
3. **Cost Optimization**: Reduces token usage by 30-50%
4. **Consistent Results**: Pattern recognition doesn't require deep reasoning

HIGH thinking would be used for complex problem-solving, but landing page analysis is about checking against known best practices.

## 📈 Usage Examples

### Basic Analysis
```bash
node gemini3-analyzer.js landing_pages.csv
```

### Test Mode
```bash
node gemini3-analyzer.js test https://yoursite.com
```

### Custom CSV Column Names
If your CSV uses different column names, edit line ~650 in the script:
```javascript
const url = row.url || row.URL || row.landing_page || row.YOUR_COLUMN;
```

## ⚡ Performance Optimization

### Recommended Settings for 6,000 Pages

```javascript
// In gemini3-analyzer.js
const CONFIG = {
  BATCH_SIZE: 15,    // Optimal for Gemini 3 rate limits
  RATE_LIMIT: 2000,  // 2 seconds between calls (30 RPM)
  THINKING_LEVEL: 'low'  // Fast, efficient for CRO
};
```

### Processing Time Estimates
- **100 pages**: ~6-8 minutes
- **1,000 pages**: ~1-1.5 hours  
- **6,000 pages**: ~6-8 hours

## 🔧 Troubleshooting

### Common Issues

1. **"GEMINI_API_KEY not found"**
   ```bash
   # Make sure .env file exists with:
   GEMINI_API_KEY=your-actual-key-here
   ```

2. **Rate Limit Errors**
   ```javascript
   // Increase RATE_LIMIT in CONFIG
   RATE_LIMIT: 3000  // 3 seconds between calls
   ```

3. **Page Load Timeouts**
   ```javascript
   // In scrapePageContent(), increase timeout:
   await page.goto(url, { 
     timeout: 60000  // 60 seconds
   });
   ```

4. **Memory Issues**
   ```bash
   # Increase Node memory limit
   node --max-old-space-size=4096 gemini3-analyzer.js large_file.csv
   ```

## 📊 Interpreting Results

### Score Ranges
- **40-50**: Excellent - Minor tweaks only
- **30-39**: Good - Some improvements needed
- **20-29**: Average - Significant optimization potential
- **Below 20**: Poor - Major overhaul recommended

### Quick Wins Priority
1. **Headline Issues**: Usually highest impact, easiest to fix
2. **CTA Problems**: Quick visual/copy changes
3. **Trust Elements**: Add testimonials/badges
4. **Content Focus**: Shift from features to benefits
5. **Visual Quality**: Update images/design

## 🚨 Important Notes

1. **Preview Pricing**: Gemini 3 Pro is in preview - costs may be reduced or waived
2. **Rate Limits**: Respect Google's rate limits to avoid throttling
3. **Context Window**: Each page uses ~1,500-2,000 input tokens
4. **Screenshot Storage**: ~1-2MB per screenshot, plan storage accordingly

## 📝 CSV Format Examples

### Basic Format
```csv
url
https://site1.com
https://site2.com
```

### With Additional Data (ignored by analyzer)
```csv
url,company,category
https://site1.com,Company A,SaaS
https://site2.com,Company B,E-commerce
```

## 🤝 Support

For issues or questions:
1. Check the error log: `gemini3_analysis.log`
2. Verify API key is valid in [Google AI Studio](https://makersuite.google.com)
3. Test with a single URL first
4. Ensure URLs include `https://` protocol

## 📈 ROI Calculation

For 6,000 pages at ~$50 total cost:
- Need only **0.01% conversion improvement** to break even
- Most sites see **10-30% improvement** after implementing recommendations
- ROI typically **100-1000x** the analysis cost

## 🎉 Getting Started Checklist

- [ ] Get Gemini API key
- [ ] Install Node.js 18+
- [ ] Run `npm install`
- [ ] Create `.env` with API key
- [ ] Test with single URL
- [ ] Prepare CSV file
- [ ] Run full analysis
- [ ] Review summary report
- [ ] Prioritize improvements
- [ ] Implement quick wins

---

**Built with Gemini 3 Pro** - Google's most advanced multimodal AI model
