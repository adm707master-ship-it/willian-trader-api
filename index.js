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
  signal: null
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

function round(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Number(value.toFixed(digits));
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

  let score = 0;
  let signal = null;

  if (state.sma9 !== null && state.sma34 !== null && state.rsi14 !== null) {
    const trend = state.sma9 - state.sma34;

    if (Math.abs(trend) >= 0.3) {
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

function addPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return;

  state.price = Number(price.toFixed(2));
  state.lastUpdate = new Date().toISOString();
  state.status = "conectado";
  state.derivStatus = "conectado";
  state.lastError = null;

  state.candles.push(price);
  state.candles = state.candles.slice(-600);

  updateIndicators();
  sendAll();
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
    deriv.send(JSON.stringify({
      ticks_history: SYMBOL,
      count: 600,
      end: "latest",
      subscribe: 1
    }));
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
        state.status = "conectado";
        state.derivStatus = "conectado";
        updateIndicators();
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

server.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
  connectDeriv();
});
