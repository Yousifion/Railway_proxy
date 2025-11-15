import express, { Request, Response, NextFunction } from 'express';
// Use node-fetch for compatibility with the Deno-style fetch API
import fetch, { RequestInit, HeadersInit } from 'node-fetch';

const app = express();
// Railway provides the port via the PORT environment variable
const PORT = process.env.PORT || 3000;

// 🛑 IMPORTANT UPDATE: Increase body size limit to 50mb to handle large payloads (e.g., 22k tokens)
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

/*
    WARNING: This in-memory rate limiter is for demonstration only.
    It WILL NOT work reliably in a real multi-instance environment (like Railway with scaling)
    without a shared database (e.g., Redis).
*/
const RATE_LIMIT = 60; // Max requests per minute per IP
// Use a Map for in-memory store, storing timestamps for each IP
const ipMap = new Map<string, number[]>(); 

// --- Rate Limiting Middleware ---
const rateLimiter = (req: Request, res: Response, next: NextFunction) => {
    // In Express/Railway, the client IP is typically found in 'x-forwarded-for' 
    const ipHeader = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "unknown";
    // Get the first IP in the list (most likely the client)
    const ip = Array.isArray(ipHeader) ? ipHeader[0].split(',')[0].trim() : ipHeader.split(',')[0].trim();

    const now = Date.now();
    const windowStart = now - 60_000; // 1-minute sliding window

    // Filter out old timestamps and check the count
    const timestamps = (ipMap.get(ip) || []).filter(t => t > windowStart);
    if (timestamps.length >= RATE_LIMIT) {
        return res.status(429).send("Too many requests");
    }
    timestamps.push(now);
    ipMap.set(ip, timestamps);
    
    next();
};

// --- CORS Middleware ---
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    
    // Handle CORS Preflight (OPTIONS) Requests
    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    
    next();
});

// --- Main Proxy Route ---
app.post('/', rateLimiter, async (req: Request, res: Response) => {

    // --- 1. Extract API Key from Header and Validate Body ---
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing or invalid Authorization header." });
    }

    if (!req.body || !req.body.model) {
        const errorMsg = req.body ? "Missing 'model' in request body" : "Invalid or empty JSON body";
        return res.status(400).json({ error: errorMsg });
    }

    // --- 2. Forward the Request to the Target API (Stealth Mode) ---
    const targetUrl = "https://api.electronhub.ai/v1/chat/completions";

    const outgoingHeaders: HeadersInit = {
        "Content-Type": "application/json",
        "Authorization": authHeader, // Forward the original auth header
    };

    // Intelligently forward client headers to mimic the original request.
    const headersToForward = [
        'user-agent',
        'accept',
        'accept-language',
        'accept-encoding',
    ];

    headersToForward.forEach(headerName => {
        const headerValue = req.headers[headerName];
        if (headerValue) {
            // Headers in Node.js/Express are lowercase
            outgoingHeaders[headerName] = Array.isArray(headerValue) ? headerValue.join(', ') : headerValue;
        }
    });

    const fetchOptions: RequestInit = {
        method: "POST",
        headers: outgoingHeaders, 
        body: JSON.stringify(req.body),
    };

    try {
        const targetResponse = await fetch(targetUrl, fetchOptions);
        
        // --- 3. Forward the Response back to the Client ---
        
        // Copy all headers from the target API to the client response
        targetResponse.headers.forEach((value, name) => {
            // Don't forward CORS or headers managed by the proxy/server
            if (name !== 'access-control-allow-origin') {
                res.setHeader(name, value);
            }
        });

        // Ensure CORS is set correctly for the client
        res.setHeader("Access-Control-Allow-Origin", "*");

        // Send the correct status and pipe the body stream back
        res.status(targetResponse.status);
        if (targetResponse.body) {
            targetResponse.body.pipe(res);
        } else {
            res.end();
        }

    } catch (error) {
        console.error("Target API Fetch Failed:", error);
        return res.status(502).json({ error: "Failed to connect to the target API" });
    }
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`⚡️ Proxy server listening on port ${PORT}`);
});