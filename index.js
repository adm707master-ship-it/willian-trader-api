const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const SYMBOL = process.env.DERIV_SYMBOL || "1HZ25V";
const DERIV_APP_ID = process.env.DERIV_APP_ID || "1089";
const DERIV_URL = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`;
const MAX_PRICES = 600;

app.use(cors({ origin: "*" }));
app.use(express.json());

// ======================
// ESTADO
// ======================
let state = {
  status: "desconectado",
  derivStatus: "desconectado",
  frontendClients: 0,
  symbol: SYMBOL,
  price: null,
  candles: [],
  lastUpdate: null,
  lastError: null,

  sma9: null,
  sma34: null,
  ema9: null,
  ema21: null,
  rsi14: null,
  volatility: null,
  slope: null,
  score: 0,
  signal: null,

  lastSignalDirection: null,
  lastSignalPrice: null,
  lastSignalTime: null,

  wins: 0,
  losses: 0,
  canceladas: 0,

  trades: [],

  bestHour: null,
  worstHour: null,
};

// ======================
// INDICADORES
// ======================
function sma(arr, period) {
  if (arr.length < period) return null;
  return arr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function ema(arr, period) {
  if (arr.length < period) return null;

  const k = 2 / (period + 1);
  let value = arr[0];

  for (let i = 1; i < arr.length; i++) {
    value = arr[i] * k + value * (1 - k);
  }

  return value;
}

function rsi(arr, period = 14) {
  if (arr.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = arr.length - period; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];

    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;

  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calculateVolatility(arr) {
  if (arr.length < 20) return null;

  const values = arr.slice(-20);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
