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

// Closing data storage (persists after market close)
let closingData = {
  indices: [],
  gainers: [],
  losers: [],
  mostActive: [],
  closeDate: null,
  lastUpdate: null
};

// ========== MARKET HOURS CHECK (FIXED FOR IST) ==========
function isMarketHours() {
  // Get current time in IST
  const now = new Date();
  const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  
  const day = istTime.getDay(); // 0 = Sunday, 6 = Saturday
  const hours = istTime.getHours();
  const minutes = istTime.getMinutes();
  
  // Weekend check
  if (day === 0 || day === 6) {
    console.log('❌ Market closed - Weekend');
    return false;
  }
  
  // Convert to minutes since midnight
  const currentMinutes = hours * 60 + minutes;
  const marketStart = 9 * 60 + 15;  // 9:15 AM
  const marketEnd = 15 * 60 + 30;    // 3:30 PM
  
  const isOpen = currentMinutes >= marketStart && currentMinutes <= marketEnd;
  
  console.log(`⏰ IST Time: ${hours}:${minutes < 10 ? '0' : ''}${minutes} | Market ${isOpen ? 'OPEN ✅' : 'CLOSED ❌'}`);
  
  return isOpen;
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

// ========== FETCH PCR DATA ==========
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

// ========== FETCH TOP GAINERS (FIXED) ==========
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
    
    // Handle different response formats
    let data = response.data.NIFTY || response.data.data || [];
    
    // Ensure data is an array
    if (!Array.isArray(data)) {
      console.log('Gainers data is not an array:', typeof data);
      return [];
    }
    
    if (data.length === 0) {
      console.log('No gainers data available yet');
      return [];
    }
    
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

// ========== FETCH TOP LOSERS (FIXED) ==========
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
    
    // Handle different response formats
    let data = response.data.NIFTY || response.data.data || [];
    
    // Ensure data is an array
    if (!Array.isArray(data)) {
      console.log('Losers data is not an array:', typeof data);
      return [];
    }
    
    if (data.length === 0) {
      console.log('No losers data available yet');
      return [];
    }
    
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

// ========== FETCH MOST ACTIVE (FIXED) ==========
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
    
    // Handle different response formats
    let data = response.data.NIFTY || response.data.data || [];
    
    // Ensure data is an array
    if (!Array.isArray(data)) {
      console.log('Most active data is not an array:', typeof data);
      return [];
    }
    
    if (data.length === 0) {
      console.log('No most active data available yet');
      return [];
    }
    
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
    
    const timestamp = new Date().toISOString();
    
    // Store in live data
    marketData = {
      indices,
      gainers,
      losers,
      mostActive: active,
      lastUpdate: timestamp
    };
    
    // If we have valid data, update closing snapshot
    if (indices.length > 0) {
      closingData = {
        indices,
        gainers,
        losers,
        mostActive: active,
        closeDate: new Date().toLocaleDateString('en-IN'),
        lastUpdate: timestamp
      };
      console.log(`✅ Market data updated - Indices: ${indices.length}, Gainers: ${gainers.length}, Losers: ${losers.length}, Active: ${active.length}`);
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
      console.log(`✅ NIFTY PCR: ${niftyData.pcr} (Underlying: ${niftyData.underlyingValue})`);
    }
    
    if (bankniftyData.success) {
      const entry = {
        time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        ...bankniftyData
      };
      todayHistory.BANKNIFTY.push(entry);
      console.log(`✅ BANKNIFTY PCR: ${bankniftyData.pcr} (Underlying: ${bankniftyData.underlyingValue})`);
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
  }
}

// ========== API ENDPOINTS ==========

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    marketOpen: isMarketHours(),
    timestamp: new Date().toISOString(),
    dataAvailable: {
      indices: marketData.indices.length,
      gainers: marketData.gainers.length,
      losers: marketData.losers.length,
      mostActive: marketData.mostActive.length
    }
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

// Get all market data - REAL-TIME (FIXED)
app.get('/api/market/overview', (req, res) => {
  const isOpen = isMarketHours();
  todayHistory.marketOpen = isOpen; // Update the flag
  
  let data;
  
  if (isOpen) {
    // Market is OPEN - use live data if available, otherwise use closing
    if (marketData.indices.length > 0) {
      data = { ...marketData, marketOpen: true, dataType: 'live' };
    } else if (closingData.indices.length > 0) {
      data = { ...closingData, marketOpen: true, dataType: 'closing-live' };
    } else {
      data = {
        indices: [],
        gainers: [],
        losers: [],
        mostActive: [],
        lastUpdate: null,
        marketOpen: true,
        dataType: 'waiting'
      };
    }
  } else {
    // Market is CLOSED - use closing snapshot
    data = { 
      ...closingData, 
      marketOpen: false, 
      dataType: 'closing' 
    };
  }
  
  res.json({
    success: true,
    ...data
  });
});

app.get('/api/market/closing', (req, res) => {
  res.json({
    success: true,
    ...closingData
  });
});

app.get('/api/market/indices', (req, res) => {
  const isOpen = isMarketHours();
  const data = isOpen && marketData.indices.length > 0 ? marketData : closingData;
  res.json({
    success: true,
    indices: data.indices,
    lastUpdate: data.lastUpdate,
    marketOpen: isOpen
  });
});

app.get('/api/market/gainers', (req, res) => {
  const isOpen = isMarketHours();
  const data = isOpen && marketData.gainers.length > 0 ? marketData : closingData;
  res.json({
    success: true,
    gainers: data.gainers,
    lastUpdate: data.lastUpdate,
    marketOpen: isOpen
  });
});

app.get('/api/market/losers', (req, res) => {
  const isOpen = isMarketHours();
  const data = isOpen && marketData.losers.length > 0 ? marketData : closingData;
  res.json({
    success: true,
    losers: data.losers,
    lastUpdate: data.lastUpdate,
    marketOpen: isOpen
  });
});

app.get('/api/market/active', (req, res) => {
  const isOpen = isMarketHours();
  const data = isOpen && marketData.mostActive.length > 0 ? marketData : closingData;
  res.json({
    success: true,
    mostActive: data.mostActive,
    lastUpdate: data.lastUpdate,
    marketOpen: isOpen
  });
});

// Manual trigger endpoint for testing/forcing updates
app.get('/api/trigger/fetch', async (req, res) => {
  console.log('🔄 Manual fetch triggered');
  
  try {
    await autoFetchMarketData();
    
    res.json({
      success: true,
      message: 'Data fetch triggered',
      marketOpen: isMarketHours(),
      dataFetched: {
        indices: marketData.indices.length,
        gainers: marketData.gainers.length,
        losers: marketData.losers.length,
        mostActive: marketData.mostActive.length
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========== CRON JOBS ==========

// Fetch market data every 1 minute
cron.schedule('* * * * *', () => {
  resetDailyData();
  autoFetchMarketData();
  autoFetchPCRData();
});

// Daily reset at 9:00 AM
cron.schedule('0 9 * * *', () => {
  console.log('🔄 Daily reset at 9:00 AM');
  resetDailyData();
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Market hours: 09:15 - 15:30 IST`);
  console.log(`⏰ Current status: ${isMarketHours() ? 'MARKET OPEN ✅' : 'MARKET CLOSED ❌'}`);
  
  // Initial fetch on startup
  ensureSession().then(() => {
    autoFetchMarketData();
    if (isMarketHours()) {
      autoFetchPCRData();
    }
  });
});
