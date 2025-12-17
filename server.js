const express = require('express');
const axios = require('axios');
const cors = require('cors');
const compression = require('compression');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'build')));

let sessionData = {
  cookies: null,
  timestamp: null,
  ttl: 3 * 60 * 1000
};

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
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 15000
    });
    
    const cookies = homeResponse.headers['set-cookie'];
    if (!cookies) throw new Error('No cookies received');
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const cookieString = cookies.map(c => c.split(';')[0]).join('; ');
    
    await axios.get('https://www.nseindia.com/option-chain', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': cookieString,
        'Referer': 'https://www.nseindia.com',
        'Connection': 'keep-alive'
      },
      timeout: 15000
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
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`;
      
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cookie': cookies,
          'Referer': 'https://www.nseindia.com/option-chain',
          'X-Requested-With': 'XMLHttpRequest',
          'Connection': 'keep-alive'
        },
        timeout: 20000
      });
      
      if (response.data && response.data.records) {
        console.log(`✅ ${symbol} data fetched`);
        return response.data;
      }
      
      throw new Error('Invalid response');
      
    } catch (error) {
      console.log(`❌ Attempt ${attempt} failed for ${symbol}: ${error.message}`);
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 5000));
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
    totalCallOI, 
    totalPutOI,
    pcr: parseFloat(pcr.toFixed(2)),
    volumePCR: parseFloat(volumePCR.toFixed(2)),
    callOIChange, 
    putOIChange,
    totalCallVolume, 
    totalPutVolume,
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
  
  console.log('\n🤖 AUTO-FETCH', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  
  for (const symbol of ['NIFTY', 'BANKNIFTY']) {
    try {
      const data = await fetchOptionChain(symbol);
      const pcr = calculatePCR(data);
      console.log(`${symbol}: PCR ${pcr.pcr}, Price ₹${pcr.underlyingValue.toLocaleString('en-IN')}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (error) {
      console.error(`❌ ${symbol}:`, error.message);
    }
  }
}

cron.schedule('*/5 * * * *', () => {
  if (isMarketOpen()) autoFetchJob();
}, { timezone: 'Asia/Kolkata' });

// API ENDPOINTS
app.get('/api/status', (req, res) => {
  res.json({
    status: '🟢 LIVE',
    marketOpen: isMarketOpen(),
    service: 'NSE PCR Dashboard'
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
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 PCR DASHBOARD on port ${PORT}`);
  console.log(`Market: ${isMarketOpen() ? 'OPEN ✅' : 'CLOSED ❌'}\n`);
});
