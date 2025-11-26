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

// ========== SESSION & DATA STORAGE ==========
let sessionData = {
  cookies: null,
  timestamp: null,
  ttl: 3 * 60 * 1000
};

let todayHistory = {
  NIFTY: [],
  BANKNIFTY: [],
  date: new Date().toLocaleDateString('en-IN'),
  marketOpen: false
};

// Market data storage (live)
let marketData = {
  indices: [],
  gainers: [],
  losers: [],
  mostActive: [],
  lastUpdate: null
};

// NEW: Closing data storage (persists after market close)
let closingData = {
  indices: [],
  gainers: [],
  losers: [],
  mostActive: [],
  closeDate: null,
  lastUpdate: null
};

// ========== MARKET HOURS CHECK ==========
function isMarketHours() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  
  const hours = istTime.getUTCHours();
  const minutes = istTime.getUTCMinutes();
  const day = istTime.getUTCDay();
  
  if (day === 0 || day === 6) return false;
  
  const currentMinutes = hours * 60 + minutes;
  const marketStart = 9 * 60 + 15;
  const marketEnd = 15 * 60 + 30;
  
  return currentMinutes >= marketStart && currentMinutes <= marketEnd;
}

// ========== SESSION MANAGEMENT ==========
async function ensureSession() {
  if (sessionData.cookies && 
      sessionData.timestamp && 
      (Date.now() - sessionData.timestamp < sessionData.ttl)) {
    return sessionData.cookies;
  }
  
  try {
    const response = await axios.get('https://www.nseindia.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      }
    });
    
    const cookies = response.headers['set-cookie'];
    if (cookies) {
      sessionData.cookies = cookies.join('; ');
      sessionData.timestamp = Date.now();
      console.log('✅ Session refreshed');
      return sessionData.cookies;
    }
  } catch (error) {
    console.error('Session refresh error:', error.message);
  }
  
  return sessionData.cookies;
}

// ========== FETCH PCR DATA (EXISTING) ==========
async function fetchPCRData(symbol) {
  try {
    const cookies = await ensureSession();
    if (!cookies) throw new Error('No valid session');
    
    const response = await axios.get(
      `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': cookies,
          'Referer': 'https://www.nseindia.com/option-chain'
        },
        timeout: 10000
      }
    );
    
    const data = response.data;
    let totalCallOI = 0, totalPutOI = 0;
    let totalCallVolume = 0, totalPutVolume = 0;
    let callOIChange = 0, putOIChange = 0;
    
    if (data.records && data.records.data) {
      data.records.data.forEach(item => {
        if (item.CE) {
          totalCallOI += item.CE.openInterest || 0;
          totalCallVolume += item.CE.totalTradedVolume || 0;
          callOIChange += item.CE.changeinOpenInterest || 0;
        }
        if (item.PE) {
          totalPutOI += item.PE.openInterest || 0;
          totalPutVolume += item.PE.totalTradedVolume || 0;
          putOIChange += item.PE.changeinOpenInterest || 0;
        }
      });
    }
    
    const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI) : 0;
    const volumePCR = totalCallVolume > 0 ? (totalPutVolume / totalCallVolume) : 0;
    
    return {
      success: true,
      symbol,
      totalCallOI,
      totalPutOI,
      pcr: parseFloat(pcr.toFixed(2)),
      volumePCR: parseFloat(volumePCR.toFixed(2)),
      callOIChange,
      putOIChange,
      totalCallVolume,
      totalPutVolume,
      underlyingValue: data.records?.underlyingValue || 0,
      timestamp: new Date().toLocaleString('en-IN'),
      fetchedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error(`Error fetching ${symbol} PCR:`, error.message);
    return { success: false, symbol, error: error.message };
  }
}

// ========== FETCH MARKET INDICES ==========
async function fetchMarketIndices() {
  try {
    const cookies = await ensureSession();
    if (!cookies) throw new Error('No valid session');
    
    const response = await axios.get(
      'https://www.nseindia.com/api/allIndices',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Cookie': cookies,
          'Referer': 'https://www.nseindia.com'
        },
        timeout: 10000
      }
    );
    
    const indices = response.data.data || [];
    const importantIndices = ['NIFTY 50', 'NIFTY BANK', 'NIFTY MIDCAP 100', 'INDIA VIX', 'NIFTY IT', 'NIFTY PHARMA'];
    
    return indices
      .filter(idx => importantIndices.includes(idx.index))
      .map(idx => ({
        name: idx.index,
        value: idx.last,
        change: idx.percentChange,
        previousClose: idx.previousClose,
        open: idx.open,
        high: idx.dayHigh,
        low: idx.dayLow
      }));
  } catch (error) {
    console.error('Error fetching indices:', error.message);
    return [];
  }
}

// ========== FETCH TOP GAINERS ==========
async function fetchTopGainers() {
  try {
    const cookies = await ensureSession();
    if (!cookies) throw new Error('No valid session');
    
    const response = await axios.get(
      'https://www.nseindia.com/api/live-analysis-variations?index=gainers',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Cookie': cookies,
          'Referer': 'https://www.nseindia.com'
        },
        timeout: 10000
      }
    );
    
    const data = response.data.NIFTY || [];
    
    return data.slice(0, 10).map(stock => ({
      symbol: stock.symbol,
      name: stock.meta?.companyName || stock.symbol,
      price: stock.lastPrice,
      change: stock.pChange,
      volume: stock.totalTradedVolume,
      value: stock.totalTradedValue
    }));
  } catch (error) {
    console.error('Error fetching gainers:', error.message);
    return [];
  }
}

// ========== FETCH TOP LOSERS ==========
async function fetchTopLosers() {
  try {
    const cookies = await ensureSession();
    if (!cookies) throw new Error('No valid session');
    
    const response = await axios.get(
      'https://www.nseindia.com/api/live-analysis-variations?index=losers',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Cookie': cookies,
          'Referer': 'https://www.nseindia.com'
        },
        timeout: 10000
      }
    );
    
    const data = response.data.NIFTY || [];
    
    return data.slice(0, 10).map(stock => ({
      symbol: stock.symbol,
      name: stock.meta?.companyName || stock.symbol,
      price: stock.lastPrice,
      change: stock.pChange,
      volume: stock.totalTradedVolume,
      value: stock.totalTradedValue
    }));
  } catch (error) {
    console.error('Error fetching losers:', error.message);
    return [];
  }
}

// ========== FETCH MOST ACTIVE ==========
async function fetchMostActive() {
  try {
    const cookies = await ensureSession();
    if (!cookies) throw new Error('No valid session');
    
    const response = await axios.get(
      'https://www.nseindia.com/api/live-analysis-variations?index=volume',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Cookie': cookies,
          'Referer': 'https://www.nseindia.com'
        },
        timeout: 10000
      }
    );
    
    const data = response.data.NIFTY || [];
    
    return data.slice(0, 10).map(stock => ({
      symbol: stock.symbol,
      name: stock.meta?.companyName || stock.symbol,
      price: stock.lastPrice,
      change: stock.pChange,
      volume: stock.totalTradedVolume,
      value: stock.totalTradedValue
    }));
  } catch (error) {
    console.error('Error fetching most active:', error.message);
    return [];
  }
}

// ========== AUTO-FETCH MARKET DATA ==========
async function autoFetchMarketData() {
  console.log('🔄 Fetching market data...');
  
  try {
    const [indices, gainers, losers, active] = await Promise.all([
      fetchMarketIndices(),
      fetchTopGainers(),
      fetchTopLosers(),
      fetchMostActive()
    ]);
    
    // Store in live data
    marketData = {
      indices,
      gainers,
      losers,
      mostActive: active,
      lastUpdate: new Date().toISOString()
    };
    
    // If market is open OR if we have data, update closing snapshot
    if (indices.length > 0 || gainers.length > 0) {
      closingData = {
        indices,
        gainers,
        losers,
        mostActive: active,
        closeDate: new Date().toLocaleDateString('en-IN'),
        lastUpdate: new Date().toISOString()
      };
      console.log(`✅ Market data updated & saved as closing snapshot`);
    }
    
    todayHistory.marketOpen = isMarketHours();
  } catch (error) {
    console.error('Error in autoFetchMarketData:', error);
  }
}

// ========== AUTO-FETCH PCR DATA ==========
async function autoFetchPCRData() {
  if (!isMarketHours()) {
    todayHistory.marketOpen = false;
    return;
  }
  
  todayHistory.marketOpen = true;
  
  const now = new Date();
  const minutes = now.getMinutes();
  if (minutes % 5 !== 0) return;
  
  console.log('🔄 Fetching PCR data...');
  
  try {
    const [niftyData, bankniftyData] = await Promise.all([
      fetchPCRData('NIFTY'),
      fetchPCRData('BANKNIFTY')
    ]);
    
    if (niftyData.success) {
      const entry = {
        time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        ...niftyData
      };
      todayHistory.NIFTY.push(entry);
      console.log(`✅ NIFTY PCR: ${niftyData.pcr}`);
    }
    
    if (bankniftyData.success) {
      const entry = {
        time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        ...bankniftyData
      };
      todayHistory.BANKNIFTY.push(entry);
      console.log(`✅ BANKNIFTY PCR: ${bankniftyData.pcr}`);
    }
  } catch (error) {
    console.error('Error in autoFetchPCRData:', error);
  }
}

// ========== DAILY RESET ==========
function resetDailyData() {
  const today = new Date().toLocaleDateString('en-IN');
  
  if (todayHistory.date !== today) {
    console.log('🔄 New day - resetting data');
    todayHistory = {
      NIFTY: [],
      BANKNIFTY: [],
      date: today,
      marketOpen: false
    };
    
    marketData = {
      indices: [],
      gainers: [],
      losers: [],
      mostActive: [],
      lastUpdate: null
    };
    
    // Don't reset closingData - it persists to show last trading day
  }
}

// ========== API ENDPOINTS ==========

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    marketOpen: isMarketHours(),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/history', (req, res) => {
  res.json({
    success: true,
    date: todayHistory.date,
    NIFTY: todayHistory.NIFTY,
    BANKNIFTY: todayHistory.BANKNIFTY,
    marketOpen: todayHistory.marketOpen
  });
});

app.get('/api/pcr/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  
  if (symbol !== 'NIFTY' && symbol !== 'BANKNIFTY') {
    return res.status(400).json({ success: false, error: 'Invalid symbol' });
  }
  
  try {
    const data = await fetchPCRData(symbol);
    res.json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all market data (live + closing fallback)
app.get('/api/market/overview', (req, res) => {
  // If market is open, return live data
  if (todayHistory.marketOpen && marketData.indices.length > 0) {
    return res.json({
      success: true,
      ...marketData,
      marketOpen: true,
      dataType: 'live'
    });
  }
  
  // Otherwise return last closing data
  res.json({
    success: true,
    ...closingData,
    marketOpen: false,
    dataType: 'closing'
  });
});

// NEW: Get closing data specifically
app.get('/api/market/closing', (req, res) => {
  res.json({
    success: true,
    ...closingData
  });
});

app.get('/api/market/indices', (req, res) => {
  const data = todayHistory.marketOpen ? marketData : closingData;
  res.json({
    success: true,
    indices: data.indices,
    lastUpdate: data.lastUpdate
  });
});

app.get('/api/market/gainers', (req, res) => {
  const data = todayHistory.marketOpen ? marketData : closingData;
  res.json({
    success: true,
    gainers: data.gainers,
    lastUpdate: data.lastUpdate
  });
});

app.get('/api/market/losers', (req, res) => {
  const data = todayHistory.marketOpen ? marketData : closingData;
  res.json({
    success: true,
    losers: data.losers,
    lastUpdate: data.lastUpdate
  });
});

app.get('/api/market/active', (req, res) => {
  const data = todayHistory.marketOpen ? marketData : closingData;
  res.json({
    success: true,
    mostActive: data.mostActive,
    lastUpdate: data.lastUpdate
  });
});

// ========== CRON JOBS ==========

cron.schedule('* * * * *', () => {
  resetDailyData();
  autoFetchPCRData();
});

// Fetch market data every 2 minutes
cron.schedule('*/2 * * * *', () => {
  autoFetchMarketData();
});

cron.schedule('0 9 * * *', () => {
  console.log('🔄 Daily reset at 9:00 AM');
  resetDailyData();
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Market hours: 09:15 - 15:30 IST`);
  console.log(`⏰ Current status: ${isMarketHours() ? 'MARKET OPEN' : 'MARKET CLOSED'}`);
  
  // Initial fetch
  ensureSession().then(() => {
    autoFetchMarketData(); // Fetch immediately on startup
    if (isMarketHours()) {
      autoFetchPCRData();
    }
  });
});
