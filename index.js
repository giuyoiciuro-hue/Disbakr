const express = require('express');
const axios = require('axios');
const { MACD, RSI } = require('technicalindicators');
const fs = require('fs-extra');
const path = require('path');
const pLimit = (limit) => {
    let active = 0;
    const queue = [];
    const next = () => {
        active--;
        if (queue.length > 0) {
            queue.shift()();
        }
    };
    return (fn) => new Promise((resolve, reject) => {
        const run = async () => {
            active++;
            try {
                resolve(await fn());
            } catch (err) {
                reject(err);
            } finally {
                next();
            }
        };
        if (active < limit) {
            run();
        } else {
            queue.push(run);
        }
    });
};
const ccxt = require('ccxt');

const STABLE_SYMBOLS = [
    'USDT', 'USDC', 'BUSD', 'DAI', 'FDUSD', 'TUSD', 'USDP', 'USDD', 'GUSD', 'FRAX', 'LUSD', 'EURC', 'USDAI'
];

const binance = new ccxt.binance({ 
    enableRateLimit: true,
    options: {
        'adjustForTimeDifference': true,
        'recvWindow': 10000,
    }
});

// قائمة عناوين البروكسي العامة لتجاوز الحظر الجغرافي
const PROXY_LIST = [
    'https://api.allorigins.win/raw?url=',
    'https://api.codetabs.com/v1/proxy/?quest=',
    'https://thingproxy.freeboard.io/fetch/',
    'https://cors-anywhere.herokuapp.com/'
];

async function fetchWithRestrictedFallbacks(exchangeInstance, methodName, ...args) {
    try {
        return await exchangeInstance[methodName](...args);
    } catch (e) {
        if (e.message.includes('restricted location') || e.message.includes('451')) {
            console.log(`Detected restricted location for ${exchangeInstance.id}. Attempting proxy fallbacks...`);
            
            // محاولة استخدام البروكسيات المجانية من القائمة
            for (const proxyBase of PROXY_LIST) {
                try {
                    console.log(`Attempting free proxy: ${proxyBase}`);
                    // CCXT supports 'proxy' property which prefixes the URL
                    exchangeInstance.proxy = proxyBase;
                    const result = await exchangeInstance[methodName](...args);
                    console.log(`Success with proxy: ${proxyBase}`);
                    return result;
                } catch (proxyErr) {
                    console.error(`Proxy ${proxyBase} failed: ${proxyErr.message}`);
                    continue;
                }
            }

            // محاولة العناوين البديلة كحل ثانٍ خاص بـ Binance
            if (exchangeInstance.id === 'binance') {
                const alternativeUrls = [
                    'https://api1.binance.com',
                    'https://api2.binance.com',
                    'https://api3.binance.com',
                    'https://api4.binance.com',
                    'https://data-api.binance.vision'
                ];
                for (const baseUrl of alternativeUrls) {
                    try {
                        console.log(`Trying Binance alternative URL: ${baseUrl}`);
                        exchangeInstance.urls['api']['public'] = baseUrl;
                        return await exchangeInstance[methodName](...args);
                    } catch (err) {
                        continue;
                    }
                }
            }
        }
        throw e;
    }
}

async function getOHLCV(symbol, interval) {
    // Map internal intervals to CCXT intervals
    const timeframeMap = {
        '1h': '1h',
        '4h': '4h',
        '1d': '1d',
        '1w': '1w'
    };
    const tf = timeframeMap[interval] || '1d';
    
    try {
        const ohlcv = await fetchWithRestrictedFallbacks(binance, 'fetchOHLCV', symbol, tf, undefined, 100);
        return ohlcv; 
    } catch (e) {
        console.error(`Error fetching OHLCV for ${symbol} on Binance:`, e.message);
        return null;
    }
}

async function fetchWithRetry(url, params, retries = 5) {
    try {
        const res = await axios.get(url, { params, timeout: 15000 });
        if (url.includes('coingecko.com')) {
            // Keep a smaller delay for price updates to be safe
            await new Promise(r => setTimeout(r, 1000));
        }
        return res;
    } catch (e) {
        if (e.response && e.response.status === 429 && retries > 0) {
            console.log(`Rate limited on ${url}, retrying in 5s... (${retries} left)`);
            await new Promise(r => setTimeout(r, 5000));
            return fetchWithRetry(url, params, retries - 1);
        }
        throw e;
    }
}

const app = express();
const port = 5000;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const DATA_FILE = path.join(__dirname, 'last_results.json');
const RSI_DATA_FILE = path.join(__dirname, 'rsi_results.json');
const ARB_DATA_FILE = path.join(__dirname, 'arbitrage_results.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const RSI_SETTINGS_FILE = path.join(__dirname, 'rsi_settings.json');
const limit = pLimit(10);

app.use(express.json());
app.use(express.static(__dirname));

const EXCHANGES = [
    'binance', 'bybit', 'okx', 'kucoin', 'gateio', 
    'mexc', 'bitget', 'kraken', 'bitfinex', 'coinbase'
];

const COMMON_SYMBOLS = [
    'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'ADA/USDT', 'AVAX/USDT', 'DOT/USDT', 'DOGE/USDT', 'LINK/USDT', 
    'MATIC/USDT', 'LTC/USDT', 'SHIB/USDT', 'TRX/USDT', 'NEAR/USDT', 'UNI/USDT', 'ICP/USDT', 'ETC/USDT', 'FIL/USDT', 'ATOM/USDT',
    'APT/USDT', 'OP/USDT', 'ARB/USDT', 'TIA/USDT', 'SUI/USDT', 'SEI/USDT', 'INJ/USDT', 'RNDR/USDT', 'FET/USDT', 'STX/USDT',
    'KAS/USDT', 'IMX/USDT', 'PEPE/USDT', 'BONK/USDT', 'WIF/USDT', 'ORDI/USDT', 'BEAM/USDT', 'PYTH/USDT', 'JUP/USDT', 'DYM/USDT',
    'STRK/USDT', 'MANTA/USDT', 'ALT/USDT', 'PIXEL/USDT', 'RON/USDT', 'ZETA/USDT', 'MAVIA/USDT', 'XAI/USDT', 'WLD/USDT', 'ARKM/USDT',
    'PENDLE/USDT', 'AGIX/USDT', 'OCEAN/USDT', 'GLM/USDT', 'AKT/USDT', 'NOS/USDT', 'RENDER/USDT', 'THETA/USDT', 'HBAR/USDT', 'VET/USDT',
    'GRT/USDT', 'AAVE/USDT', 'EGLD/USDT', 'SAND/USDT', 'MANA/USDT', 'AXS/USDT', 'GALA/USDT', 'FLOW/USDT', 'CHZ/USDT', 'EOS/USDT',
    'NEO/USDT', 'IOTA/USDT', 'MKR/USDT', 'SNX/USDT', 'CRV/USDT', 'LDO/USDT', 'RPL/USDT', 'FXS/USDT', 'COMP/USDT', 'ZEC/USDT',
    'DASH/USDT', 'XMR/USDT', 'KAVA/USDT', 'ZIL/USDT', 'HOT/USDT', 'RVN/USDT', 'BAT/USDT', 'ENJ/USDT', 'ANKR/USDT', 'ROSE/USDT',
    'CELO/USDT', 'MINA/USDT', 'QTUM/USDT', 'OMG/USDT', 'ICX/USDT', 'ONT/USDT', 'LSK/USDT', 'SC/USDT', 'DGB/USDT', 'XVG/USDT',
    'FLOKI/USDT', 'BGB/USDT', 'ASTR/USDT', 'OSMO/USDT', 'JASMY/USDT', 'BTT/USDT', 'LUNC/USDT', 'USTC/USDT', 'GMT/USDT', 'GALA/USDT',
    'TFUEL/USDT', 'STG/USDT', 'JOE/USDT', 'MASK/USDT', 'ID/USDT', 'LINA/USDT', 'WOO/USDT', 'CFX/USDT', 'HOOK/USDT', 'STPT/USDT',
    'NMR/USDT', 'HIVE/USDT', 'STMX/USDT', 'RIF/USDT', 'CKB/USDT', 'RLC/USDT', 'UMA/USDT', 'BICO/USDT', 'GLMR/USDT', 'MOVR/USDT',
    'EVMOS/USDT', 'METIS/USDT', 'CANTO/USDT', 'SXP/USDT', 'ZRX/USDT', 'BAL/USDT', 'BAND/USDT', 'API3/USDT', 'TRB/USDT', 'STORJ/USDT',
    'BLUR/USDT', 'LQTY/USDT', 'RDNT/USDT', 'VELO/USDT', 'RSR/USDT', 'ACH/USDT', 'AUDIO/USDT', 'SKL/USDT', 'CHR/USDT', 'DENT/USDT',
    'REEF/USDT', 'CTSI/USDT', 'KNC/USDT', 'REN/USDT', 'CVC/USDT', 'IOTX/USDT', 'ALPHA/USDT', 'ALICE/USDT', 'BAKE/USDT', 'BEL/USDT',
    'MBOX/USDT', 'DAR/USDT', 'KEY/USDT', 'ATA/USDT', 'PROS/USDT', 'MTL/USDT', 'NKN/USDT', 'OGN/USDT', 'PUNDIX/USDT', 'WIN/USDT',
    'TLM/USDT', 'VOXEL/USDT', 'FORTH/USDT', 'OXT/USDT', 'LOOM/USDT', 'PERP/USDT', 'OOS/USDT', 'RARE/USDT', 'SUPER/USDT', 'POLS/USDT',
    'FRONT/USDT', 'LTO/USDT', 'DUSK/USDT', 'CEL/USDT', 'STORM/USDT', 'MDT/USDT', 'COTI/USDT', 'DATA/USDT', 'SYS/USDT', 'TOMO/USDT',
    'WRX/USDT', 'WAN/USDT', 'FUN/USDT', 'QNT/USDT', 'SNT/USDT', 'UTK/USDT', 'PROM/USDT', 'STRAX/USDT', 'STEEM/USDT', 'VTHO/USDT'
];

const saveResults = async (data, file = DATA_FILE) => {
    await fs.writeJson(file, data);
};

const loadResults = async (file = DATA_FILE) => {
    if (await fs.pathExists(file)) {
        return await fs.readJson(file);
    }
    return [];
};

const saveSettings = async (settings, file = SETTINGS_FILE) => {
    await fs.writeJson(file, settings);
};

const loadSettings = async (file = SETTINGS_FILE) => {
    if (await fs.pathExists(file)) {
        return await fs.readJson(file);
    }
    if (file === RSI_SETTINGS_FILE) return { intervals: ['1d'], type: '30/70' };
    return { intervals: ['1d'], type: 'histogram' };
};

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/settings', async (req, res) => {
    const settings = await loadSettings();
    res.json(settings);
});

app.post('/save-settings', async (req, res) => {
    await saveSettings(req.body);
    res.json({ success: true });
});

app.get('/rsi-settings', async (req, res) => {
    const settings = await loadSettings(RSI_SETTINGS_FILE);
    res.json(settings);
});

app.post('/save-rsi-settings', async (req, res) => {
    await saveSettings(req.body, RSI_SETTINGS_FILE);
    res.json({ success: true });
});

app.get('/last-results', async (req, res) => {
    const data = await loadResults();
    res.json(data);
});

app.get('/rsi-last-results', async (req, res) => {
    const data = await loadResults(RSI_DATA_FILE);
    res.json(data);
});

function formatTicker(ticker) {
    const symbol = ticker.symbol.replace('/', '');
    return { 
        symbol: symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol,
        id: ticker.symbol,
        currentPrice: ticker.last
    };
}

app.get('/analyze-rsi', async (req, res) => {
    console.log('RSI analysis started', { query: req.query });
    const settings = await loadSettings(RSI_SETTINGS_FILE);
    const intervals = (req.query.intervals || settings.intervals.join(',')).split(',');
    const rsiType = req.query.type || settings.type;
    const [lowerBound, upperBound] = rsiType.split('/').map(Number);
    console.log('RSI analysis settings loaded', { intervals, rsiType, lowerBound, upperBound });

    try {
        console.log('Fetching tickers from Binance...');
        const tickers = await fetchWithRestrictedFallbacks(binance, 'fetchTickers');
        const usdtTickers = Object.values(tickers).filter(t => t.symbol && t.symbol.endsWith('/USDT'));
        console.log(`Found ${usdtTickers.length} USDT tickers`);
        const symbols = usdtTickers
            .sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0))
            .slice(0, 50) 
            .map(formatTicker);
        console.log(`Selected ${symbols.length} symbols for analysis`);

        const resultsMap = new Map();

        const analyzeSymbolRSI = async (coinData, interval) => {
            const { symbol } = coinData;
            const ccxtSymbol = `${symbol}USDT`;
            try {
                const ohlcv = await getOHLCV(ccxtSymbol, interval);
                if (!ohlcv || !Array.isArray(ohlcv)) {
                    console.log(`No OHLCV data for ${ccxtSymbol} on ${interval}`);
                    return null;
                }
                if (ohlcv.length < 30) {
                    console.log(`Not enough data for ${ccxtSymbol} on ${interval} (length: ${ohlcv.length})`);
                    return null;
                }

                const lows = ohlcv.map(d => d[3]);
                const closes = ohlcv.map(d => d[4]);

                const rsiValues = RSI.calculate({ values: closes, period: 14 });
                if (rsiValues.length < 15) return null;

                const offset = closes.length - rsiValues.length;
                const troughs = [];
                const w = (interval === '1h') ? 5 : (interval === '4h' ? 6 : (interval === '1d' ? 4 : 2));

                for (let i = w; i < rsiValues.length - w; i++) {
                    if (rsiValues[i] <= rsiValues[i - 1] && rsiValues[i] <= rsiValues[i + 1]) {
                        if (rsiValues[i] < rsiValues[i - 1] || rsiValues[i] < rsiValues[i + 1]) {
                            let isLocalMin = true;
                            for (let j = 1; j <= w; j++) {
                                if (rsiValues[i] > rsiValues[i - j] || rsiValues[i] > rsiValues[i + j]) {
                                    isLocalMin = false; break;
                                }
                            }
                            if (isLocalMin) troughs.push(i);
                        }
                    }
                }

                if (troughs.length >= 2) {
                    const lastTroughIdx = troughs[troughs.length - 1];
                    const prevTroughIdx = troughs[troughs.length - 2];
                    const distance = lastTroughIdx - prevTroughIdx;

                    if (distance >= 5 && distance <= 80) {
                        const valAtLast = rsiValues[lastTroughIdx];
                        const valAtPrev = rsiValues[prevTroughIdx];
                        const priceAtLast = lows[lastTroughIdx + offset];
                        const priceAtPrev = lows[prevTroughIdx + offset];

                        if (priceAtLast <= priceAtPrev && valAtLast > valAtPrev && valAtLast <= (lowerBound + 5)) {
                            const priceDiffPct = priceAtPrev > 0 ? ((priceAtPrev - priceAtLast) / priceAtPrev) * 100 : 0;
                            const indicatorImprovementPct = ((valAtLast - valAtPrev) / valAtPrev) * 100;

                            let strength = 70 + (Math.min(15, priceDiffPct * 2) + Math.min(15, indicatorImprovementPct / 2));

                            return {
                                symbol,
                                currentPrice: closes[closes.length - 1],
                                strength: Math.min(100, strength),
                                interval,
                                isMatch: true
                            };
                        }
                    }
                }

                const lastRsi = rsiValues[rsiValues.length - 1];
                let baseStrength = 0;
                if (lastRsi < lowerBound) baseStrength = 40 + (lowerBound - lastRsi) * 2;
                else if (lastRsi < (lowerBound + 10)) baseStrength = 20 + (lowerBound + 10 - lastRsi);

                return {
                    symbol,
                    currentPrice: closes[closes.length - 1],
                    strength: Math.min(69, baseStrength),
                    interval,
                    isMatch: false
                };
            } catch (e) { return null; }
        };

        const allAnalyzedResults = [];
        const chunkSize = 20; // Binance has high limits, but let's be reasonable
        for (let i = 0; i < symbols.length; i += chunkSize) {
            const chunk = symbols.slice(i, i + chunkSize);
            const chunkTasks = [];
            for (const interval of intervals) {
                for (const symbolData of chunk) {
                    chunkTasks.push(limit(() => analyzeSymbolRSI(symbolData, interval)));
                }
            }
            const results = await Promise.all(chunkTasks);
            allAnalyzedResults.push(...results.filter(r => r !== null));
        }

        symbols.forEach(s => {
            resultsMap.set(s.symbol, {
                symbol: s.symbol,
                currentPrice: s.currentPrice,
                strength: 0,
                intervals: [],
                matches: []
            });
        });

        allAnalyzedResults.filter(r => r !== null).forEach(r => {
            const existing = resultsMap.get(r.symbol);
            if (existing) {
                existing.intervals.push(r.interval);
                if (r.isMatch) {
                    existing.matches.push(r.interval);
                    existing.strength = Math.max(existing.strength, r.strength + (existing.matches.length > 1 ? 10 : 0));
                } else {
                    existing.strength = Math.max(existing.strength, r.strength);
                }
            }
        });

        const finalResults = Array.from(resultsMap.values())
            .sort((a, b) => {
                if (b.matches.length !== a.matches.length) return b.matches.length - a.matches.length;
                return b.strength - a.strength;
            });
        console.log(`RSI analysis complete. Found ${finalResults.length} results.`);
        await saveResults(finalResults, RSI_DATA_FILE);
        res.json(finalResults);
    } catch (e) { 
        console.error('RSI analysis error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/analyze', async (req, res) => {
    console.log('MACD analysis started', { query: req.query });
    const settings = await loadSettings();
    const intervals = (req.query.intervals || settings.intervals.join(',')).split(',');
    const analysisType = req.query.type || settings.type;
    console.log('MACD analysis settings loaded', { intervals, analysisType });

    try {
        console.log('Fetching tickers from Binance...');
        const tickers = await fetchWithRestrictedFallbacks(binance, 'fetchTickers');
        const usdtTickers = Object.values(tickers).filter(t => t.symbol && t.symbol.endsWith('/USDT'));
        console.log(`Found ${usdtTickers.length} USDT tickers`);
        const symbols = usdtTickers
            .sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0))
            .slice(0, 50) 
            .map(formatTicker);
        console.log(`Selected ${symbols.length} symbols for analysis`);

        const resultsMap = new Map();

        const analyzeSymbol = async (coinData, interval) => {
            const { symbol } = coinData;
            const ccxtSymbol = `${symbol}USDT`;
            try {
                const ohlcv = await getOHLCV(ccxtSymbol, interval);
                if (!ohlcv || !Array.isArray(ohlcv)) {
                    console.log(`No OHLCV data for ${ccxtSymbol} on ${interval}`);
                    return null;
                }
                if (ohlcv.length < 30) {
                    console.log(`Not enough data for ${ccxtSymbol} on ${interval} (length: ${ohlcv.length})`);
                    return null;
                }

                const lows = ohlcv.map(d => d[3]);
                const closes = ohlcv.map(d => d[4]);

                const macdInput = {
                    values: closes,
                    fastPeriod: 12,
                    slowPeriod: 26,
                    signalPeriod: 9,
                    SimpleMAOscillator: false,
                    SimpleMASignal: false
                };

                const macdResults = MACD.calculate(macdInput);
                if (macdResults.length < 20) return null;

                const targetData = (analysisType === 'histogram') 
                    ? macdResults.map(m => m.histogram) 
                    : macdResults.map(m => m.MACD);

                const macdLines = macdResults.map(m => m.MACD);
                const offset = closes.length - targetData.length;

                if (analysisType === 'histogram') {
                    // 1) Find Price Lows (Troughs)
                    const priceTroughs = [];
                    const pw = 4; // Window for price trough
                    for (let i = pw; i < lows.length - pw; i++) {
                        if (lows[i] <= lows[i - 1] && lows[i] <= lows[i + 1]) {
                            let isLocal = true;
                            for (let j = 1; j <= pw; j++) {
                                if (lows[i] > lows[i - j] || lows[i] > lows[i + j]) { isLocal = false; break; }
                            }
                            if (isLocal) priceTroughs.push(i);
                        }
                    }

                    if (priceTroughs.length >= 2) {
                        // Look for divergence between last two price troughs
                        for (let t = priceTroughs.length - 1; t >= 1; t--) {
                            const lastPriceIdx = priceTroughs[t];
                            const prevPriceIdx = priceTroughs[t - 1];
                            const distance = lastPriceIdx - prevPriceIdx;

                            if (distance < 5 || distance > 60) continue;

                            const offset = closes.length - targetData.length;
                            const mappedPrev = prevPriceIdx - offset;
                            const mappedLast = lastPriceIdx - offset;

                            if (mappedPrev >= 0 && mappedLast < targetData.length) {
                                const hPrevVal = targetData[mappedPrev];
                                const hLastVal = targetData[mappedLast];

                                const pricePrev = lows[prevPriceIdx];
                                const priceLast = lows[lastPriceIdx];
                                
                                if (priceLast < pricePrev && hLastVal > hPrevVal && hPrevVal < 0) {
                                    // Filter: Wave Clarity (Ensure no massive green spikes between troughs)
                                    const sliceBetween = targetData.slice(mappedPrev + 1, mappedLast);
                                    if (sliceBetween.length > 0) {
                                        const maxGreen = Math.max(...sliceBetween);
                                        if (maxGreen > Math.abs(hPrevVal) * 0.5) continue;
                                    }

                                    const currentHist = targetData[targetData.length - 1];
                                    const prevHist = targetData[targetData.length - 2];
                                    
                                    if (currentHist > prevHist) {
                                        const priceDiff = ((pricePrev - priceLast) / pricePrev) * 100;
                                        const convDiff = (hLastVal - hPrevVal);
                                        let strength = 80 + (priceDiff * 2) + (Math.min(20, convDiff * 500));

                                        return {
                                            symbol,
                                            currentPrice: closes[closes.length - 1],
                                            strength: Math.min(100, strength),
                                            interval,
                                            isMatch: true
                                        };
                                    }
                                }
                            }
                        }
                    }
                } else {
                    const macdTroughs = [];
                    const w = (interval === '1h') ? 5 : (interval === '4h' ? 6 : (interval === '1d' ? 4 : 2));

                    for (let i = w; i < targetData.length - w; i++) {
                        if (targetData[i] <= targetData[i - 1] && targetData[i] <= targetData[i + 1]) {
                            let isLocalMin = true;
                            for (let j = 1; j <= w; j++) {
                                if (targetData[i] > targetData[i - j] || targetData[i] > targetData[i + j]) {
                                    isLocalMin = false; break;
                                }
                            }
                            if (isLocalMin) macdTroughs.push(i);
                        }
                    }

                    if (macdTroughs.length >= 2) {
                        for (let t = macdTroughs.length - 1; t >= 1; t--) {
                            const lastTroughIdx = macdTroughs[t];
                            const prevTroughIdx = macdTroughs[t - 1];
                            const distance = lastTroughIdx - prevTroughIdx;

                            if (distance < 5 || distance > 80) continue;

                            const valAtLast = targetData[lastTroughIdx];
                            const valAtPrev = targetData[prevTroughIdx];
                            const priceAtLast = lows[lastTroughIdx + offset];
                            const priceAtPrev = lows[prevTroughIdx + offset];

                            if (priceAtLast < priceAtPrev && valAtLast > valAtPrev && valAtLast < 0) {
                                const priceDiffPct = ((priceAtPrev - priceAtLast) / priceAtPrev) * 100;
                                let strength = 70 + (priceDiffPct * 2);

                                return {
                                    symbol,
                                    currentPrice: closes[closes.length - 1],
                                    strength: Math.min(100, strength),
                                    interval,
                                    isMatch: true
                                };
                            }
                        }
                    }
                }

                const lastHist = targetData[targetData.length - 1];
                const prevHist = targetData[targetData.length - 2];
                let baseStrength = 0;
                if (lastHist > prevHist && lastHist < 0) {
                    baseStrength = 40 + (Math.min(30, (lastHist - prevHist) / Math.abs(prevHist) * 100));
                }

                return {
                    symbol,
                    currentPrice: closes[closes.length - 1],
                    strength: Math.min(69, baseStrength),
                    interval,
                    isMatch: false
                };
            } catch (e) { 
                console.log(`Error analyzing ${symbol} on ${interval}:`, e.message);
                return null;
            }
        };

        const allAnalyzedResults = [];
        const chunkSize = 20;
        for (let i = 0; i < symbols.length; i += chunkSize) {
            const chunk = symbols.slice(i, i + chunkSize);
            const chunkTasks = [];
            for (const interval of intervals) {
                for (const symbolData of chunk) {
                    chunkTasks.push(limit(() => analyzeSymbol(symbolData, interval)));
                }
            }
            const results = await Promise.all(chunkTasks);
            allAnalyzedResults.push(...results.filter(r => r !== null));
        }

        symbols.forEach(s => {
            resultsMap.set(s.symbol, {
                symbol: s.symbol,
                currentPrice: s.currentPrice,
                strength: 0,
                intervals: [],
                matches: []
            });
        });

        allAnalyzedResults.filter(r => r !== null).forEach(r => {
            const existing = resultsMap.get(r.symbol);
            if (existing) {
                existing.intervals.push(r.interval);
                if (r.isMatch) {
                    existing.matches.push(r.interval);
                    existing.strength = Math.max(existing.strength, r.strength + (existing.matches.length > 1 ? 10 : 0));
                } else {
                    existing.strength = Math.max(existing.strength, r.strength);
                }
            }
        });

        const finalResults = Array.from(resultsMap.values())
            .sort((a, b) => {
                if (b.matches.length !== a.matches.length) {
                    return b.matches.length - a.matches.length;
                }
                return b.strength - a.strength;
            });
        console.log(`MACD analysis complete. Found ${finalResults.length} results.`);
        await saveResults(finalResults, DATA_FILE);
        res.json(finalResults);
    } catch (e) { 
        console.error('MACD analysis error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

// Optimized arbitrage logic directly in index.js
const ARB_EXCHANGES = [
    'binance', 'bybit', 'okx', 'kucoin', 'gateio', 
    'mexc', 'bitget', 'kraken', 'bitfinex', 'coinbase',
    'poloniex', 'hitbtc', 'coinex', 'ascendex', 'phemex', 
    'toobit', 'deepcoin', 'htx', 'huobi', 'whitebit', 'xt'
];

const arbExchangeInstances = {};
function getArbExchange(id) {
    if (!arbExchangeInstances[id]) {
        try {
            arbExchangeInstances[id] = new ccxt[id]({ enableRateLimit: true, timeout: 10000 });
        } catch (e) { return null; }
    }
    return arbExchangeInstances[id];
}

app.get('/api/arbitrage-last-results', async (req, res) => {
    const data = await loadResults(ARB_DATA_FILE);
    res.json(data);
});

app.get('/api/arbitrage', async (req, res) => {
    console.log('Arbitrage analysis started');
    try {
        const fetchTasks = ARB_EXCHANGES.map(id => (async () => {
            const ex = getArbExchange(id);
            if (!ex) {
                console.log(`Exchange ${id} not initialized`);
                return [];
            }
            try {
                const tickers = await fetchWithRestrictedFallbacks(ex, 'fetchTickers');
                const filtered = Object.values(tickers)
                    .filter(t => t.symbol && t.symbol.endsWith('/USDT') && t.bid > 0 && t.ask > 0)
                    .map(t => ({ 
                        exchange: id.toUpperCase(), 
                        symbol: t.symbol, 
                        bid: t.bid, 
                        ask: t.ask, 
                        bidVolume: t.bidVolume, 
                        askVolume: t.askVolume  
                    }));
                console.log(`Fetched ${filtered.length} tickers from ${id}`);
                return filtered;
            } catch (e) { 
                console.log(`Error fetching tickers from ${id}:`, e.message);
                return []; 
            }
        })());

        const allResults = await Promise.all(fetchTasks);
        const allTickers = allResults.flat();
        console.log(`Total tickers collected: ${allTickers.length}`);
                const groups = {};
                allTickers.forEach(t => {
                    if (!groups[t.symbol]) groups[t.symbol] = [];
                    groups[t.symbol].push(t);
                });

                const opportunities = [];
                for (const [symbol, tickers] of Object.entries(groups)) {
                    if (tickers.length < 2) continue;
                    
                    // We want to BUY at the lowest ASK and SELL at the highest BID
                    let minAskT = tickers[0], maxBidT = tickers[0];
                    tickers.forEach(t => {
                        if (t.ask < minAskT.ask) minAskT = t;
                        if (t.bid > maxBidT.bid) maxBidT = t;
                    });

                    // REAL Spread = (Best Bid Price - Best Ask Price) / Best Ask Price
                    const diff = ((maxBidT.bid - minAskT.ask) / minAskT.ask * 100);
                    
                    if (diff >= 0.1 && diff < 5 && minAskT.ask > 0.000001) {
                        opportunities.push({
                            symbol, 
                            maxDiff: diff.toFixed(2),
                            liquidityScore: Math.min(minAskT.askVolume || 0, maxBidT.bidVolume || 0),
                            prices: tickers.map(t => ({
                                exchange: t.exchange, 
                                price: t.bid, 
                                bid: t.bid,
                                ask: t.ask,
                                bidVolume: t.bidVolume,
                                askVolume: t.askVolume,
                                diff: ((t.bid - minAskT.ask) / minAskT.ask * 100).toFixed(2),
                                isMin: t.ask === minAskT.ask, 
                                isMax: t.bid === maxBidT.bid  
                            })).sort((a, b) => a.bid - b.bid)
                        });
                    }
                }
        const finalArbResults = { 
            timestamp: new Date().toISOString(),
            opportunities: opportunities.sort((a, b) => b.maxDiff - a.maxDiff) 
        };
        console.log(`Arbitrage analysis complete. Found ${opportunities.length} opportunities.`);
        await saveResults(finalArbResults, ARB_DATA_FILE);
        res.json(finalArbResults);
    } catch (e) { 
        console.error('Arbitrage analysis error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
});
