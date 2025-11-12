// --- 1. Railway Port Configuration ---
// Railway provides the port to listen on via the $PORT environment variable.
// We'll default to 8000 for local development.
const port = Deno.env.get("PORT") || "8000";
console.log(`[Proxy] Starting server, listening on port ${port}...`);

// Deno Deploy entry point uses the standard RequestListener
// We use Deno.serve to listen for requests.
Deno.serve({ port: parseInt(port, 10) }, async (request) => {
    return handle(request);
});


/*
    WARNING: This in-memory rate limiter is for demonstration only.
    It WILL NOT work reliably on Railway (or Deno Deploy) for high traffic.
    
    Railway runs services in containers, and multiple instances (containers) 
    may be spun up to handle load. Each instance would have its OWN 
    separate 'ipMap', completely defeating the global rate limit.

    For a production-ready solution, you MUST use a shared state store
    like Redis (which you can add as a service on Railway).
*/
const RATE_LIMIT = 60; // Max requests per minute per IP
const ipMap = new Map<string, number[]>(); // Using a Map for in-memory store

async function handle(request: Request): Promise<Response> {

    // --- 2. Handle CORS Preflight (OPTIONS) Requests ---
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
        });
    }

    // --- 3. Rate Limiting (Demonstration Only - SEE WARNING) ---
    // Deno Deploy uses 'x-forwarded-for' or the direct connection IP.
    // Railway also provides 'x-forwarded-for'.
    const ipHeader = request.headers.get("x-forwarded-for") || request.headers.get("host") || "unknown";
    const ip = ipHeader.split(',')[0].trim(); // Get the first IP in the list

    const now = Date.now();
    const windowStart = now - 60_000; // 1-minute sliding window

    // Filter out old timestamps and check the count
    const timestamps = (ipMap.get(ip) || []).filter(t => t > windowStart);
    if (timestamps.length >= RATE_LIMIT) {
        return new Response(JSON.stringify({ error: "Too many requests" }), { 
            status: 429,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            }
        });
    }
    timestamps.push(now);
    ipMap.set(ip, timestamps);


    // --- 4. Extract API Key from Header and Validate Body ---
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "Missing or invalid Authorization header." }), {
            status: 401,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
        });
    }

    let body;
    try {
        // Must clone the request to read the body and re-read it later if needed, 
        // but here we only read it once to parse JSON.
        const requestClone = request.clone(); 
        body = await requestClone.json();
        if (!body.model) {
            throw new Error("Missing 'model' in request body");
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message || "Invalid or empty JSON body" }), {
            status: 400,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
        });
    }

    // --- 5. Forward the Request to the Target API (Stealth Mode) ---
    const targetUrl = "https://api.electronhub.ai/v1/chat/completions";

    const outgoingHeaders = new Headers();
    outgoingHeaders.set("Content-Type", "application/json");
    outgoingHeaders.set("Authorization", authHeader); // Forward the original auth header

    // Intelligently forward client headers to mimic the original request.
    const headersToForward = [
        'User-Agent',
        'Accept',
        'Accept-Language',
        'Accept-Encoding',
    ];

    headersToForward.forEach(headerName => {
        const headerValue = request.headers.get(headerName);
        if (headerValue) {
            outgoingHeaders.set(headerName, headerValue);
        }
    });

    const fetchOptions: RequestInit = {
        method: "POST",
        headers: outgoingHeaders, 
        body: JSON.stringify(body),
    };

    try {
        const targetResponse = await fetch(targetUrl, fetchOptions);
        
        // Clone the response to modify headers while keeping the body stream
        const response = new Response(targetResponse.body, targetResponse);
        response.headers.set("Access-Control-Allow-Origin", "*");
        
        // Clean up or adjust other headers from the upstream if necessary
        // response.headers.delete("Header-To-Remove");

        return response;

    } catch (error) {
        console.error("Target API Fetch Failed:", error);
        return new Response(JSON.stringify({ error: "Failed to connect to the target API" }), {
            status: 502,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
        });
    }
}