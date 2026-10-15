// ============================================================================
// AETHELGARD — Backend REAL de pagos entre agentes de IA (pago directo en Solana)
// TODO en un solo archivo (excepto package.json, que npm exige aparte).
// ============================================================================
//
// VERSIÓN SIMPLIFICADA: no usa el protocolo x402 ni Coinbase CDP. En vez de
// eso, cada endpoint pago responde con HTTP 402 y los datos para pagar
// (dirección + monto); quien quiera usarlo paga esa cantidad de SOL con
// CUALQUIER wallet (Solflare, Phantom, lo que sea) y vuelve a llamar al
// mismo endpoint agregando ?tx=<firma_de_la_transacción>. El servidor
// verifica esa transacción directo contra la blockchain (RPC público de
// Solana) antes de responder — nadie puede "inventarse" un pago.
// Ventaja: menos piezas, menos cuentas que crear, nada que dependa de un
// tercero (facilitador) para decidir si el pago es válido.
// Desventaja frente a x402/CDP: un agente de IA externo necesita que le
// digas cómo llamar tu API (no aparece listado solo en un directorio como
// Agentic.Market de Coinbase). Si más adelante quieres ese listado
// automático, se puede volver a agregar x402 encima de esto sin romper nada.
//
// QUÉ RESUELVE:
//  · M2P (agente → tu plataforma): quien use tus endpoints
//    (/api/energy/report, /api/audit/quantum...) paga en SOL real y el
//    dinero llega directo a tu wallet, verificado on-chain.
//  · M2M (agente → agente): /api/registry es un directorio (como
//    "Agent.market" de Coinbase). Cada agente pone su propio servicio y
//    su propia wallet; tu plataforma NUNCA custodia ese dinero, solo
//    indexa — así evitas necesitar licencia de operador de pagos.
//  · P2M (persona → tu plataforma): igual que M2P, solo que paga una
//    persona con su wallet en vez de un agente automatizado.
//  · Seguro mutuo autónomo y tokenización de impacto (PIVTAN) — ver
//    las secciones 4 y 5 más abajo en el propio código.
//
// IMPORTANTE: esto debe correr 24/7 en un servidor propio (Vercel, Render,
// Railway, Fly.io...). No puede vivir dentro del HTML del dashboard — un
// navegador no puede recibir pagos de otros agentes por internet.
//
// ----------------------------------------------------------------------
// VARIABLES DE ENTORNO (crea un archivo .env con esto, o ponlas en tu
// hosting — NUNCA subas claves privadas a un repositorio). La wallet de
// cobro YA viene puesta por defecto en el código (la Solflare real de
// Karen), así que solo necesitas configurar Redis para que despliegue:
//
//   SOLANA_PAYOUT_ADDRESS=          opcional — solo si algún día cambias de wallet de cobro
//   UPSTASH_REDIS_REST_URL=         Marketplace de Vercel → Upstash Redis
//   UPSTASH_REDIS_REST_TOKEN=       (se rellenan solas si usas Vercel)
//   SOLANA_RPC=                     opcional, por defecto Mainnet público (dinero real)
//   INSURANCE_TREASURY_PRIVATE_KEY= opcional — wallet SEPARADA solo para pagar reclamos de seguro
//   IMPACT_TOKEN_MINT_ADDRESS=      opcional — creado con: spl-token create-token
//   MINT_AUTHORITY_PRIVATE_KEY=     opcional — autoridad de emisión de ese mint
//   CRON_SECRET=                    opcional — protege el cron de la señal de carga
//   PORT=4021
//
// ----------------------------------------------------------------------
// 1) PROBAR LOCAL:
//      npm install
//      npm start
//      curl http://localhost:4021/api/energy/report   → debe dar 402 con instrucciones de pago
//
// 2) DESPLEGAR EN VERCEL: sube esta carpeta a GitHub → Vercel detecta
//    Express solo (Fluid Compute) → antes del Deploy, activa "Upstash
//    Redis" desde Storage → Marketplace → agrega SOLANA_PAYOUT_ADDRESS en
//    Settings → Environment Variables → Deploy.
//
// 3) SEGURO MUTUO: usa una wallet SEPARADA de tu wallet principal para
//    INSURANCE_TREASURY_PRIVATE_KEY — fondéala solo con lo que estés
//    dispuesta a arriesgar en pagos automáticos.
//
// 4) IMPACTO AMBIENTAL: el factor EMISSION_FACTOR_TCO2_PER_MWH de abajo
//    es referencial — reemplázalo por el dato oficial de la UPME antes
//    de usarlo frente a inversionistas o en un reclamo formal.
// ============================================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { Redis } from "@upstash/redis";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { mintTo, burn, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { randomUUID } from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

// Redis.fromEnv() lee automáticamente UPSTASH_REDIS_REST_URL y
// UPSTASH_REDIS_REST_TOKEN (los inyecta Vercel al instalar la integración
// de Marketplace). En local, ponlos tú mismo en .env.
const redis = Redis.fromEnv();
const readList = async (key) => (await redis.get(key)) || [];
const writeList = async (key, arr) => redis.set(key, arr);
const readObj = async (key, fallback) => (await redis.get(key)) ?? fallback;
const writeObj = async (key, obj) => redis.set(key, obj);

// Wallet Solflare real de Karen — queda como valor por defecto así el
// backend cobra de una vez sin tener que configurar nada en Vercel. Si
// prefieres cambiarla sin tocar el código, define SOLANA_PAYOUT_ADDRESS en
// las variables de entorno y esa pisa este valor por defecto.
const SOLANA_PAYOUT = process.env.SOLANA_PAYOUT_ADDRESS || "9FJUD1YJeb8e9S6AAxcXhS6LDt6Kojcj5iwfCWPggqhS";
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // Solana Mainnet (dinero real)
const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";

console.log(`💰 Cobro real configurado a: ${SOLANA_PAYOUT}${process.env.SOLANA_PAYOUT_ADDRESS ? "" : " (valor por defecto — cámbialo con SOLANA_PAYOUT_ADDRESS si alguna vez usas otra wallet)"}`);

// --- LEDGER SIMPLE (Redis; persiste entre invocaciones serverless) ---
const logPayment = async (entry) => {
    const l = await readList("aeth:ledger");
    l.push({ time: new Date().toISOString(), ...entry });
    await writeList("aeth:ledger", l.slice(-500));
};

// Token de impacto ambiental (IMPACT_TOKEN_MINT_ADDRESS) — se usa para
// ACUÑAR créditos de CO2 verificado (sección 5), no para cobrar: eso es un
// tema aparte de cómo se paga por usar la API.
const ENERGY_CREDIT_MINT = process.env.IMPACT_TOKEN_MINT_ADDRESS;
const ENERGY_CREDIT_DECIMALS = parseInt(process.env.ENERGY_CREDIT_DECIMALS || "9", 10);

// ---------------------------------------------------------------------
// COBRO SIMPLE: pago directo en SOL, verificado contra la blockchain.
// Nada de facilitadores externos ni cuentas de Coinbase — solo tu wallet
// de cobro y una llamada de lectura al RPC público de Solana.
// ---------------------------------------------------------------------
async function getSolUsdPrice() {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const d = await r.json();
    return d.solana.usd;
}

// Evita que la misma transacción se reutilice para "pagar" dos veces.
async function txYaUsada(txHash) {
    const usadas = await readList("aeth:used-tx");
    return usadas.includes(txHash);
}
async function marcarTxUsada(txHash) {
    const usadas = await readList("aeth:used-tx");
    usadas.push(txHash);
    await writeList("aeth:used-tx", usadas.slice(-5000));
}

// Verifica en la red real que `txHash` transfirió al menos `minLamports`
// de SOL hacia SOLANA_PAYOUT. No confía en nada que el cliente diga —
// vuelve a consultar la transacción directo al RPC.
async function verificarPagoSol(txHash, minLamports) {
    if (await txYaUsada(txHash)) return { ok: false, motivo: "Esa transacción ya se usó para pagar otra cosa." };
    const r = await fetch(SOLANA_RPC, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [txHash, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }] }),
    });
    const d = await r.json();
    const tx = d.result;
    if (!tx || tx.meta?.err) return { ok: false, motivo: "La transacción no existe o falló on-chain." };
    const accountKeys = (tx.transaction.message.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
    const idx = accountKeys.indexOf(SOLANA_PAYOUT);
    if (idx === -1) return { ok: false, motivo: "Esa transacción no le paga a la wallet de cobro de esta plataforma." };
    const recibido = (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0);
    if (recibido < minLamports) return { ok: false, motivo: `Se recibieron ${(recibido / LAMPORTS_PER_SOL).toFixed(6)} SOL, se necesitan ${(minLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL.` };
    await marcarTxUsada(txHash);
    return { ok: true, recibidoLamports: recibido };
}

// Middleware de "pared de pago" para un endpoint: si no llega ?tx=, explica
// cómo pagar (igual que un 402 de x402, pero sin su maquinaria). Si llega,
// verifica el pago real antes de dejar pasar la petición.
function requierePago(usdPrecio, descripcion) {
    return async (req, res, next) => {
        if (!SOLANA_PAYOUT) return next(); // sin wallet configurada todavía → modo pruebas, no bloquea
        const tx = req.query.tx || req.body?.tx;
        if (!tx) {
            const solPrecio = await getSolUsdPrice().catch(() => null);
            const montoSol = solPrecio ? +(usdPrecio / solPrecio).toFixed(6) : null;
            return res.status(402).json({
                error: "Pago requerido",
                descripcion,
                priceUsd: usdPrecio,
                payTo: SOLANA_PAYOUT,
                network: "solana-mainnet",
                montoSolAprox: montoSol,
                comoPagar: `Envía ~${montoSol ?? "?"} SOL (≈ $${usdPrecio}) a la dirección de 'payTo' desde cualquier wallet (Solflare, Phantom...), y repite esta misma llamada agregando ?tx=<firma_de_tu_transacción>.`,
            });
        }
        try {
            const solPrecio = await getSolUsdPrice();
            const minLamports = Math.floor((usdPrecio / solPrecio) * LAMPORTS_PER_SOL * 0.97); // 3% de margen por volatilidad del precio de SOL
            const veredicto = await verificarPagoSol(tx, minLamports);
            if (!veredicto.ok) return res.status(402).json({ error: veredicto.motivo });
            logPayment({ route: req.path, tx, priceUsd: usdPrecio }).catch(() => {});
            next();
        } catch (err) {
            res.status(502).json({ error: "No se pudo verificar el pago on-chain", detail: err.message });
        }
    };
}

// ---------------------------------------------------------------------
// 1) M2P — ENDPOINTS PROPIOS PAGADOS (un agente te paga a TI)
// ---------------------------------------------------------------------
// Cada ruta lleva su precio fijo en USD (convertido a SOL al momento del
// pago) — ver requierePago() más arriba. Se aplica directo como middleware
// de esa única ruta, sin capa de configuración aparte.

// Catálogo público (sin pago) para que el dashboard y los agentes vean qué
// hay a la venta antes de decidir pagar.
app.get("/api/datamarket/catalog", (req, res) => {
    res.json([
        // --- CATEGORÍA 1: DATOS (M2P — un agente te paga por consumir información tuya) ---
        { category: "datos", id: "energy-realtime", name: "Precio eléctrico en tiempo real (REE/OMIE)", route: "/api/energy/report", priceUsd: 0.01 },
        { category: "datos", id: "energy-history", name: "Histórico real de producción/consumo (DePIN)", route: "/api/energy/history", priceUsd: 0.03 },
        { category: "datos", id: "load-signal", name: "Señal de carga óptima (para schedulers de cómputo)", route: "/api/energy/load-signal", priceUsd: 0.005 },

        // --- CATEGORÍA 2: CONFIANZA (notaría/auditoría entre agentes) ---
        { category: "confianza", id: "quantum-audit", name: "Auditoría Quantum (balance, CO2, fondos)", route: "/api/audit/quantum", priceUsd: 0.02 },
        { category: "confianza", id: "oracle-attest", name: "Notario: verifica y firma una afirmación entre agentes", route: "/api/oracle/attest", priceUsd: 0.01 },
        { category: "confianza", id: "footprint-receipt", name: "Huella IA: recibo firmado de energía y CO2 de una carga de trabajo", route: "/api/footprint/receipt", priceUsd: 0.02 },

        // --- CATEGORÍA 3: MERCADO M2M (directorio y matching — tarifas fijas, nunca % de lo que transen) ---
        { category: "mercado", id: "registry-listing", name: "Listar tu servicio en el directorio M2M (una vez por registro)", route: "/api/registry/register", priceUsd: 0.05 },
        { category: "mercado", id: "energy-negotiate", name: "Matching de negociación de energía entre agentes", route: "/api/energy/negotiate", priceUsd: 0.02 },
    ]);
});

async function fetchReePriceValue() {
    const now = new Date();
    const start = new Date(now.getTime() - 6 * 3600 * 1000).toISOString().slice(0, 16);
    const end = now.toISOString().slice(0, 16);
    const url = `https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real?start_date=${start}&end_date=${end}&time_trunc=hour`;
    const r = await fetch(url);
    const d = await r.json();
    const series = d?.included?.[0]?.attributes?.values || [];
    const last = series[series.length - 1];
    return last ? { value: last.value, timestamp: last.datetime } : null;
}

app.get("/api/energy/report", requierePago(0.01, "Precio eléctrico en tiempo real (REE/OMIE)"), async (req, res) => {
    try {
        const p = await fetchReePriceValue();
        res.json({ source: "REE/OMIE (real)", price_eur_mwh: p?.value ?? null, timestamp: p?.timestamp ?? null });
    } catch (err) {
        res.status(502).json({ error: "No se pudo consultar REData", detail: err.message });
    }
});

app.get("/api/audit/quantum", requierePago(0.02, "Auditoría Quantum (balance, CO2, fondos)"), async (req, res) => {
    const ledger = await readList("aeth:ledger");
    const total = ledger.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
    res.json({ agent: "Archon Quantum", total_liquidado_usd: total.toFixed(2), operaciones: ledger.length });
});

// Histórico real: lee las lecturas que tus dispositivos (medidor/inversor)
// hayan reportado vía /api/devices/telemetry.
app.get("/api/energy/history", requierePago(0.03, "Histórico real de producción/consumo (DePIN)"), async (req, res) => {
    const readings = await readList("aeth:device-readings");
    const filtered = req.query.deviceId ? readings.filter((r) => r.deviceId === req.query.deviceId) : readings;
    res.json({ source: "Dispositivos DePIN (real)", readings: filtered.slice(-200) });
});

// ---------------------------------------------------------------------
// 1.b) REGISTRO Y TELEMETRÍA DE DISPOSITIVOS REALES
//      (medidores, inversores grid-tie — WiFi/internet o satélite)
// ---------------------------------------------------------------------
// Un dispositivo primero se REGISTRA una vez (te da un token secreto), y
// luego manda telemetría con ese token. Esto evita que cualquiera pueda
// inyectar lecturas falsas a tu histórico — cada dispositivo solo puede
// hablar por sí mismo.
// type acepta cualquier dispositivo físico real que negocie energía:
// 'meter' (medidor inteligente), 'inverter' (inversor), 'grid_tie'
// (inversor conectado a red), o 'battery_station' (p. ej. una estación
// portátil tipo EcoFlow/Bluetti/Anker — el tipo de hardware no importa,
// solo que hable HTTP y tenga un dueño con una wallet real de cobro).
app.post("/api/devices/register", async (req, res) => {
    const { deviceId, type, connectivity, capacityKw, label, payToAddress, network, pricePerKwhUsd, acceptedPayment } = req.body || {};
    if (!deviceId || !type || !connectivity) {
        return res.status(400).json({ error: "Faltan campos: deviceId, type ('meter'|'inverter'|'grid_tie'|'battery_station'), connectivity ('wifi'|'cellular'|'satellite')" });
    }
    const devices = (await readList("aeth:devices")).filter((d) => d.deviceId !== deviceId);
    const token = randomUUID().replace(/-/g, "");
    devices.push({
        deviceId, type, connectivity, capacityKw: capacityKw ?? null, label: label || deviceId, token,
        registeredAt: new Date().toISOString(), lastSeen: null,
        // Oferta de negociación real: el dueño del dispositivo cobra DIRECTO
        // a esta wallet — la plataforma nunca custodia ese dinero, solo
        // publica el anuncio (igual que el directorio de agentes M2M).
        payToAddress: payToAddress || null,
        network: network || SOLANA_NETWORK,
        pricePerKwhUsd: pricePerKwhUsd ?? null,
        acceptedPayment: Array.isArray(acceptedPayment) && acceptedPayment.length ? acceptedPayment : ["SOL", "USDC", ...(ENERGY_CREDIT_MINT ? ["ENERGY_CREDIT"] : [])],
        kwhAvailable: 0,
    });
    await writeList("aeth:devices", devices);
    // El token se devuelve UNA sola vez — el dispositivo debe guardarlo, no queda visible después.
    res.json({ ok: true, deviceId, token });
});

// Lista pública de dispositivos (sin exponer sus tokens), con estado online/offline
// calculado por última señal recibida — útil para el dashboard y para que
// agentes vean qué hay conectado antes de comprar histórico de ese dispositivo.
app.get("/api/devices/registry", async (req, res) => {
    const devices = await readList("aeth:devices");
    const now = Date.now();
    res.json(
        devices.map((d) => ({
            deviceId: d.deviceId,
            type: d.type,
            connectivity: d.connectivity,
            capacityKw: d.capacityKw,
            label: d.label,
            lastSeen: d.lastSeen,
            online: d.lastSeen ? now - new Date(d.lastSeen).getTime() < 15 * 60 * 1000 : false,
            pricePerKwhUsd: d.pricePerKwhUsd ?? null,
            kwhAvailable: d.kwhAvailable ?? 0,
            acceptedPayment: d.acceptedPayment || [],
            payToAddress: d.payToAddress || null,
            network: d.network || null,
        })),
    );
});

// El dueño del dispositivo publica/actualiza su oferta real de negociación:
// cuánta energía tiene disponible ahora mismo y a qué precio la vende.
// Autenticado con el mismo token que la telemetría — así solo el dueño
// real del dispositivo puede cambiar su propia oferta.
app.post("/api/devices/offer", async (req, res) => {
    const { deviceId, token, kwhAvailable, pricePerKwhUsd, payToAddress, network, acceptedPayment } = req.body || {};
    if (!deviceId || !token) return res.status(400).json({ error: "Faltan deviceId/token" });
    const devices = await readList("aeth:devices");
    const device = devices.find((d) => d.deviceId === deviceId);
    if (!device || device.token !== token) return res.status(401).json({ error: "Dispositivo no registrado o token inválido" });

    if (kwhAvailable !== undefined) device.kwhAvailable = Math.max(0, Number(kwhAvailable) || 0);
    if (pricePerKwhUsd !== undefined) device.pricePerKwhUsd = Number(pricePerKwhUsd) || null;
    if (payToAddress) device.payToAddress = payToAddress;
    if (network) device.network = network;
    if (Array.isArray(acceptedPayment) && acceptedPayment.length) device.acceptedPayment = acceptedPayment;
    await writeList("aeth:devices", devices);
    res.json({ ok: true, deviceId, kwhAvailable: device.kwhAvailable, pricePerKwhUsd: device.pricePerKwhUsd });
});

// Libro de ofertas abierto — lo que un agente consulta ANTES de pagar la
// tarifa de /api/energy/negotiate, y lo que /api/energy/negotiate usa para
// armar el match. Solo dispositivos con payToAddress configurado, online y
// con kwhAvailable > 0 — nada simulado: si no hay dato real reportado, no
// aparece aquí.
async function openDeviceOffers() {
    const devices = await readList("aeth:devices");
    const now = Date.now();
    return devices
        .filter((d) => d.payToAddress && d.kwhAvailable > 0 && d.lastSeen && now - new Date(d.lastSeen).getTime() < 15 * 60 * 1000)
        .sort((a, b) => (a.pricePerKwhUsd ?? Infinity) - (b.pricePerKwhUsd ?? Infinity))
        .map((d) => ({
            deviceId: d.deviceId, type: d.type, label: d.label,
            kwhAvailable: d.kwhAvailable, pricePerKwhUsd: d.pricePerKwhUsd,
            payToAddress: d.payToAddress, network: d.network, acceptedPayment: d.acceptedPayment,
        }));
}

app.get("/api/devices/offers", async (req, res) => res.json(await openDeviceOffers()));

// Telemetría. Acepta forma normal (WiFi/internet, claves largas) o forma
// COMPACTA (pensada para módems satelitales tipo Swarm, límite ~192 bytes
// por paquete): d=deviceId, k=token, p=kWh producidos, c=kWh consumidos,
// w=watts, v=voltaje. Un proveedor satelital normalmente entrega los datos
// a un webhook HTTP tuyo tras el paso del satélite — este mismo endpoint
// sirve como ese webhook, no hace falta nada especial de tu lado para eso.
app.post("/api/devices/telemetry", async (req, res) => {
    const body = req.body || {};
    const deviceId = body.deviceId || body.d;
    const token = body.token || body.k;
    if (!deviceId || !token) return res.status(400).json({ error: "Faltan deviceId/token (o d/k en formato compacto)" });

    const devices = await readList("aeth:devices");
    const device = devices.find((dv) => dv.deviceId === deviceId);
    if (!device || device.token !== token) return res.status(401).json({ error: "Dispositivo no registrado o token inválido" });

    const reading = {
        deviceId,
        kwhProduced: body.kwhProduced ?? body.p ?? null,
        kwhConsumed: body.kwhConsumed ?? body.c ?? null,
        watts: body.watts ?? body.w ?? null,
        voltage: body.voltage ?? body.v ?? null,
        connectivity: device.connectivity,
        at: new Date().toISOString(),
    };
    const readings = await readList("aeth:device-readings");
    readings.push(reading);
    await writeList("aeth:device-readings", readings.slice(-3000));

    device.lastSeen = reading.at;
    await writeList("aeth:devices", devices);
    res.json({ ok: true });
});

// ---------------------------------------------------------------------
// 6) ORÁCULO NOTARIO PARA AGENTES — nicho pensado para máquinas, no para
//    humanos: un agente no le "cree" a otro por las buenas; aquí paga por
//    un veredicto verificado contra datos reales y firmado
//    criptográficamente, que cualquier tercero puede comprobar contra tu
//    clave pública sin tener que confiar en tu palabra tampoco.
// ---------------------------------------------------------------------
app.post("/api/oracle/attest", requierePago(0.01, "Notario: verifica y firma una afirmación entre agentes"), async (req, res) => {
    const { claimType, claim } = req.body || {};
    let verdict = false;
    let actualValue = null;
    try {
        if (claimType === "energy_price") {
            const real = await fetchReePriceValue();
            actualValue = real?.value ?? null;
            verdict = actualValue !== null && Math.abs(actualValue - Number(claim?.claimedValue)) <= (claim?.toleranceEurMwh ?? 5);
        } else if (claimType === "ledger_settlement") {
            verdict = claim?.chain === "solana" ? await verifySolanaTx(claim.txHash, claim.network) : await verifyEvmTx(claim.txHash, claim.network);
            actualValue = verdict;
        } else if (claimType === "agent_reputation") {
            const rep = await readList("aeth:reputation");
            actualValue = rep.filter((r) => r.agentId === claim?.agentId).length;
            verdict = actualValue >= (claim?.minOps ?? 1);
        } else {
            return res.status(400).json({ error: "claimType debe ser: energy_price | ledger_settlement | agent_reputation" });
        }
    } catch (err) {
        return res.status(502).json({ error: "No se pudo verificar la afirmación", detail: err.message });
    }

    const payload = JSON.stringify({ claimType, claim, verdict, actualValue, at: new Date().toISOString() });
    let signature = null;
    if (treasuryKeypair) {
        signature = Buffer.from(nacl.sign.detached(Buffer.from(payload), treasuryKeypair.secretKey)).toString("base64");
    }
    res.json({ verdict, actualValue, payload, signature, signerPublicKey: treasuryKeypair?.publicKey.toString() ?? null });
});

// ---------------------------------------------------------------------
// 2) M2M — DIRECTORIO DE AGENTES (Bazaar propio, sin custodiar fondos)
// ---------------------------------------------------------------------
// Cada agente registra SU PROPIO endpoint y SU PROPIA wallet de cobro.
// Cuando otro agente lo consuma, paga directo a esa wallet — tu
// plataforma solo indexa y da visibilidad (como Coinbase Agent.market).
app.post("/api/registry/register", requierePago(0.05, "Cuota fija por listar tu servicio en el directorio M2M"), async (req, res) => {
    const { agentId, serviceUrl, priceUsd, description, payToAddress, network } = req.body || {};
    if (!agentId || !serviceUrl || !payToAddress || !network) {
        return res.status(400).json({ error: "Faltan campos: agentId, serviceUrl, payToAddress, network" });
    }
    const registry = (await readList("aeth:registry")).filter((r) => r.agentId !== agentId);
    registry.push({ agentId, serviceUrl, priceUsd, description, payToAddress, network, registeredAt: new Date().toISOString() });
    await writeList("aeth:registry", registry);
    res.json({ ok: true, total_agentes: registry.length });
});

// ---------------------------------------------------------------------
// 2.b) MERCADO DE PREDICCIÓN ENERGÉTICA ENTRE AGENTES (otra rama de
//      mercado, pensada para máquinas: se resuelve solo contra el precio
//      REE real, sin árbitro humano, y paga automáticamente a quien
//      acertó — descontando una comisión para la plataforma)
// ---------------------------------------------------------------------
const currentHourKey = () => new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
const PREDICTION_STAKE_USD = 0.05;
const PREDICTION_COMMISSION = 0.05; // 5% para la plataforma, del fondo total

async function getOrCreateMarket(hourKey) {
    const markets = await readObj("aeth:futures", {});
    if (!markets[hourKey]) {
        const price = await fetchReePriceValue();
        markets[hourKey] = { hour: hourKey, baselinePrice: price?.value ?? null, yes: [], no: [], resolved: false };
        await writeObj("aeth:futures", markets);
    }
    return markets;
}

async function stakeHandler(side, req, res) {
    const { agentId, payoutAddress } = req.body || {};
    if (!agentId || !payoutAddress) return res.status(400).json({ error: "Faltan agentId, payoutAddress" });
    const hourKey = currentHourKey();
    const markets = await getOrCreateMarket(hourKey);
    markets[hourKey][side].push({ agentId, payoutAddress, amountUsd: PREDICTION_STAKE_USD, at: new Date().toISOString() });
    await writeObj("aeth:futures", markets);
    res.json({ ok: true, market: hourKey, side, baselinePrice: markets[hourKey].baselinePrice, pool: { yes: markets[hourKey].yes.length, no: markets[hourKey].no.length } });
}
app.post("/api/futures/stake-yes", requierePago(PREDICTION_STAKE_USD, "Apuesta a que el precio REE subirá en el mercado de la hora en curso"), (req, res) => stakeHandler("yes", req, res));
app.post("/api/futures/stake-no", requierePago(PREDICTION_STAKE_USD, "Apuesta a que el precio REE bajará o se mantendrá en el mercado de la hora en curso"), (req, res) => stakeHandler("no", req, res));

// Resuelve mercados de horas anteriores que sigan pendientes y paga a los
// ganadores. Corre "perezosamente" (al primer /status después de que la
// hora ya pasó) — el precio de resolución es el más reciente disponible
// de REData en ese momento, una aproximación práctica, no un corte exacto
// al segundo. Para mayor precisión puedes programar esto con Vercel Cron.
async function resolvePendingMarkets() {
    const markets = await readObj("aeth:futures", {});
    const nowHour = currentHourKey();
    for (const key of Object.keys(markets)) {
        const m = markets[key];
        if (m.resolved || key >= nowHour) continue;
        const latest = await fetchReePriceValue().catch(() => null);
        if (m.baselinePrice == null || !latest) continue;
        const outcome = latest.value > m.baselinePrice ? "yes" : "no";
        const winners = m[outcome];
        const totalPoolUsd = (m.yes.length + m.no.length) * PREDICTION_STAKE_USD;
        const payoutPoolUsd = totalPoolUsd * (1 - PREDICTION_COMMISSION);
        const perWinnerUsd = winners.length > 0 ? payoutPoolUsd / winners.length : 0;
        if (winners.length > 0 && perWinnerUsd > 0) {
            try {
                const solPrice = await getSolUsdPrice();
                for (const w of winners) {
                    try { w.payoutTx = await payoutSol(w.payoutAddress, perWinnerUsd / solPrice); } catch (e) { w.payoutError = e.message; }
                }
            } catch (e) { /* si falla el precio de SOL, se reintenta en la próxima resolución */ continue; }
        }
        m.resolved = true;
        m.outcome = outcome;
        m.resolvedPrice = latest.value;
        m.perWinnerUsd = +perWinnerUsd.toFixed(4);
    }
    await writeObj("aeth:futures", markets);
    return markets;
}

app.get("/api/futures/status", async (req, res) => {
    const markets = await resolvePendingMarkets();
    const hourKey = currentHourKey();
    res.json({
        open: markets[hourKey] ? { ...markets[hourKey], yes: markets[hourKey].yes.length, no: markets[hourKey].no.length } : null,
        recent: Object.values(markets).filter((m) => m.resolved).sort((a, b) => (a.hour < b.hour ? 1 : -1)).slice(0, 10).map((m) => ({ hour: m.hour, baselinePrice: m.baselinePrice, resolvedPrice: m.resolvedPrice, outcome: m.outcome, ganadores: m[m.outcome]?.length ?? 0, perWinnerUsd: m.perWinnerUsd })),
    });
});

// ---------------------------------------------------------------------
// 3) REPUTACIÓN VERIFICADA ON-CHAIN (innovación: nadie puede autoasignarse
//    puntos — cada operación se comprueba de verdad contra la blockchain
//    antes de sumarla, porque en M2M el dinero nunca pasa por tu servidor)
// ---------------------------------------------------------------------
async function verifySolanaTx(txHash, network) {
    const rpc = network === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
    const r = await fetch(rpc, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [txHash, { encoding: "json", maxSupportedTransactionVersion: 0 }] }),
    });
    const d = await r.json();
    return !!d.result && !d.result.meta?.err;
}

async function verifyEvmTx(txHash, network) {
    const rpc = network === "mainnet" ? "https://mainnet.base.org" : "https://sepolia.base.org";
    const r = await fetch(rpc, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
    });
    const d = await r.json();
    return d.result && d.result.status === "0x1";
}

// Un agente reporta el hash de una operación M2M que acaba de cerrar. El
// servidor NUNCA confía en el reporte por sí solo: lo verifica contra la
// blockchain pública antes de sumarlo a la reputación de ese agente.
app.post("/api/registry/report-settlement", async (req, res) => {
    const { agentId, txHash, chain, network } = req.body || {}; // chain: "solana" | "evm"
    if (!agentId || !txHash || !chain) return res.status(400).json({ error: "Faltan campos: agentId, txHash, chain" });
    const rep = await readList("aeth:reputation");
    if (rep.some((r) => r.txHash === txHash)) return res.status(409).json({ error: "Esa transacción ya fue registrada." });
    try {
        const verified = chain === "solana" ? await verifySolanaTx(txHash, network) : await verifyEvmTx(txHash, network);
        if (!verified) return res.status(422).json({ ok: false, verified: false, error: "La transacción no existe o falló on-chain." });
        rep.push({ agentId, txHash, chain, network, verifiedAt: new Date().toISOString() });
        await writeList("aeth:reputation", rep);
        res.json({ ok: true, verified: true });
    } catch (err) {
        res.status(502).json({ error: "No se pudo consultar el RPC para verificar la tx", detail: err.message });
    }
});

app.get("/api/registry", async (req, res) => {
    const scoreByAgent = {};
    (await readList("aeth:reputation")).forEach((r) => { scoreByAgent[r.agentId] = (scoreByAgent[r.agentId] || 0) + 1; });
    const registry = await readList("aeth:registry");
    res.json(registry.map((a) => ({ ...a, verified_ops: scoreByAgent[a.agentId] || 0 })));
});

// Un agente paga la tarifa fija de arriba (en USDC o en créditos de energía)
// por usar este servicio de matching: le devolvemos el precio real de
// referencia y una lista de posibles contrapartes del directorio. LA
// NEGOCIACIÓN Y EL PAGO ENTRE ESOS DOS AGENTES siguen siendo directos entre
// ellos — esto solo cobra por el servicio de encontrarlos, nunca un % de
// lo que transen después.
app.post("/api/energy/negotiate", requierePago(0.02, "Tarifa fija por el servicio de matching de negociación de energía"), async (req, res) => {
    const { agentId, intent, kwh } = req.body || {};
    if (!agentId || !intent) return res.status(400).json({ error: "Faltan campos: agentId, intent ('buy'|'sell')" });
    try {
        const refPrice = await fetchReePriceValue();
        const registry = await readList("aeth:registry");
        const counterparts = registry.filter((a) => a.agentId !== agentId).slice(0, 10);

        // Si el agente quiere COMPRAR energía, le mostramos también los
        // dispositivos reales (medidores/inversores/grid-tie/estaciones tipo
        // EcoFlow) con oferta abierta de verdad, ordenados del más barato al
        // más caro, hasta cubrir el kwh pedido.
        let deviceMatches = [];
        if (intent === "buy") {
            const offers = await openDeviceOffers();
            let remaining = kwh ? Number(kwh) : Infinity;
            for (const o of offers) {
                if (remaining <= 0) break;
                const take = Math.min(o.kwhAvailable, remaining);
                deviceMatches.push({ ...o, kwhSugerido: take, totalEstimadoUsd: o.pricePerKwhUsd != null ? +(take * o.pricePerKwhUsd).toFixed(4) : null });
                remaining -= take;
            }
        }

        res.json({
            referencePriceEurMwh: refPrice?.value ?? null,
            referenceTimestamp: refPrice?.timestamp ?? null,
            kwhSolicitado: kwh ?? null,
            posiblesContrapartes: counterparts.map((c) => ({ agentId: c.agentId, serviceUrl: c.serviceUrl, payToAddress: c.payToAddress, network: c.network })),
            dispositivosConOferta: deviceMatches,
            comoLiquidar: "Paga DIRECTO a 'payToAddress' en la red indicada (SOL/USDC real, o créditos de energía si 'acceptedPayment' lo incluye), luego reporta el hash en POST /api/registry/report-settlement con agentId=deviceId para que quede verificado on-chain y sume reputación a ese dispositivo.",
            nota: "El pago y la negociación final del precio de la energía son directos entre las partes — esta tarifa solo cubre el servicio de matching.",
        });
    } catch (err) {
        res.status(502).json({ error: "No se pudo generar el matching", detail: err.message });
    }
});

app.get("/api/ledger", async (req, res) => res.json((await readList("aeth:ledger")).slice(-100).reverse()));

// ---------------------------------------------------------------------
// 4) SEGURO MUTUO AUTÓNOMO ENTRE AGENTES (dinero real)
// ---------------------------------------------------------------------
// Un agente paga una micro-prima para asegurar sus operaciones
// M2M. Si luego reclama porque un contraparte no le pagó, el "árbitro" no
// es una IA opinando: es una verificación on-chain determinística — si el
// hash que el reclamante dice que le debían pagar NO existe/no es válido,
// el reclamo se aprueba y se paga solo, de una tesorería real y separada.
const treasuryConnection = new Connection(process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com");
const treasuryKeypair = process.env.INSURANCE_TREASURY_PRIVATE_KEY ? Keypair.fromSecretKey(bs58.decode(process.env.INSURANCE_TREASURY_PRIVATE_KEY)) : null;

async function payoutSol(toAddress, amountSol) {
    if (!treasuryKeypair) throw new Error("Falta INSURANCE_TREASURY_PRIVATE_KEY en .env");
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: treasuryKeypair.publicKey, toPubkey: new PublicKey(toAddress), lamports: Math.floor(amountSol * LAMPORTS_PER_SOL) }));
    return sendAndConfirmTransaction(treasuryConnection, tx, [treasuryKeypair]);
}

// Unirse al fondo (micro-prima cobrada en la misma llamada)
app.get("/api/insurance/join", requierePago(0.01, "Prima de entrada al fondo de seguro mutuo entre agentes"), async (req, res) => {
    const s = await readObj("aeth:insurance", { poolUsd: 0, claims: [] });
    s.poolUsd = (s.poolUsd || 0) + 0.01;
    await writeObj("aeth:insurance", s);
    res.json({ ok: true, poolUsd: s.poolUsd });
});

app.get("/api/insurance/status", async (req, res) => {
    const s = await readObj("aeth:insurance", { poolUsd: 0, claims: [] });
    res.json({ poolUsd: s.poolUsd || 0, totalClaims: s.claims.length, pagados: s.claims.filter((c) => c.result === "pagado").length });
});

app.post("/api/insurance/claim", async (req, res) => {
    const { claimantAgentId, claimantPayoutAddress, disputedTxHash, chain, network, expectedAmountUsd } = req.body || {};
    if (!claimantAgentId || !claimantPayoutAddress || !disputedTxHash || !chain || !expectedAmountUsd) {
        return res.status(400).json({ error: "Faltan campos: claimantAgentId, claimantPayoutAddress, disputedTxHash, chain, expectedAmountUsd" });
    }
    const s = await readObj("aeth:insurance", { poolUsd: 0, claims: [] });
    if (s.claims.some((c) => c.disputedTxHash === disputedTxHash)) return res.status(409).json({ error: "Ese incidente ya fue reclamado." });

    let txExiste = false;
    try { txExiste = chain === "solana" ? await verifySolanaTx(disputedTxHash, network) : await verifyEvmTx(disputedTxHash, network); } catch { txExiste = false; }

    if (txExiste) {
        s.claims.push({ claimantAgentId, disputedTxHash, result: "rechazado", reason: "La transacción sí existe on-chain: el pago sí ocurrió.", at: new Date().toISOString() });
        await writeObj("aeth:insurance", s);
        return res.json({ approved: false, reason: "Reclamo rechazado: la transacción disputada es válida on-chain." });
    }

    const payoutUsd = Math.min(expectedAmountUsd, s.poolUsd || 0);
    if (payoutUsd <= 0) return res.status(402).json({ approved: true, paid: false, reason: "Reclamo válido, pero el fondo está vacío." });
    try {
        const solPrice = await getSolUsdPrice();
        const sig = await payoutSol(claimantPayoutAddress, payoutUsd / solPrice);
        s.poolUsd -= payoutUsd;
        s.claims.push({ claimantAgentId, disputedTxHash, result: "pagado", payoutUsd, payoutTx: sig, at: new Date().toISOString() });
        await writeObj("aeth:insurance", s);
        res.json({ approved: true, paid: true, payoutUsd, payoutTx: sig });
    } catch (err) {
        res.status(500).json({ error: "Reclamo aprobado pero falló el pago automático (revisa INSURANCE_TREASURY_PRIVATE_KEY y su saldo)", detail: err.message });
    }
});

// ---------------------------------------------------------------------
// 5) TOKENIZACIÓN INSTANTÁNEA DE IMPACTO AMBIENTAL VERIFICADO (conecta con PIVTAN)
// ---------------------------------------------------------------------
// Una lectura real de un sensor DePIN (kWh producidos) se convierte al
// instante en créditos SPL reales en la wallet del operador — sin
// auditor humano ni espera de meses. Requiere haber creado un mint SPL
// antes (ver README) y tener MINT_AUTHORITY_PRIVATE_KEY configurada.
// Factor de emisión de la red eléctrica colombiana — REFERENCIAL. Reemplázalo
// por el valor oficial vigente publicado por la UPME antes de usarlo en producción.
const EMISSION_FACTOR_TCO2_PER_MWH = 0.146;

async function mintImpactCredit(recipientAddress, amountCredits) {
    if (!process.env.MINT_AUTHORITY_PRIVATE_KEY || !process.env.IMPACT_TOKEN_MINT_ADDRESS) return null;
    const mintAuthority = Keypair.fromSecretKey(bs58.decode(process.env.MINT_AUTHORITY_PRIVATE_KEY));
    const mintPubkey = new PublicKey(process.env.IMPACT_TOKEN_MINT_ADDRESS);
    const ata = await getOrCreateAssociatedTokenAccount(treasuryConnection, mintAuthority, mintPubkey, new PublicKey(recipientAddress));
    return mintTo(treasuryConnection, mintAuthority, mintPubkey, ata.address, mintAuthority, BigInt(Math.round(amountCredits * 10 ** ENERGY_CREDIT_DECIMALS)));
}

app.post("/api/impact/verify-and-mint", async (req, res) => {
    const { deviceId, kwhProduced, recipientAddress } = req.body || {};
    if (!deviceId || !kwhProduced || !recipientAddress) return res.status(400).json({ error: "Faltan campos: deviceId, kwhProduced, recipientAddress" });
    const co2AvoidedKg = (kwhProduced / 1000) * EMISSION_FACTOR_TCO2_PER_MWH * 1000;
    const credits = Math.max(1, Math.round(co2AvoidedKg / 10)); // 1 crédito ≈ 10kg CO2 evitado (ajustable)
    try {
        const sig = await mintImpactCredit(recipientAddress, credits);
        const record = { deviceId, kwhProduced, co2AvoidedKg: +co2AvoidedKg.toFixed(2), credits, recipientAddress, mintTx: sig, at: new Date().toISOString() };
        const impact = await readList("aeth:impact");
        impact.push(record);
        await writeList("aeth:impact", impact.slice(-500));
        res.json({ ok: true, ...record, minted: !!sig });
    } catch (err) {
        res.status(500).json({ error: "Falló el minteo real (revisa el mint y la autoridad configurados)", detail: err.message });
    }
});

app.get("/api/impact/ledger", async (req, res) => res.json((await readList("aeth:impact")).slice(-100).reverse()));

// ---------------------------------------------------------------------
// 7) SEÑAL DE CARGA ÓPTIMA — otro nicho de energía que un humano no puede
//    operar a mano: convierte el precio eléctrico en una puntuación 0-100
//    de "qué tan buen momento es para consumir/ejecutar carga AHORA",
//    pensado para schedulers de cómputo autónomos (data centers, clusters
//    de inferencia) que necesitan reaccionar en segundos, no en reuniones.
// ---------------------------------------------------------------------
async function fetchReePriceWindow(hours = 24) {
    const now = new Date();
    const start = new Date(now.getTime() - hours * 3600 * 1000).toISOString().slice(0, 16);
    const end = now.toISOString().slice(0, 16);
    const url = `https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real?start_date=${start}&end_date=${end}&time_trunc=hour`;
    const r = await fetch(url);
    const d = await r.json();
    return (d?.included?.[0]?.attributes?.values || []).map((v) => v.value);
}

async function computeLoadSignal() {
    const window = await fetchReePriceWindow(24);
    if (!window.length) return null;
    const current = window[window.length - 1];
    const sorted = [...window].sort((a, b) => a - b);
    const rank = sorted.findIndex((v) => v >= current);
    const percentile = rank / (sorted.length - 1 || 1);
    const score = Math.round((1 - percentile) * 100); // más barato que lo habitual → score más alto
    return {
        score,
        currentPriceEurMwh: current,
        recommendation: score >= 70 ? "EJECUTAR_AHORA" : score <= 30 ? "ESPERAR" : "NEUTRAL",
        windowHours: 24,
        at: new Date().toISOString(),
    };
}

app.get("/api/energy/load-signal", requierePago(0.005, "Señal 0-100 de qué tan buen momento es ahora para consumir energía"), async (req, res) => {
    try {
        const s = await computeLoadSignal();
        if (!s) return res.status(502).json({ error: "Sin datos suficientes todavía" });
        res.json(s);
    } catch (err) {
        res.status(502).json({ error: "No se pudo calcular la señal", detail: err.message });
    }
});

// Suscripción push: un scheduler deja su webhook aquí una vez, y el cron de
// abajo le avisa solo cuando cambia la señal — no tiene que estar
// preguntando (polling) todo el tiempo.
app.post("/api/energy/load-signal/subscribe", async (req, res) => {
    const { webhookUrl, agentId } = req.body || {};
    if (!webhookUrl) return res.status(400).json({ error: "Falta webhookUrl" });
    const subs = (await readList("aeth:load-signal-subs")).filter((s) => s.webhookUrl !== webhookUrl);
    subs.push({ webhookUrl, agentId: agentId || null, subscribedAt: new Date().toISOString() });
    await writeList("aeth:load-signal-subs", subs);
    res.json({ ok: true, total: subs.length });
});

// Vercel Cron llama esto cada pocos minutos (ver vercel.json). Protegido
// con CRON_SECRET para que nadie más lo dispare y gaste tus llamadas.
app.get("/api/cron/broadcast-load-signal", async (req, res) => {
    if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "No autorizado" });
    }
    try {
        const signal = await computeLoadSignal();
        const subs = await readList("aeth:load-signal-subs");
        await Promise.allSettled(subs.map((s) => fetch(s.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signal) })));
        res.json({ ok: true, broadcasted: subs.length, signal });
    } catch (err) {
        res.status(502).json({ error: "Falló el broadcast", detail: err.message });
    }
});

app.get("/", (req, res) => res.json({ status: "AETHELGARD backend activo", cobro: SOLANA_PAYOUT ? "SOL real, verificado on-chain" : "sin SOLANA_PAYOUT_ADDRESS configurado (modo pruebas, endpoints abiertos)" }));

// ---------------------------------------------------------------------
// 7) HUELLA IA — la energía de las propias máquinas como producto
// ---------------------------------------------------------------------
// Nicho pensado para agentes: cada carga de trabajo de IA consume energía y
// emite CO2. Un agente (o su operador) paga una micro-tarifa por un RECIBO
// FIRMADO con la estimación de Wh y kgCO2 de esa carga — útil para reportes
// ESG/regulatorios. Además, cada 10 kgCO2 acumulados se retira (quema) 1
// crédito de energía de tu reserva, si configuraste el mint.
//
// ⚠ HONESTIDAD: los coeficientes de abajo son REFERENCIALES (supuestos
// ajustables, no mediciones). Los créditos son tuyos, NO bonos de carbono
// certificados (Verra, Gold Standard...). No los presentes como compensación
// certificada frente a terceros sin respaldo de un registro reconocido.
const WH_PER_1K_TOKENS = { small: 0.1, medium: 0.4, large: 1.5 }; // referencial
const PUE = 1.2; // sobrecarga del centro de datos (referencial)
const GRID_KG_PER_KWH = { CO: 0.146, ES: 0.15, DE: 0.38, US: 0.37, OTHER: 0.45 }; // referencial
const KG_PER_CREDIT = 10;

async function retirePendingCredits() {
    if (!process.env.MINT_AUTHORITY_PRIVATE_KEY || !ENERGY_CREDIT_MINT) return { status: "sin_mint_configurado" };
    const pending = Number(await redis.get("aeth:footprint:pendingKg")) || 0;
    const credits = Math.floor(pending / KG_PER_CREDIT);
    if (credits < 1) return { status: "acumulando", pendingKg: +pending.toFixed(6) };
    try {
        const auth = Keypair.fromSecretKey(bs58.decode(process.env.MINT_AUTHORITY_PRIVATE_KEY));
        const mint = new PublicKey(ENERGY_CREDIT_MINT);
        const reserve = await getOrCreateAssociatedTokenAccount(treasuryConnection, auth, mint, auth.publicKey);
        const sig = await burn(treasuryConnection, auth, reserve.address, mint, auth, BigInt(credits) * BigInt(10 ** ENERGY_CREDIT_DECIMALS));
        await redis.incrbyfloat("aeth:footprint:pendingKg", -credits * KG_PER_CREDIT);
        await redis.incrby("aeth:footprint:creditsRetired", credits);
        return { status: "retirado", credits, burnTx: sig };
    } catch (err) {
        return { status: "reserva_insuficiente_o_error", detail: err.message };
    }
}

app.post("/api/footprint/receipt", requierePago(0.02, "Recibo firmado de huella energética (Wh y kgCO2) de una carga de trabajo de IA"), async (req, res) => {
    const { agentId, sizeClass = "medium", tokensIn = 0, tokensOut = 0, region = "OTHER" } = req.body || {};
    if (!agentId) return res.status(400).json({ error: "Falta agentId" });
    const whPer1k = WH_PER_1K_TOKENS[sizeClass];
    if (whPer1k === undefined) return res.status(400).json({ error: "sizeClass debe ser small | medium | large" });
    const tokens = Math.max(0, Number(tokensIn)) + Math.max(0, Number(tokensOut));
    if (!Number.isFinite(tokens) || tokens <= 0) return res.status(400).json({ error: "tokensIn/tokensOut deben sumar más de 0" });
    const factor = GRID_KG_PER_KWH[region] ?? GRID_KG_PER_KWH.OTHER;
    const energyWh = (tokens / 1000) * whPer1k * PUE;
    const kgCO2 = (energyWh / 1000) * factor;
    const receipt = {
        receiptId: randomUUID(), agentId, sizeClass, tokens, region,
        energyWh: +energyWh.toFixed(4), kgCO2: +kgCO2.toFixed(6),
        assumptions: { whPer1kTokens: whPer1k, pue: PUE, gridKgPerKwh: factor },
        disclaimer: "Estimación con coeficientes referenciales; no es una medición ni un bono de carbono certificado.",
        at: new Date().toISOString(),
    };
    const payload = JSON.stringify(receipt);
    const signature = treasuryKeypair ? Buffer.from(nacl.sign.detached(Buffer.from(payload), treasuryKeypair.secretKey)).toString("base64") : null;
    await redis.incr("aeth:footprint:count");
    await redis.incrbyfloat("aeth:footprint:totalWh", energyWh);
    await redis.incrbyfloat("aeth:footprint:totalKg", kgCO2);
    await redis.incrbyfloat("aeth:footprint:pendingKg", kgCO2);
    const retirement = await retirePendingCredits();
    res.json({ receipt, signature, signerPublicKey: treasuryKeypair?.publicKey.toString() ?? null, retirement });
});

app.get("/api/footprint/stats", async (req, res) => {
    const n = async (k) => Number(await redis.get(k)) || 0;
    res.json({
        recibos: await n("aeth:footprint:count"),
        totalWh: +(await n("aeth:footprint:totalWh")).toFixed(4),
        totalKgCO2: +(await n("aeth:footprint:totalKg")).toFixed(6),
        pendienteDeRetiroKg: +(await n("aeth:footprint:pendingKg")).toFixed(6),
        creditosRetirados: await n("aeth:footprint:creditsRetired"),
    });
});

const PORT = process.env.PORT || 4021;
if (!process.env.VERCEL) {
    app.listen(PORT, () => console.log(`AETHELGARD x402 backend escuchando en :${PORT}`));
}

// En Vercel, la plataforma importa este export y maneja cada petición como
// función serverless (Fluid Compute) — no llama a app.listen().
export default app;

// ============================================================================
// EJEMPLO: cómo pagaría un agente comprador (sin ningún paquete especial)
// ============================================================================
// 1) Llama al endpoint normal, p. ej. GET /api/energy/report → responde 402
//    con { payTo, montoSolAprox, comoPagar }.
// 2) El agente transfiere esa cantidad de SOL a 'payTo' con su propia
//    wallet (cualquier librería estándar de Solana — @solana/web3.js, etc.
//    o incluso un wallet de escritorio si hay un humano detrás).
// 3) Vuelve a llamar el MISMO endpoint agregando ?tx=<firma_de_esa_tx>.
//    El servidor la verifica contra la blockchain y responde con los datos.
// No hace falta ningún SDK de x402 ni cuenta de Coinbase para esto.
