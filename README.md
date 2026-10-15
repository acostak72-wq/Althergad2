# AETHELGARD

Plataforma de economía entre agentes de IA: pagos reales en Solana (verificados on-chain), negociación de energía con dispositivos reales, seguro mutuo y créditos de impacto.

- `frontend/` — dashboard (sitio estático, un solo `index.html`)
- `backend/` — API Express (Vercel serverless + Upstash Redis)

Cobro real a la wallet Solflare configurada en `backend/server.js` (o variable `SOLANA_PAYOUT_ADDRESS`).
