const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();

app.use(cors({ origin: "*" }));

const PORT = process.env.PORT || 3000;

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
// ANALISAR MELHOR/P IOR HORÁRIO
// ======================
function analyzeHours() {
  const hours = {};

  state.trades.forEach((t) => {
    const h = t.time.slice(0, 2);

    if (!hours[h]) {
      hours[h] = {
        win: 0,
        loss: 0,
      };
    }

    if (t.result === "WIN") hours[h].win++;
    if (t.result === "LOSS") hours[h].loss++;
  });

  let best = null;
  let worst = null;
  let bestScore = -999;
  let worstScore = 999;

  for (const h in hours) {
    const score =
      hours[h].win - hours[h].loss;

    if (score > bestScore) {
      bestScore = score;
      best = h + ":00";
    }

    if (score < worstScore) {
      worstScore = score;
      worst = h + ":00";
    }
  }

  state.bestHour = best;
  state.worstHour = worst;
}

// ======================
// AVALIAR SINAL
// ======================
function evaluateSignal() {
  if (!state.lastSignalDirection) return;

  const entry = state.lastSignalPrice;
  const current = Number(state.price);

  let result = "CANCELADA";

  if (
    state.lastSignalDirection === "CALL 🟢"
  ) {
    if (current > entry) result = "WIN";
    if (current < entry) result = "LOSS";
  }

  if (
    state.lastSignalDirection === "PUT 🔴"
  ) {
    if (current < entry) result = "WIN";
    if (current > entry) result = "LOSS";
  }

  if (result === "WIN") state.wins++;
  if (result === "LOSS") state.losses++;
  if (result === "CANCELADA")
    state.canceladas++;

  state.trades.unshift({
    signal: state.lastSignalDirection,
    entry,
    exit: current,
    result,
    time: state.lastSignalTime,
  });

  state.trades =
    state.trades.slice(0, 20);

  analyzeHours();
}

// ======================
// MOTOR
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
    const trend =
      state.sma9 - state.sma34;

    const sideways =
      Math.abs(trend) < 0.3;

    if (!sideways) {
      score += 35;

      if (
        Math.abs(trend) > 0.8
      ) {
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

  if (
    signal &&
    signal !==
      state.lastSignalDirection
  ) {
    state.lastSignalDirection =
      signal;

    state.lastSignalPrice =
      Number(state.price);

    state.lastSignalTime =
      new Date().toLocaleTimeString();

    setTimeout(
      evaluateSignal,
      600000
    );
  }
}

// ======================
// DERIV
// ======================
const deriv = new WebSocket(
  "wss://ws.derivws.com/websockets/v3?app_id=1089"
);

deriv.on("open", () => {
  console.log(
    "🟢 conectado na Deriv"
  );

  state.status =
    "🟢 conectado";

  deriv.send(
    JSON.stringify({
      ticks_history:
        "1HZ25V",
      count: 600,
      end: "latest",
      subscribe: 1,
    })
  );
});

deriv.on(
  "message",
  (raw) => {
    const data =
      JSON.parse(raw);

    if (
      data.history &&
      data.history.prices
    ) {
      state.candles =
        data.history.prices.map(
          (p) =>
            Number(p)
        );

      const last =
        state.candles[
          state.candles
            .length - 1
        ];

      state.price =
        last.toFixed(2);

      state.lastUpdate =
        new Date().toISOString();

      updateMath();
    }

    if (data.tick) {
      const close =
        Number(
          data.tick.quote
        );

      state.price =
        close.toFixed(2);

      state.lastUpdate =
        new Date().toISOString();

      state.candles.push(
        close
      );

      state.candles =
        state.candles.slice(
          -600
        );

      updateMath();
    }
  }
);

// ======================
// API
// ======================
app.get(
  "/status",
  (req, res) => {
    res.json(state);
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      "Servidor rodando na porta",
      PORT
    );
  }
);
