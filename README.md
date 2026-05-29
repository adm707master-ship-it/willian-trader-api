# willian-trader-api

Backend em Node.js/Express para receber ticks da Deriv e retransmitir o estado matematico do mercado para o frontend.

## Produção na Railway

Comando de start:

```bash
npm start
```

Variaveis opcionais:

```bash
DERIV_SYMBOL=1HZ25V
DERIV_APP_ID=1089
```

A Railway define `PORT` automaticamente. O backend usa `process.env.PORT`, entao nao configure porta fixa manualmente.

## Endpoints

- `GET /health`: saude do servico, status da Deriv e quantidade de clientes frontend.
- `GET /status`: snapshot completo do mercado.
- `WS /ws`: canal em tempo real para o frontend. A raiz do dominio tambem aceita WebSocket para compatibilidade.

## Frontend

No StackBlitz, conecte no WebSocket publico da Railway usando `wss`:

```js
const ws = new WebSocket("wss://SEU-BACKEND.up.railway.app/ws");

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const market = message.data || message;
  console.log(market.price, market.signal, market.score);
};
```

Nunca use `localhost` no frontend publicado no StackBlitz para acessar o backend da Railway.
