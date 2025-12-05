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

let pcrHistory = {
  NIFTY: [],
  BANKNIFTY: [],
  date: new Date().toLocaleDateString('en-IN'),
  marketOpen: false,
  lastFrozenData: null // Store 3:30 PM data
};

// ========== MARKET HOURS CHECK ==========
function isMarketHours() {
  const now = new Date();
  const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  
  const day = istTime.getDay();
  const hours = istTime.getHours();
  const minutes = istTime.getMinutes();
  
  if (day === 0 || day === 6) return false;
  
  const currentMinutes = hours * 60 + minutes;
  const marketStart = 9 * 60 + 15;
  const marketEnd = 15 * 60 + 30;
  
  return currentMinutes >= marketStart && currentMinutes <= marketEnd;
}

// ========== GET SENTIMENT FROM PCR ==========
function getSentiment(pcr) {
  if (pcr < 0.7) return 'Strong Bearish';
  if (pcr >= 0.7 && pcr < 0.9) return 'Bearish';
  if (pcr >= 0.9 && pcr <= 1.1) return 'Neutral';
  if (pcr > 1.1 && pcr <= 1.3) return 'Neutral-Bullish';
  if (pcr > 1.3 && pcr <= 1.5) return 'Bullish';
  return 'Strong Bullish';
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
    const sentiment = getSentiment(pcr);
    
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
      sentiment,
      timestamp: new Date().toLocaleString('en-IN'),
      fetchedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error(`Error fetching ${symbol} PCR:`, error.message);
    return { success: false, symbol, error: error.message };
  }
}

// ========== AUTO-FETCH PCR DATA (3-MINUTE INTERVALS) ==========
async function autoFetchPCRData() {
  if (!isMarketHours()) {
    pcrHistory.marketOpen = false;
    // Freeze at last data point
    return;
  }
  
  pcrHistory.marketOpen = true;
  
  console.log('🔄 Fetching PCR data...');
  
  try {
    const [niftyData, bankniftyData] = await Promise.all([
      fetchPCRData('NIFTY'),
      fetchPCRData('BANKNIFTY')
    ]);
    
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const timeString = istTime.toLocaleTimeString('en-IN', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    });
    
    if (niftyData.success) {
      const entry = {
        time: timeString,
        ...niftyData
      };
      pcrHistory.NIFTY.push(entry);
      console.log(`✅ NIFTY PCR: ${niftyData.pcr} | Sentiment: ${niftyData.sentiment}`);
    }
    
    if (bankniftyData.success) {
      const entry = {
        time: timeString,
        ...bankniftyData
      };
      pcrHistory.BANKNIFTY.push(entry);
      console.log(`✅ BANKNIFTY PCR: ${bankniftyData.pcr} | Sentiment: ${bankniftyData.sentiment}`);
    }
    
    // Store last frozen data at 3:30 PM
    pcrHistory.lastFrozenData = {
      NIFTY: pcrHistory.NIFTY,
      BANKNIFTY: pcrHistory.BANKNIFTY,
      date: pcrHistory.date
    };
    
  } catch (error) {
    console.error('Error in autoFetchPCRData:', error);
  }
}

// ========== DAILY RESET AT 9:00 AM ==========
function resetDailyData() {
  const today = new Date().toLocaleDateString('en-IN');
  const now = new Date();
  const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const hours = istTime.getHours();
  const minutes = istTime.getMinutes();
  
  // Reset at 9:00 AM if new day
  if (pcrHistory.date !== today && hours === 9 && minutes === 0) {
    console.log('🔄 New day - resetting PCR data at 9:00 AM');
    pcrHistory = {
      NIFTY: [],
      BANKNIFTY: [],
      date: today,
      marketOpen: false,
      lastFrozenData: null
    };
  }
}

// ========== API ENDPOINTS ==========

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    marketOpen: isMarketHours(),
    timestamp: new Date().toISOString(),
    entriesCount: {
      nifty: pcrHistory.NIFTY.length,
      banknifty: pcrHistory.BANKNIFTY.length
    }
  });
});

// Get PCR history (returns current day OR frozen data)
app.get('/api/pcr/history', (req, res) => {
  const isOpen = isMarketHours();
  
  let responseData = {
    success: true,
    date: pcrHistory.date,
    marketOpen: isOpen,
    NIFTY: pcrHistory.NIFTY,
    BANKNIFTY: pcrHistory.BANKNIFTY
  };
  
  // If market is closed and we have frozen data, use it
  if (!isOpen && pcrHistory.lastFrozenData) {
    responseData = {
      success: true,
      date: pcrHistory.lastFrozenData.date,
      marketOpen: false,
      NIFTY: pcrHistory.lastFrozenData.NIFTY,
      BANKNIFTY: pcrHistory.lastFrozenData.BANKNIFTY,
      frozen: true
    };
  }
  
  res.json(responseData);
});

// Get latest PCR values
app.get('/api/pcr/latest', (req, res) => {
  const niftyLatest = pcrHistory.NIFTY[pcrHistory.NIFTY.length - 1] || null;
  const bankniftyLatest = pcrHistory.BANKNIFTY[pcrHistory.BANKNIFTY.length - 1] || null;
  
  res.json({
    success: true,
    marketOpen: isMarketHours(),
    NIFTY: niftyLatest,
    BANKNIFTY: bankniftyLatest
  });
});

// Manual fetch endpoint
app.get('/api/pcr/fetch', async (req, res) => {
  if (!isMarketHours()) {
    return res.json({
      success: false,
      message: 'Market is closed. No fetching outside 9:15 AM - 3:30 PM.'
    });
  }
  
  await autoFetchPCRData();
  
  res.json({
    success: true,
    message: 'PCR data fetched',
    entriesCount: {
      nifty: pcrHistory.NIFTY.length,
      banknifty: pcrHistory.BANKNIFTY.length
    }
  });
});

// ========== CRON JOBS ==========

// Fetch PCR data every 3 minutes during market hours (9:18, 9:21, 9:24...)
cron.schedule('*/3 9-15 * * 1-5', () => {
  resetDailyData();
  
  const now = new Date();
  const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const hours = istTime.getHours();
  const minutes = istTime.getMinutes();
  
  // Only fetch between 9:15 - 15:30
  const currentMin = hours * 60 + minutes;
  const start = 9 * 60 + 15;
  const end = 15 * 60 + 30;
  
  if (currentMin >= start && currentMin <= end) {
    // Start from 9:18 (3 minutes after market open)
    if (currentMin >= start + 3) {
      autoFetchPCRData();
    }
  }
});

// Daily reset at 9:00 AM
cron.schedule('0 9 * * 1-5', () => {
  console.log('🔄 Daily reset at 9:00 AM');
  resetDailyData();
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`🚀 PCR Tracker Server running on port ${PORT}`);
  console.log(`📊 Market hours: 09:15 - 15:30 IST`);
  console.log(`⏰ Current status: ${isMarketHours() ? 'MARKET OPEN ✅' : 'MARKET CLOSED ❌'}`);
  console.log(`🕐 PCR fetch interval: Every 3 minutes (starting 9:18 AM)`);
  
  // Initial fetch if market is open and past 9:18 AM
  ensureSession().then(() => {
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const hours = istTime.getHours();
    const minutes = istTime.getMinutes();
    const currentMin = hours * 60 + minutes;
    const firstFetch = 9 * 60 + 18; // 9:18 AM
    
    if (isMarketHours() && currentMin >= firstFetch) {
      autoFetchPCRData();
    }
  });
});
