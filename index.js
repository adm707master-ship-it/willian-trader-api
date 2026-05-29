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

const state = {
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
  signal: null
};

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

function volatility(arr) {
  if (arr.length < 20) return null;

  const values = arr.slice(-20);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / values.length;

  return Math.sqrt(variance);
}

function slope(arr) {
  if (arr.length < 10) return null;
  return arr[arr.length - 1] - arr[arr.length - 10];
}

function round(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Number(value.toFixed(digits));
}

const frontend = new WebSocket.Server({ server });

function makePayload(type) {
  return JSON.stringify({
    type,
    data: state,
    ...state
  });
}

function broadcast(type = "market:update") {
  const message = makePayload(type);

  frontend.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function updateMath() {
  const c = state.candles;

  state.sma9 = round(sma(c, 9));
  state.sma34 = round(sma(c, 34));
  state.ema9 = round(ema(c, 9));
  state.ema21 = round(ema(c, 21));
  state.rsi14 = round(rsi(c), 2);
  state.volatility = round(volatility(c));
  state.slope = round(slope(c));

  let score = 0;
  let signal = null;

  if (state.sma9 !== null && state.sma34 !== null && state.rsi14 !== null) {
    const trend = state.sma9 - state.sma34;
    const sideways = Math.abs(trend) < 0.3;

    if (!sideways) {
      score += 35;

      if (Math.abs(trend) > 0.8) score += 20;

      if (trend > 0 && state.rsi14 < 70) {
        score += 25;
        signal = "CALL";
      }

      if (trend < 0 && state.rsi14 > 30) {
        score += 25;
        signal = "PUT";
      }
    }
  }

  state.score = score;
  state.signal = signal;
}

function applyPrice(price) {
  const close = Number
