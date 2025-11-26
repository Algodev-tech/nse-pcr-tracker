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

// ========== SAMPLE DATA FOR TESTING ==========
const SAMPLE_CLOSING_DATA = {
  indices: [
    { name: 'NIFTY 50', value: 24413.50, change: 0.45, previousClose: 24304.35, open: 24320.10, high: 24455.80, low: 24289.25 },
    { name: 'NIFTY BANK', value: 53298.40, change: 1.12, previousClose: 52710.20, open: 52755.30, high: 53412.85, low: 52688.40 },
    { name: 'NIFTY MIDCAP 100', value: 56847.25, change: -0.28, previousClose: 57006.40, open: 56920.50, high: 57125.30, low: 56735.60 },
    { name: 'INDIA VIX', value: 13.42, change: -5.24, previousClose: 14.16, open: 14.05, high: 14.22, low: 13.35 },
    { name: 'NIFTY IT', value: 43521.35, change: 0.89, previousClose: 43138.20, open: 43175.80, high: 43598.45, low: 43052.30 },
    { name: 'NIFTY PHARMA', value: 22847.60, change: -0.52, previousClose: 22966.85, open: 22935.20, high: 23012.40, low: 22789.15 }
  ],
  gainers: [
    { symbol: 'ADANIPORTS', name: 'Adani Ports and Special Economic Zone Ltd', price: 1285.50, change: 4.25, volume: 8542100, value: 10985420000 },
    { symbol: 'TATAMOTORS', name: 'Tata Motors Ltd', price: 785.20, change: 3.87, volume: 12458900, value: 9784520000 },
    { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', price: 1742.30, change: 2.95, volume: 6845200, value: 11925840000 },
    { symbol: 'INFY', name: 'Infosys Ltd', price: 1886.45, change: 2.68, volume: 4521800, value: 8530125000 },
    { symbol: 'RELIANCE', name: 'Reliance Industries Ltd', price: 2845.60, change: 2.34, volume: 7854200, value: 22354880000 }
  ],
  losers: [
    { symbol: 'HINDALCO', name: 'Hindalco Industries Ltd', price: 642.35, change: -3.45, volume: 9852400, value: 6329184000 },
    { symbol: 'JSWSTEEL', name: 'JSW Steel Ltd', price: 895.80, change: -2.87, volume: 6421500, value: 5752854000 },
    { symbol: 'TATASTEEL', name: 'Tata Steel Ltd', price: 142.25, change: -2.65, volume: 18542300, value: 2637162000 },
    { symbol: 'COALINDIA', name: 'Coal India Ltd', price: 425.90, change: -2.42, volume: 5842100, value: 2488482000 },
    { symbol: 'NTPC', name: 'NTPC Ltd', price: 358.75, change: -1.98, volume: 11254800, value: 4038097000 }
  ],
  mostActive: [
    { symbol: 'RELIANCE', name: 'Reliance Industries Ltd', price: 2845.60, change: 2.34, volume: 7854200, value: 22354880000 },
    { symbol: 'TATAMOTORS', name: 'Tata Motors Ltd', price: 785.20, change: 3.87, volume: 12458900, value: 9784520000 },
    { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', price: 1742.30, change: 2.95, volume: 6845200, value: 11925840000 },
    { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd', price: 1298.55, change: 1.45, volume: 8952400, value: 11624538000 },
    { symbol: 'INFY', name: 'Infosys Ltd', price: 1886.45, change: 2.68, volume: 4521800, value: 8530125000 }
  ],
  closeDate: new Date().toLocaleDateString('en-IN'),
  lastUpdate: new Date().toISOString()
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
    } else if (closingData.indices.length === 0) {
      // If no real data and no closing data, use sample data
      console.log('📊 Using sample data for demonstration');
      closingData = SAMPLE_CLOSING_DATA;
    }
    
    todayHistory.marketOpen = isMarketHours();
  } catch (error) {
    console.error('Error in autoFetchMarketData:', error);
    // Use sample data on error if no closing data exists
    if (closingData.indices.length === 0) {
      console.log('📊 Using sample data due to fetch error');
      closingData = SAMPLE_CLOSING_DATA;
    }
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

// Get all market data with sample fallback
app.get('/api/market/overview', (req, res) => {
  let data;
  
  if (todayHistory.marketOpen && marketData.indices.length > 0) {
    data = { ...marketData };
  } else {
    data = { ...closingData };
  }
  
  // ALWAYS fill empty arrays with sample data
  const result = {
    success: true,
    indices: data.indices.length > 0 ? data.indices : SAMPLE_CLOSING_DATA.indices,
    gainers: data.gainers.length > 0 ? data.gainers : SAMPLE_CLOSING_DATA.gainers,
    losers: data.losers.length > 0 ? data.losers : SAMPLE_CLOSING_DATA.losers,
    mostActive: data.mostActive.length > 0 ? data.mostActive : SAMPLE_CLOSING_DATA.mostActive,
    closeDate: data.closeDate || SAMPLE_CLOSING_DATA.closeDate,
    lastUpdate: data.lastUpdate || SAMPLE_CLOSING_DATA.lastUpdate,
    marketOpen: todayHistory.marketOpen,
    dataType: todayHistory.marketOpen ? 'live' : 'closing'
  };
  
  res.json(result);
});


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
  const gainers = data.gainers.length > 0 ? data.gainers : SAMPLE_CLOSING_DATA.gainers;
  
  res.json({
    success: true,
    gainers: gainers,
    lastUpdate: data.lastUpdate
  });
});

app.get('/api/market/losers', (req, res) => {
  const data = todayHistory.marketOpen ? marketData : closingData;
  const losers = data.losers.length > 0 ? data.losers : SAMPLE_CLOSING_DATA.losers;
  
  res.json({
    success: true,
    losers: losers,
    lastUpdate: data.lastUpdate
  });
});

app.get('/api/market/active', (req, res) => {
  const data = todayHistory.marketOpen ? marketData : closingData;
  const mostActive = data.mostActive.length > 0 ? data.mostActive : SAMPLE_CLOSING_DATA.mostActive;
  
  res.json({
    success: true,
    mostActive: mostActive,
    lastUpdate: data.lastUpdate
  });
});

// ========== CRON JOBS ==========

cron.schedule('* * * * *', () => {
  resetDailyData();
  autoFetchPCRData();
});

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
  
  // Load sample data immediately on startup
  if (closingData.indices.length === 0) {
    closingData = SAMPLE_CLOSING_DATA;
    console.log('📊 Sample closing data loaded');
  }
  
  // Initial fetch
  ensureSession().then(() => {
    autoFetchMarketData();
    if (isMarketHours()) {
      autoFetchPCRData();
    }
  });
});
