// scanners/tech_stack_scanner.js
const Wappalyzer = require('wappalyzer');

// --- Input Validation ---
const url = process.argv[2];
if (!url) {
  console.error(JSON.stringify({ error: 'No URL provided' }));
  process.exit(1);
}

const urlPattern = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/.*)*$/i;
if (!urlPattern.test(url)) {
    console.log(JSON.stringify({ error: `Invalid input format. Input '${url}' is not a valid URL.` }));
    process.exit(0);
}
// --- End Validation ---

const options = {
  debug: false,
  delay: 500,
  maxDepth: 3,
  maxUrls: 10,
  maxWait: 5000,
  recursive: false,
  probe: true,
  userAgent: 'ScoutIQ-Scanner',
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
};

const wappalyzer = new Wappalyzer(options);

(async function() {
  try {
    await wappalyzer.init();
    const site = await wappalyzer.open(url);
    const results = await site.analyze();
    console.log(JSON.stringify({ technologies: results.technologies }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exit(1);
  } finally {
    await wappalyzer.destroy();
  }
})();