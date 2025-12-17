const express = require('express');
const axios = require('axios');
const cors = require('cors');
const compression = require('compression');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static('public'));

let sessionData = {
  cookies: null,
  timestamp: null,
  ttl: 5 * 60 * 1000,
  consecutiveFailures: 0
};

// Request queue to prevent hammering NSE
let lastRequestTime = 0;
const MIN_REQUEST_GAP = 8000; // 8 seconds between requests

async function waitForRateLimit() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < MIN_REQUEST_GAP) {
    const waitTime = MIN_REQUEST_GAP - timeSinceLastRequest;
    console.log(`⏳ Rate limiting: waiting ${Math.round(waitTime/1000)}s...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastRequestTime = Date.now();
}

async function initializeNSESession(forceRefresh = false) {
  const now = Date.now();
  
  if (!forceRefresh && sessionData.cookies && (now - sessionData.timestamp) < sessionData.ttl) {
    console.log('♻️ Reusing existing session');
    return sessionData.cookies;
  }
  
  try {
    console.log('🔄 Establishing NEW session...');
    
    await waitForRateLimit();
    
    // Step 1: GET homepage
    const homeResponse = await axios.get('https://www.nseindia.com', {
      headers: {
        'authority': 'www.nseindia.com',
        'method': 'GET',
        'path': '/',
        'scheme': 'https',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
        'Cache-Control': 'max-age=0',
        'Priority': 'u=0, i',
        'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      },
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 500
    });
    
    if (homeResponse.status !== 200) {
      throw new Error(`Homepage returned ${homeResponse.status}`);
    }
    
    const cookies = homeResponse.headers['set-cookie'];
    if (!cookies || cookies.length === 0) {
      throw new Error('No cookies received from homepage');
    }
    
    console.log(`📦 Received ${cookies.length} cookies`);
    
    // Human-like delay
    await new Promise(resolve => setTimeout(resolve, 4000));
    
    const cookieString = cookies.map(c => c.split(';')[0]).join('; ');
    
    await waitForRateLimit();
    
    // Step 2: GET /get-quotes/derivatives (intermediate page)
    await axios.get('https://www.nseindia.com/get-quotes/derivatives?symbol=NIFTY', {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': cookieString,
        'Referer': 'https://www.nseindia.com/',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      },
      timeout: 30000,
      validateStatus: () => true
    });
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    await waitForRateLimit();
    
    // Step 3: GET option-chain page
    await axios.get('https://www.nseindia.com/option-chain', {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': cookieString,
        'Referer': 'https://www.nseindia.com/',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      },
      timeout: 30000
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    sessionData.cookies = cookieString;
    sessionData.timestamp = now;
    sessionData.consecutiveFailures = 0;
    
    console.log('✅ Session established successfully');
    return cookieString;
    
  } catch (error) {
    sessionData.consecutiveFailures++;
    console.error(`❌ Session error (failure #${sessionData.consecutiveFailures}):`, error.message);
    throw error;
  }
}

async function fetchOptionChain(symbol, retries = 2) {
  
  // If too many failures, wait longer
  if (sessionData.consecutiveFailures >= 3) {
    const waitTime = 60000; // 1 minute
    console.log(`⚠️ Too many failures. Cooling down for ${waitTime/1000}s...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    sessionData.consecutiveFailures = 0;
  }
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const cookies = await initializeNSESession(attempt > 1);
      
      await waitForRateLimit();
      
      const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`;
      
      console.log(`🎯 Fetching ${symbol} option chain (attempt ${attempt}/${retries})...`);
      
      const response = await axios.get(url, {
        headers: {
          'Accept': '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': cookies,
          'Referer': 'https://www.nseindia.com/option-chain',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: 30000,
        validateStatus: (status) => status >= 200 && status < 500
      });
      
      if (response.status === 403) {
        throw new Error('403 Forbidden - IP may be blocked');
      }
      
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      if (response.data && response.data.records) {
        sessionData.consecutiveFailures = 0;
        console.log(`✅ ${symbol} data fetched successfully`);
        return response.data;
      }
      
      throw new Error('Invalid response structure');
      
    } catch (error) {
      sessionData.consecutiveFailures++;
      console.log(`❌ ${symbol} attempt ${attempt}/${retries} failed: ${error.message}`);
      
      if (attempt === retries) {
        throw error;
      }
      
      const delay = 15000 + (Math.random() * 5000);
      console.log(`⏳ Waiting ${Math.round(delay/1000)}s before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function calculatePCR(data) {
  let totalCallOI = 0, totalPutOI = 0;
  let callOIChange = 0, putOIChange = 0;
  let totalCallVolume = 0, totalPutVolume = 0;
  
  data.records.data.forEach(item => {
    if (item.CE) {
      totalCallOI += item.CE.openInterest || 0;
      callOIChange += item.CE.changeinOpenInterest || 0;
      totalCallVolume += item.CE.totalTradedVolume || 0;
    }
    if (item.PE) {
      totalPutOI += item.PE.openInterest || 0;
      putOIChange += item.PE.changeinOpenInterest || 0;
      totalPutVolume += item.PE.totalTradedVolume || 0;
    }
  });
  
  const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI) : 0;
  const volumePCR = totalCallVolume > 0 ? (totalPutVolume / totalCallVolume) : 0;
  
  return {
    totalCallOI, totalPutOI,
    pcr: parseFloat(pcr.toFixed(2)),
    volumePCR: parseFloat(volumePCR.toFixed(2)),
    callOIChange, putOIChange,
    totalCallVolume, totalPutVolume,
    underlyingValue: data.records.underlyingValue || 0,
    timestamp: data.records.timestamp || new Date().toISOString()
  };
}

function isMarketOpen() {
  const now = new Date();
  const istOffset = 5.5 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const totalMinutes = utcMinutes + istOffset;
  const istDayIndex = (now.getUTCDay() + (totalMinutes >= 24 * 60 ? 1 : 0)) % 7;
  const istMinutes = totalMinutes % (24 * 60);
  const isWeekday = istDayIndex >= 1 && istDayIndex <= 5;
  const marketOpen = 9 * 60 + 15;
  const marketClose = 15 * 60 + 30;
  return isWeekday && istMinutes >= marketOpen && istMinutes <= marketClose;
}

async function autoFetchJob() {
  if (!isMarketOpen()) {
    console.log('🔴 Market closed');
    return;
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('🤖 AUTO-FETCH | ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  console.log('='.repeat(50));
  
  for (const symbol of ['NIFTY', 'BANKNIFTY']) {
    try {
      const data = await fetchOptionChain(symbol);
      const pcr = calculatePCR(data);
      
      console.log(`\n${symbol}:`);
      console.log(`  PCR: ${pcr.pcr}`);
      console.log(`  Price: ₹${pcr.underlyingValue.toLocaleString('en-IN')}`);
      console.log(`  Vol PCR: ${pcr.volumePCR}`);
      
    } catch (error) {
      console.error(`\n❌ ${symbol} FAILED: ${error.message}`);
    }
  }
  
  console.log('\n' + '='.repeat(50) + '\n');
}

cron.schedule('*/5 * * * *', () => {
  if (isMarketOpen()) autoFetchJob();
}, { timezone: 'Asia/Kolkata' });

// API
app.get('/', (req, res) => {
  res.json({
    status: '🟢 LIVE',
    marketOpen: isMarketOpen(),
    failures: sessionData.consecutiveFailures,
    sessionAge: sessionData.timestamp ? Math.floor((Date.now() - sessionData.timestamp) / 1000) : null
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    marketOpen: isMarketOpen()
  });
});

app.get('/api/pcr/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  
  if (!['NIFTY', 'BANKNIFTY'].includes(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol' });
  }
  
  try {
    const data = await fetchOptionChain(symbol);
    const pcr = calculatePCR(data);
    res.json({ success: true, symbol, ...pcr, fetchedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, symbol });
  }
});

app.listen(PORT, () => {
  console.log('\n🚀 NSE PCR TRACKER');
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔴 Market: ${isMarketOpen() ? 'OPEN ✅' : 'CLOSED ❌'}\n`);
});
