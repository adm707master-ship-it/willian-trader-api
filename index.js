const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();

app.use(
  cors({
    origin: "*",
  })
);

const PORT = 3000;

// ======================
// ESTADO
// ======================
let state = {
  status: "🔴 desconectado",
  price: "conectando...",
  candles: [],
  lastUpdate: null,

  sma9: null,
  sma34: null,
  ema9: null,
  ema21: null,
  rsi14: null,
  volatility: null,
  slope: null,
  score: 0,
  signal: null,
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

function volatility(arr) {
  if (arr.length < 20) return null;

  const avg =
    arr.slice(-20).reduce((a, b) => a + b, 0) / 20;

  const variance =
    arr
      .slice(-20)
      .reduce(
        (a, b) => a + Math.pow(b - avg, 2),
        0
      ) / 20;

  return Math.sqrt(variance);
}

function slope(arr) {
  if (arr.length < 10) return null;

  return arr[arr.length - 1] - arr[arr.length - 10];
}

// ======================
// MOTOR MATEMÁTICO
// ======================
function updateMath() {
  const c = state.candles;

  state.sma9 = sma(c, 9);
  state.sma34 = sma(c, 34);

  state.ema9 = ema(c, 9);
  state.ema21 = ema(c, 21);

  state.rsi14 = rsi(c);

  state.volatility = volatility(c);

  state.slope = slope(c);

  let score = 0;
  let signal = null;

  if (
    state.sma9 &&
    state.sma34 &&
    state.rsi14
  ) {
    const trend = state.sma9 - state.sma34;
    const sideways = Math.abs(trend) < 0.3;

    if (!sideways) {
      score += 35;

      if (Math.abs(trend) > 0.8) {
        score += 20;
      }

      if (
        trend > 0 &&
        state.rsi14 < 70
      ) {
        score += 25;
        signal = "CALL 🟢";
      }

      if (
        trend < 0 &&
        state.rsi14 > 30
      ) {
        score += 25;
        signal = "PUT 🔴";
      }
    }
  }

  state.score = score;
  state.signal = signal;
}

// ======================
// CONEXÃO DERIV (TICKS)
// ======================
const deriv = new WebSocket(
  "wss://ws.derivws.com/websockets/v3?app_id=1089"
);

deriv.on("open", () => {
  console.log("🟢 conectado na Deriv");

  state.status = "🟢 conectado";

  deriv.send(
    JSON.stringify({
      ticks_history: "1HZ25V",
      count: 600,
      end: "latest",
      subscribe: 1,
    })
  );
});

deriv.on("message", (raw) => {
  const data = JSON.parse(raw);

  console.log("DERIV:", data);

  // HISTÓRICO DOS ÚLTIMOS 600 TICKS
  if (data.history && data.history.prices) {
    state.candles = data.history.prices.map(
      (p) => Number(p)
    );

    const last =
      state.candles[
        state.candles.length - 1
      ];

    state.price = last.toFixed(2);
    state.lastUpdate =
      new Date().toISOString();

    updateMath();

    console.log(
      "✅ Histórico carregado:",
      state.candles.length
    );
  }

  // TICK AO VIVO
  if (data.tick) {
    const close = Number(
      data.tick.quote
    );

    state.price =
      close.toFixed(2);

    state.lastUpdate =
      new Date().toISOString();

    state.candles.push(close);

    state.candles =
      state.candles.slice(-600);

    updateMath();
  }

  // ERRO
  if (data.error) {
    console.log(
      "ERRO DERIV:",
      data.error
    );
  }
});

deriv.on("close", () => {
  console.log("🔴 Deriv desconectou");
  state.status = "🔴 desconectado";
});

deriv.on("error", (err) => {
  console.log(
    "ERRO WEBSOCKET:",
    err.message
  );

  state.status = "🔴 erro";
});

// ======================
// API
// ======================
app.get("/status", (req, res) => {
  res.json(state);
});

app.listen(PORT, () => {
  console.log(
    "Servidor rodando na porta 3000"
  );
});
