const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: "*" }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SYMBOL = process.env.DERIV_SYMBOL || "1HZ25V";
const DERIV_APP_ID = process.env.DERIV_APP_ID || "1089";
const DERIV_URL = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`;

const MAX_PRICES = 600;
const MIN_SCORE = 80;
const OPERATION_MINUTES = 10;
const COOLDOWN_SECONDS = 60;

const state = {
  status: "iniciando",
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
  probability: 0,
  movementStrength: 0,
  dominantDirection: "NEUTRO",
  reason: "Aguardando confluencia matematica",

  activeTrade: null,
  lastClosedAt: null,

  wins: 0,
  losses: 0,
  canceladas: 0,
  trades: []
};

const wss = new WebSocket.Server({ server });

function sendAll(type = "market:update") {
  const message = JSON.stringify({ type, data: state, ...state });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function avg(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }

  return Number(Number(value).toFixed(digits));
}

function sma(values, period) {
  if (values.length < period) return null;
  return avg(values.slice(-period));
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;

  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calculateDominantDirection(values) {
  if (values.length < 30) return "NEUTRO";

  const recent = values.slice(-30);
  let up = 0;
  let down = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[i - 1]) up++;
    if (recent[i] < recent[i - 1]) down++;
  }

  if (up > down + 4) return "CALL";
  if (down > up + 4) return "PUT";
  return "NEUTRO";
}

function updateIndicators() {
  const prices = state.candles;

  state.sma9 = round(sma(prices, 9));
  state.sma34 = round(sma(prices, 34));
  state.ema9 = round(ema(prices, 9));
  state.ema21 = round(ema(prices, 21));
  state.rsi14 = round(rsi(prices), 2);

  if (prices.length >= 20) {
    const last20 = prices.slice(-20);
    const mean = avg(last20);
    const variance = avg(last20.map((p) => Math.pow(p - mean, 2)));
    state.volatility = round(Math.sqrt(variance));
  }

  if (prices.length >= 10) {
    state.slope = round(prices[prices.length - 1] - prices[prices.length - 10]);
  }

  state.dominantDirection = calculateDominantDirection(prices);
}

function analyzeMarket() {
  if (
    state.sma9 === null ||
    state.sma34 === null ||
    state.ema9 === null ||
    state.ema21 === null ||
    state.rsi14 === null ||
    state.slope === null ||
    state.volatility === null
  ) {
    state.score = 0;
    state.signal = null;
    state.probability = 0;
    state.movementStrength = 0;
    state.reason = "Coletando dados suficientes";
    return;
  }

  let callScore = 0;
  let putScore = 0;
  const reasons = [];

  const smaTrend = state.sma9 - state.sma34;
  const emaTrend = state.ema9 - state.ema21;
  const slope = state.slope;

  if (smaTrend > 0.3) {
    callScore += 25;
    reasons.push("SMA confirma compra");
  }

  if (smaTrend < -0.3) {
    putScore += 25;
    reasons.push("SMA confirma venda");
  }

  if (emaTrend > 0.2) {
    callScore += 25;
    reasons.push("EMA confirma compra");
  }

  if (emaTrend < -0.2) {
    putScore += 25;
    reasons.push("EMA confirma venda");
  }

  if (slope > 0.3) {
    callScore += 20;
    reasons.push("Inclinação positiva");
  }

  if (slope < -0.3) {
    putScore += 20;
    reasons.push("Inclinação negativa");
  }

  if (state.dominantDirection === "CALL") {
    callScore += 15;
    reasons.push("Direção predominante compradora");
  }

  if (state.dominantDirection === "PUT") {
    putScore += 15;
    reasons.push("Direção predominante vendedora");
  }

  if (state.rsi14 > 35 && state.rsi14 < 68) {
    callScore += 15;
  }

  if (state.rsi14 > 32 && state.rsi14 < 65) {
    putScore += 15;
  }

  const isSideways =
    Math.abs(smaTrend) < 0.25 &&
    Math.abs(emaTrend) < 0.2 &&
    Math.abs(slope) < 0.25;

  if (isSideways) {
    state.score = 0;
    state.signal = null;
    state.probability = 0;
    state.movementStrength = 0;
    state.reason = "Mercado lateralizado";
    return;
  }

  if (callScore > putScore) {
    state.score = Math.min(callScore, 100);
    state.signal = state.score >= MIN_SCORE ? "CALL" : null;
  } else if (putScore > callScore) {
    state.score = Math.min(putScore, 100);
    state.signal = state.score >= MIN_SCORE ? "PUT" : null;
  } else {
    state.score = 0;
    state.signal = null;
  }

  state.probability = state.score;
  state.movementStrength = round(Math.abs(slope) + Math.abs(emaTrend), 2);
  state.reason =
    state.signal === null
      ? "Aguardando score minimo"
      : reasons.slice(-4).join(" + ");
}

function canOpenTrade() {
  if (state.activeTrade) return false;
  if (!state.signal) return false;
  if (state.price === null) return false;
  if (state.score < MIN_SCORE) return false;

  if (state.lastClosedAt) {
    const diff = Date.now() - new Date(state.lastClosedAt).getTime();
    if (diff < COOLDOWN_SECONDS * 1000) return false;
  }

  return true;
}

function openTrade() {
  const entryAt = new Date();
  const exitAt = new Date(entryAt.getTime() + OPERATION_MINUTES * 60 * 1000);

  state.activeTrade = {
    id: entryAt.getTime(),
    status: "EM_OPERACAO",
    signal: state.signal,
    entryPrice: state.price,
    exitPrice: null,
    result: null,
    score: state.score,
    probability: state.probability,
    movementStrength: state.movementStrength,
    reason: state.reason,
    entryAt: entryAt.toISOString(),
    exitAt: exitAt.toISOString()
  };

  sendAll("trade:opened");
}

function closeTrade() {
  if (!state.activeTrade || state.price === null) return;

  const trade = state.activeTrade;
  const current = Number(state.price);

  let result = "CANCELADO";

  if (trade.signal === "CALL") {
    if (current > trade.entryPrice) result = "WIN";
    if (current < trade.entryPrice) result = "LOSS";
  }

  if (trade.signal === "PUT") {
    if (current < trade.entryPrice) result = "WIN";
    if (current > trade.entryPrice) result = "LOSS";
  }

  const closedTrade = {
    ...trade,
    status: "FINALIZADA",
    exitPrice: current,
    result,
    closedAt: new Date().toISOString()
  };

  if (result === "WIN") state.wins++;
  if (result === "LOSS") state.losses++;
  if (result === "CANCELADO") state.canceladas++;

  state.trades.unshift(closedTrade);
  state.trades = state.trades.slice(0, 30);
  state.activeTrade = null;
  state.lastClosedAt = closedTrade.closedAt;

  sendAll("trade:closed");
}

function updateTradeCycle() {
  if (state.activeTrade) {
    const now = Date.now();
    const exitAt = new Date(state.activeTrade.exitAt).getTime();

    if (now >= exitAt) {
      closeTrade();
    }

    return;
  }

  if (canOpenTrade()) {
    openTrade();
  }
}

function addPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return;

  state.price = Number(price.toFixed(2));
  state.lastUpdate = new Date().toISOString();
  state.status = "conectado";
  state.derivStatus = "conectado";
  state.lastError = null;

  state.candles.push(price);
  state.candles = state.candles.slice(-MAX_PRICES);

  updateIndicators();

  if (!state.activeTrade) {
    analyzeMarket();
  }

  updateTradeCycle();
  sendAll("market:update");
}

wss.on("connection", (socket) => {
  state.frontendClients = wss.clients.size;
  socket.send(JSON.stringify({ type: "market:snapshot", data: state, ...state }));

  socket.on("close", () => {
    state.frontendClients = wss.clients.size;
    sendAll("frontend:clients");
  });
});

function connectDeriv() {
  state.status = "conectando";
  state.derivStatus = "conectando";

  const deriv = new WebSocket(DERIV_URL);

  deriv.on("open", () => {
    console.log("Conectado na Deriv");

    deriv.send(
      JSON.stringify({
        ticks_history: SYMBOL,
        count: MAX_PRICES,
        end: "latest",
        subscribe: 1
      })
    );
  });

  deriv.on("message", (raw) => {
    const data = JSON.parse(raw);

    if (data.error) {
      state.lastError = data.error.message;
      console.error("Erro Deriv:", state.lastError);
      sendAll("deriv:error");
      return;
    }

    if (data.history && Array.isArray(data.history.prices)) {
      state.candles = data.history.prices.map(Number).filter(Number.isFinite);
      const last = state.candles[state.candles.length - 1];

      if (last !== undefined) {
        state.price = Number(last.toFixed(2));
        state.lastUpdate = new Date().toISOString();
        updateIndicators();
        analyzeMarket();
        sendAll("market:snapshot");
      }
    }

    if (data.tick) {
      addPrice(data.tick.quote);
    }
  });

  deriv.on("error", (error) => {
    state.status = "erro";
    state.derivStatus = "erro";
    state.lastError = error.message;
    console.error("Erro Deriv:", error.message);
    sendAll("deriv:error");
  });

  deriv.on("close", () => {
    state.status = "desconectado";
    state.derivStatus = "desconectado";
    console.log("Deriv desconectou. Reconectando...");
    setTimeout(connectDeriv, 5000);
  });
}

app.get("/", (req, res) => {
  res.json({ name: "willian-trader-api", status: state.status });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: state.status,
    derivStatus: state.derivStatus,
    frontendClients: state.frontendClients,
    lastUpdate: state.lastUpdate,
    lastError: state.lastError
  });
});

app.get("/status", (req, res) => {
  res.json(state);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor rodando na porta", PORT);
  connectDeriv();
});
