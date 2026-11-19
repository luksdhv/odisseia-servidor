# Odisseia Estelar — Servidor multiplayer 0.9

Backend Node.js + `ws`. Hospedar em serviço Web com Node.js (ex.: Render).

- Build: `npm install`
- Start: `npm start`
- `PORT` é fornecida pelo provedor (fallback 3000)
- Endpoint de saúde: `/health`
- Variável opcional: `ALLOWED_ORIGINS=https://seu-site.netlify.app`

A conexão no jogo usa `wss://seu-servico.onrender.com` (TLS provido pelo host).
Salas em memória: fecham quando ninguém fica conectado e são perdidas no reinício.
Sem banco, autenticação de conta, moderação ou anti-cheat completo: protótipo fechado com senha, não produção pública.
