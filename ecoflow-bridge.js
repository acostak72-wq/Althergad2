// Puente EcoFlow → AETHELGARD
// -----------------------------------------------------------------------
// Lee la batería/watts reales de tu EcoFlow (API oficial de desarrollador)
// y los reenvía a tu propio backend como telemetría de un dispositivo ya
// registrado en /api/devices/register.
//
// Variables de entorno necesarias:
//   ECOFLOW_ACCESS_KEY=     de developer-eu.ecoflow.com o developer.ecoflow.com
//   ECOFLOW_SECRET_KEY=
//   ECOFLOW_REGION=         "eu" o "global" (default: "eu")
//   ECOFLOW_DEVICE_SN=      número de serie de tu EcoFlow (lo ves en la app o
//                           llamando primero a /iot-open/sign/device/list)
//   AETHELGARD_BACKEND_URL= tu backend ya desplegado
//   AETHELGARD_DEVICE_ID=   el deviceId con el que lo registraste
//   AETHELGARD_DEVICE_TOKEN= el token que /api/devices/register te dio
//
// Uso: node ecoflow-bridge.js   (o prográmalo cada pocos minutos con cron)

import "dotenv/config";
import { createHmac } from "crypto";

const REGION = process.env.ECOFLOW_REGION === "global" ? "global" : "eu";
const ECOFLOW_BASE = REGION === "global" ? "https://api.ecoflow.com" : "https://api-e.ecoflow.com";
const ACCESS_KEY = process.env.ECOFLOW_ACCESS_KEY;
const SECRET_KEY = process.env.ECOFLOW_SECRET_KEY;
const DEVICE_SN = process.env.ECOFLOW_DEVICE_SN;

function ecoflowSign(params) {
    const nonce = String(Math.floor(100000 + Math.random() * 900000));
    const timestamp = String(Date.now());
    const sortedKv = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
    const toSign = (sortedKv ? sortedKv + "&" : "") + `accessKey=${ACCESS_KEY}&nonce=${nonce}&timestamp=${timestamp}`;
    const sign = createHmac("sha256", SECRET_KEY).update(toSign).digest("hex");
    return { nonce, timestamp, sign };
}

async function ecoflowGet(path, params = {}) {
    const { nonce, timestamp, sign } = ecoflowSign(params);
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`${ECOFLOW_BASE}${path}${qs ? "?" + qs : ""}`, {
        headers: { accessKey: ACCESS_KEY, nonce, timestamp, sign },
    });
    const data = await r.json();
    if (data.code !== "0" && data.code !== 0) throw new Error(`EcoFlow error ${data.code}: ${data.message}`);
    return data.data;
}

async function main() {
    // Trae TODO el "quota" del dispositivo — un diccionario grande con
    // decenas de campos. Los nombres exactos (soc, watts, etc.) varían
    // según el modelo; imprime el resultado la primera vez y ajusta el
    // mapeo de abajo con los campos reales que veas.
    const quota = await ecoflowGet("/iot-open/sign/device/quota/all", { sn: DEVICE_SN });
    console.log("Datos crudos de EcoFlow (ajusta el mapeo según esto):", quota);

    // Mapeo típico en modelos Delta/River (AJUSTA según el console.log de arriba):
    const soc = quota["bms_bmsStatus.soc"] ?? quota["soc"] ?? null;
    const wattsIn = quota["inv.inputWatts"] ?? quota["wattsInSum"] ?? null;
    const wattsOut = quota["inv.outputWatts"] ?? quota["wattsOutSum"] ?? null;

    const reading = {
        deviceId: process.env.AETHELGARD_DEVICE_ID,
        token: process.env.AETHELGARD_DEVICE_TOKEN,
        watts: wattsOut,
        kwhProduced: null, // EcoFlow no siempre expone kWh acumulado; derívalo si lo necesitas
        kwhConsumed: null,
        voltage: null,
        soc, // % de batería — campo extra, tu backend lo guarda igual dentro del body
    };

    const r = await fetch(`${process.env.AETHELGARD_BACKEND_URL}/api/devices/telemetry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reading),
    });
    console.log("Respuesta de tu backend:", await r.json());
}

main().catch((err) => console.error("Error en el puente EcoFlow:", err.message));
