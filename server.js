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
// Serve static files (dashboard)
app.use(express.static('public'));

let sessionData = {
  cookies: null,
  timestamp: null,
  ttl: 3 * 60 * 1000
};

const GOOGLE_SHEETS_WEBHOOK = process.env.SHEETS_WEBHOOK || null;

async function initializeNSESession(forceRefresh = false) {
  const now = Date.now();
  
  if (!forceRefresh && sessionData.cookies && (now - sessionData.timestamp) < sessionData.ttl) {
    return sessionData.cookies;
  }
  
  try {
    console.log('🔄 Getting NSE session...');
    
    const homeResponse = await axios.get('https://www.nseindia.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive'
      },
      timeout: 15000
    });
    
    const cookies = homeResponse.headers['set-cookie'];
    if (!cookies) throw new Error('No cookies received');
    
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const cookieString = cookies.map(c => c.split(';')[0]).join('; ');
    
    await axios.get('https://www.nseindia.com/option-chain', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookieString,
        'Referer': 'https://www.nseindia.com'
      }
    });
    
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
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`;
      
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Cookie': cookies,
          'Referer': 'https://www.nseindia.com/option-chain',
          'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: 20000
      });
      
      if (response.data && response.data.records) {
        console.log(`✅ ${symbol} data fetched`);
        return response.data;
      }
      
      throw new Error('Invalid response');
      
    } catch (error) {
      console.log(`❌ Attempt ${attempt} failed for ${symbol}`);
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 3000));
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

// ---------- SHEETS PUSH (NOW DISABLED – LEFT FOR REFERENCE) ----------

async function pushToGoogleSheets(symbol, pcrData) {
  // This function is kept for reference but effectively disabled.
  // Apps Script now pulls data from /api/pcr instead of this server pushing.
  
  if (!GOOGLE_SHEETS_WEBHOOK) {
    console.log('⚠️ No Google Sheets webhook set (push disabled, using Apps Script pull)');
    return false;
  }

  // If you ever want to re‑enable server‑side push, uncomment this block.
  /*
  try {
    await axios.post(GOOGLE_SHEETS_WEBHOOK, {
      symbol,
      ...pcrData,
      timestamp: new Date().toISOString()
    });
    console.log(`✅ Pushed ${symbol} to Google Sheets`);
    return true;
  } catch (error) {
    console.error('❌ Sheets error:', error.message);
    return false;
  }
  */

  return false;
}

// --------------------------------------------------------------------

function isMarketOpen() {
  const now = new Date();
  const hour = now.getUTCHours() + 5;
  const minute = now.getUTCMinutes() + 30;
  const day = now.getUTCDay();
  
  const isWeekday = day >= 1 && day <= 5;
  const currentMinutes = hour * 60 + minute;
  const marketOpen = 9 * 60 + 15;
  const marketClose = 15 * 60 + 30;
  
  return isWeekday && currentMinutes >= marketOpen && currentMinutes <= marketClose;
}

async function autoFetchJob() {
  if (!isMarketOpen()) {
    console.log('🔴 Market is closed - skipping');
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
      
      console.log(`   PCR: ${pcr.pcr}`);
      console.log(`   Price: ₹${pcr.underlyingValue.toLocaleString('en-IN')}`);
      
      // OLD BEHAVIOUR: push to Google Sheets
      // await pushToGoogleSheets(symbol, pcr);

      // NEW BEHAVIOUR:
      // Do not push to Sheets here.
      // Google Apps Script now pulls from /api/pcr/:symbol and writes to the sheet.

      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (error) {
      console.error(`❌ ${symbol} failed:`, error.message);
    }
  }
  
  console.log('\n✅ AUTO-FETCH COMPLETED\n');
}

cron.schedule('*/5 * * * *', () => {
  if (isMarketOpen()) {
    autoFetchJob();
  }
}, {
  timezone: 'Asia/Kolkata'
});

console.log('⏰ Scheduler set up - runs every 5 min during market hours');

app.get('/', (req, res) => {
  res.json({
    status: '🟢 LIVE',
    service: 'NSE PCR Cloud Tracker',
    marketOpen: isMarketOpen(),
    info: 'Auto-fetches data every 5 minutes during market hours (9:15-15:30 IST)',
    endpoints: {
      health: 'GET /health',
      pcr: 'GET /api/pcr/:symbol',
      trigger: 'POST /api/trigger'
    }
  });
});

app.get('/ping', (req, res) => {
  res.send('OK');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: Math.floor(process.uptime()) + ' seconds',
    marketOpen: isMarketOpen(),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/pcr/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const validSymbols = ['NIFTY', 'BANKNIFTY'];
  
  if (!validSymbols.includes(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol', validSymbols });
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
    res.json({ success: true, message: 'Manual fetch completed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 NSE PCR CLOUD TRACKER');
  console.log('='.repeat(70));
  console.log(`📍 Running on port: ${PORT}`);
  console.log(`🔴 Market status: ${isMarketOpen() ? 'OPEN ✅' : 'CLOSED ❌'}`);
  console.log(`⏰ Auto-fetch: Every 5 min (only during market hours)`);
  console.log('='.repeat(70) + '\n');
});
