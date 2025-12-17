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
  ttl: 4 * 60 * 1000 // Increased to 4 minutes
};

async function initializeNSESession(forceRefresh = false) {
  const now = Date.now();
  
  if (!forceRefresh && sessionData.cookies && (now - sessionData.timestamp) < sessionData.ttl) {
    return sessionData.cookies;
  }
  
  try {
    console.log('🔄 Getting NSE session...');
    
    // Step 1: Visit homepage with realistic browser headers
    const homeResponse = await axios.get('https://www.nseindia.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0'
      },
      timeout: 20000,
      maxRedirects: 5
    });
    
    const cookies = homeResponse.headers['set-cookie'];
    if (!cookies) throw new Error('No cookies received from NSE');
    
    // Longer delay to simulate human behavior
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const cookieString = cookies.map(c => c.split(';')[0]).join('; ');
    
    // Step 2: Visit option-chain page
    await axios.get('https://www.nseindia.com/option-chain', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cookie': cookieString,
        'Referer': 'https://www.nseindia.com',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Cache-Control': 'max-age=0'
      },
      timeout: 20000
    });
    
    // Another delay
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    sessionData.cookies = cookieString;
    sessionData.timestamp = now;
    
    console.log('✅ Session ready');
    return cookieString;
    
  } catch (error) {
    console.error('❌ Session error:', error.message);
    throw error;
  }
}

async function fetchOptionChain(symbol, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const cookies = await initializeNSESession(attempt > 1);
      
      // Longer delay between attempts
      await new Promise(resolve => setTimeout(resolve, 4000));
      
      const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`;
      
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cookie': cookies,
          'Referer': 'https://www.nseindia.com/option-chain',
          'X-Requested-With': 'XMLHttpRequest',
          'Connection': 'keep-alive',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin'
        },
        timeout: 25000
      });
      
      if (response.data && response.data.records) {
        console.log(`✅ ${symbol} data fetched (attempt ${attempt})`);
        return response.data;
      }
      
      throw new Error('Invalid response structure');
      
    } catch (error) {
      console.log(`❌ Attempt ${attempt}/${retries} failed for ${symbol}: ${error.message}`);
      if (attempt === retries) throw error;
      
      // Exponential backoff with jitter
      const delay = (attempt * 6000) + Math.random() * 2000;
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
    console.log('🔴 Market closed - skipping');
    return;
  }
  
  console.log('\n🤖 AUTO-FETCH STARTED');
  console.log('Time:', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  
  const symbols = ['NIFTY', 'BANKNIFTY'];
  
  for (const symbol of symbols) {
    try {
      console.log(`\n📊 Fetching ${symbol}...`);
      const data = await fetchOptionChain(symbol);
      const pcr = calculatePCR(data);
      
      console.log(`   ✅ PCR: ${pcr.pcr}`);
      console.log(`   💰 Price: ₹${pcr.underlyingValue.toLocaleString('en-IN')}`);
      
      // Longer delay between symbols
      await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (error) {
      console.error(`❌ ${symbol} failed:`, error.message);
    }
  }
  
  console.log('\n✅ AUTO-FETCH COMPLETED\n');
}

// Reduced frequency to avoid rate limiting
cron.schedule('*/5 * * * *', () => {
  if (isMarketOpen()) {
    autoFetchJob();
  }
}, {
  timezone: 'Asia/Kolkata'
});

console.log('⏰ Scheduler set up - runs every 5 min during market hours');

// API ENDPOINTS
app.get('/', (req, res) => {
  res.json({
    status: '🟢 LIVE',
    service: 'NSE PCR Tracker',
    marketOpen: isMarketOpen(),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    marketOpen: isMarketOpen(),
    sessionAge: sessionData.timestamp ? Math.floor((Date.now() - sessionData.timestamp) / 1000) : 0
  });
});

app.get('/api/pcr/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  
  if (!['NIFTY', 'BANKNIFTY'].includes(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol', validSymbols: ['NIFTY', 'BANKNIFTY'] });
  }
  
  try {
    const data = await fetchOptionChain(symbol);
    const pcr = calculatePCR(data);
    
    res.json({
      success: true,
      symbol,
      ...pcr,
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error(`API Error for ${symbol}:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      symbol
    });
  }
});

app.post('/api/trigger', async (req, res) => {
  try {
    await autoFetchJob();
    res.json({ success: true, message: 'Manual fetch completed', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 NSE PCR TRACKER');
  console.log('='.repeat(70));
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔴 Market: ${isMarketOpen() ? 'OPEN ✅' : 'CLOSED ❌'}`);
  console.log(`⏰ Auto-fetch: Every 5 min (market hours only)`);
  console.log('='.repeat(70) + '\n');
});
