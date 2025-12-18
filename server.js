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
  ttl: 5 * 60 * 1000 // 5 minutes
};

// Rotate User-Agents to avoid detection
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function initializeNSESession(forceRefresh = false) {
  const now = Date.now();
  
  if (!forceRefresh && sessionData.cookies && (now - sessionData.timestamp) < sessionData.ttl) {
    console.log('♻️ Reusing session');
    return sessionData.cookies;
  }
  
  try {
    console.log('🔄 Getting NEW NSE session...');
    
    const userAgent = getRandomUserAgent();
    
    const homeResponse = await axios.get('https://www.nseindia.com', {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 20000
    });
    
    const cookies = homeResponse.headers['set-cookie'];
    if (!cookies) throw new Error('No cookies received');
    
    // Random delay 2-4 seconds
    await new Promise(resolve => setTimeout(resolve, randomDelay(2000, 4000)));
    
    const cookieString = cookies.map(c => c.split(';')[0]).join('; ');
    
    await axios.get('https://www.nseindia.com/option-chain', {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cookie': cookieString,
        'Referer': 'https://www.nseindia.com',
        'Connection': 'keep-alive'
      },
      timeout: 20000
    });
    
    sessionData.cookies = cookieString;
    sessionData.timestamp = now;
    
    console.log('✅ Session established');
    return cookieString;
    
  } catch (error) {
    console.error('❌ Session error:', error.message);
    throw error;
  }
}

async function fetchOptionChain(symbol, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const cookies = await initializeNSESession(attempt > 1);
      
      // Random delay 3-6 seconds
      await new Promise(resolve => setTimeout(resolve, randomDelay(3000, 6000)));
      
      const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`;
      const userAgent = getRandomUserAgent();
      
      const response = await axios.get(url, {
        headers: {
          'User-Agent': userAgent,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': cookies,
          'Referer': 'https://www.nseindia.com/option-chain',
          'X-Requested-With': 'XMLHttpRequest',
          'Connection': 'keep-alive'
        },
        timeout: 25000
      });
      
      if (response.data && response.data.records) {
        console.log(`✅ ${symbol} fetched (attempt ${attempt})`);
        return response.data;
      }
      
      throw new Error('Invalid response');
      
    } catch (error) {
      console.log(`❌ ${symbol} attempt ${attempt} failed: ${error.message}`);
      if (attempt === retries) throw error;
      
      // Longer backoff with randomness
      const backoff = randomDelay(8000, 12000);
      console.log(`⏳ Waiting ${Math.round(backoff/1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
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
  
  console.log('\n🤖 AUTO-FETCH | ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  
  for (const symbol of ['NIFTY', 'BANKNIFTY']) {
    try {
      const data = await fetchOptionChain(symbol);
      const pcr = calculatePCR(data);
      console.log(`${symbol}: PCR ${pcr.pcr}, Price ₹${pcr.underlyingValue.toLocaleString('en-IN')}`);
      
      // Random delay between symbols
      await new Promise(resolve => setTimeout(resolve, randomDelay(4000, 7000)));
    } catch (error) {
      console.error(`❌ ${symbol}:`, error.message);
    }
  }
}

// Fetch every 5 minutes (but add jitter)
cron.schedule('*/5 * * * *', async () => {
  if (isMarketOpen()) {
    // Add 0-60 second random jitter
    const jitter = randomDelay(0, 60000);
    console.log(`⏱️ Jitter: ${Math.round(jitter/1000)}s`);
    await new Promise(resolve => setTimeout(resolve, jitter));
    autoFetchJob();
  }
}, { timezone: 'Asia/Kolkata' });

app.get('/', (req, res) => {
  res.json({
    status: '🟢 LIVE',
    marketOpen: isMarketOpen(),
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

app.post('/api/trigger', async (req, res) => {
  try {
    await autoFetchJob();
    res.json({ success: true, message: 'Completed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 PCR TRACKER on port ${PORT}`);
  console.log(`Market: ${isMarketOpen() ? 'OPEN ✅' : 'CLOSED ❌'}\n`);
});
