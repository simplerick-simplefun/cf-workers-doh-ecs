import { getEnv } from 'fastedge::env'; // If you want to use environment variables later

//// CHANGE UPSTREAM DoH service provider here ////
const URL_UPSTREAM_DNS_QUERY = 'https://dns.google/dns-query';
const URL_UPSTREAM_RESOLVE = 'https://dns.google/resolve';
//// CHANGE UPSTREAM DoH service provider here ////

// Constants for Content-Type and Accept headers
const APPL_DNS_MSG = 'application/dns-message';
const APPL_DNS_JSON = 'application/dns-json';

// Constants for query url path
const REQ_QUERY_PATHNAME = '/clean-dns-query';
const REQ_RESOLVE_PATHNAME = '/resolve';

// Register standard Service Worker event listener
addEventListener('fetch', (event) => {
    event.respondWith(handleRequest(event.request));
});

/**
 * Handles incoming HTTP requests and routes them.
 */
async function handleRequest(request) {
    try {
        const headers = normalizeHeaders(request.headers);
        const method = request.method;
        const urlObj = new URL(request.url);
        const pathname = urlObj.pathname;
        const searchParams = urlObj.searchParams;

        return await routeRequest(method, pathname, headers, searchParams, request);
    } catch (error) {
        return new Response(`Internal Server Error: ${error.message}`, {
            status: 500,
            headers: { 'content-type': 'text/plain' }
        });
    }
}

/**
 * Routes the incoming request and returns the upstream fetch response
 */
async function routeRequest(method, pathname, headers, searchParams, request) {
    if (method === 'POST' && pathname === REQ_QUERY_PATHNAME && headers.get('content-type') === APPL_DNS_MSG) {
        return await dns_query_post(request);
    } else if (method === 'GET' && pathname === REQ_RESOLVE_PATHNAME && headers.get('accept') === APPL_DNS_JSON && searchParams.has('name')) {
        return await dns_resolve_googlejson(request, searchParams);
    } else if (method === 'GET' && pathname === REQ_QUERY_PATHNAME && headers.get('accept') === APPL_DNS_MSG && searchParams.has('dns')) {
        return await dns_query_get(request, searchParams);
    } else {
        return new Response(null, { status: 404 });
    }
}

/**
 * Handles GET-based DoH queries with /dns-query endpoint
 */
async function dns_query_get(request, params) {
    let ecsData = getECSData(request);
    if (ecsData) {
        let origBuffer = decodeBase64Url(params.get("dns"));
        let newBuffer = modifyDNSQuery(origBuffer, ecsData);
        params.set("dns", encodeBase64Url(newBuffer));
    }

    const url = `${URL_UPSTREAM_DNS_QUERY}?${params.toString()}`;
    return fetch(url, { method: "GET", headers: { "accept": APPL_DNS_MSG } });
}

/**
 * Handles DNS queries via Google's JSON API with /resolve endpoint
 */
async function dns_resolve_googlejson(request, params) {
    if (!params.has("edns_client_subnet")) {
        let ecsData = getECSData(request);
        if (ecsData) {
            params.set("edns_client_subnet", `${ecsData.subnet}/${ecsData.prefix}`);
        }
    }
    
    const url = `${URL_UPSTREAM_RESOLVE}?${params.toString()}`;
    return fetch(url, { method: "GET", headers: { "accept": APPL_DNS_JSON } });
}

/**
 * Handles POST-based DoH queries with /dns-query endpoint
 */
async function dns_query_post(request) {
    let requestBody = await request.arrayBuffer(); 

    let ecsData = getECSData(request);
    if (ecsData) {
        requestBody = modifyDNSQuery(requestBody, ecsData).buffer; 
    }

    return fetch(URL_UPSTREAM_DNS_QUERY, {
        method: "POST",
        headers: { "content-type": APPL_DNS_MSG },
        body: requestBody
    });
}

/**
 * Extracts ECS (EDNS Client Subnet) data from client IP using Gcore edge headers
 */
function getECSData(request) {
    // Gcore forwards the client IP inside standard proxy headers
    let ip = request.headers.get("X-Real-IP") || request.headers.get("X-Forwarded-For");
    if (!ip) return null;
    
    ip = ip.split(',')[0].trim();

    if (ip.includes(":")) { 
        let truncatedIPv6 = truncateIPv6To56(ip); 
        return { family: 2, subnet: truncatedIPv6, prefix: 56 };
    } else { 
        let truncatedIPv4 = ip.split(".").slice(0, 3).join(".") + ".0"; 
        return { family: 1, subnet: truncatedIPv4, prefix: 24 };
    }
}

/**
 * Truncates an IPv6 address to its /56 prefix.
 */
function truncateIPv6To56(ipv6) {
    let segments = ipv6.split(':');
    if (segments.length < 8) {
        const missingSegments = 8 - segments.length;
        const emptySegments = new Array(missingSegments).fill('0000');
        segments.splice(segments.indexOf(''), 0, ...emptySegments);
    }
    segments = segments.map(seg => seg.padStart(4, '0'));
    segments[4] = segments[4].slice(0, 2) + '00'; 
    return segments.slice(0, 5).join(':') + ':0000:0000:0000';
}

/**
 * Encodes an IP address and prefix length into an EDNS Client Subnet (ECS) buffer.
 */
function encodeECStoBuffer(family, subnet, prefixLength) {
    let addressBytes;
    if (family === 2) {
        addressBytes = subnet.split(':').flatMap(part => part.match(/../g).map(b => parseInt(b, 16)));
    } else {
        addressBytes = subnet.split('.').map(n => parseInt(n, 10));
    }

    if (!addressBytes || addressBytes.length === 0) {
        throw new Error('Invalid IP address');
    }

    let addressLength = prefixLength / 8;                
    addressBytes = addressBytes.slice(0, addressLength); 

    let ecsLength = 8 + addressBytes.length;
    let ecsBuffer = new Uint8Array(ecsLength);
    
    ecsBuffer.set([                                      
        0x00, 0x08,                                      
        (ecsLength - 4) >> 8, (ecsLength - 4) & 0xff,    
        (family >> 8) & 0xff, family & 0xff,             
        prefixLength, 0x00,                              
        ...addressBytes                                  
    ]);

    return ecsBuffer;
}

function encodeBase64Url(data) {
    const base64 = btoa(String.fromCharCode(...data));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(base64Url) {
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/').padEnd(base64Url.length + (4 - (base64Url.length % 4)) % 4, '=');
    const binary = atob(base64);
    return new Uint8Array([...binary].map(char => char.charCodeAt(0)));
}

/**
 * Modifies a raw binary DNS query to include an ECS option
 */
function modifyDNSQuery(originalArrayBuffer, ecsData) {
    if (!originalArrayBuffer || originalArrayBuffer.byteLength === 0) {
        throw new Error('Invalid DNS query data');
    }

    const OPT_TYPE = 41; 
    const ECS_OPTION_CODE = 0x08;

    let originalBuffer = new Uint8Array(originalArrayBuffer); 
    let offset = 12;
    let qdcount = (originalBuffer[4] << 8) | originalBuffer[5];
    let arcount = (originalBuffer[10] << 8) | originalBuffer[11];

    for (let i = 0; i < qdcount; i++) {
        while (originalBuffer[offset] !== 0) offset++;
        offset += 5; 
    }

    let addOffset = offset;
    let hasOPT = false;
    let hasECS = false;

    for (let i = 0; i < arcount; i++) {
        let pos = addOffset;
        while (originalBuffer[pos] !== 0) pos++;
        pos++;
        let type = (originalBuffer[pos] << 8) | originalBuffer[pos + 1];
        if (type === OPT_TYPE) {
            hasOPT = true;
            let optPos = pos + 10;
            while (optPos < originalBuffer.length) {
                let optionCode = (originalBuffer[optPos] << 8) | originalBuffer[optPos + 1];
                if (optionCode === ECS_OPTION_CODE) {
                    hasECS = true;
                    break;
                }
                let optionLength = (originalBuffer[optPos + 2] << 8) | originalBuffer[optPos + 3];
                optPos += 4 + optionLength;
            }
            break;
        }
        addOffset = pos + 10 + ((originalBuffer[pos + 8] << 8) | originalBuffer[pos + 9]);
    }

    if (hasECS) {
        return originalBuffer;
    }

    let ecsBuffer = encodeECStoBuffer(ecsData.family, ecsData.subnet, ecsData.prefix);
    let newBuffer;

    if (hasOPT) {
        newBuffer = new Uint8Array(originalBuffer.length + ecsBuffer.length);
        newBuffer.set(originalBuffer.subarray(0, addOffset + 10), 0);
        newBuffer.set(ecsBuffer, addOffset + 10);
        newBuffer.set(originalBuffer.subarray(addOffset + 10), addOffset + 10 + ecsBuffer.length);
    } else {
        let optHeader = new Uint8Array(11);
        optHeader.set([
            0,                                              
            OPT_TYPE >> 8, OPT_TYPE & 0xff,                 
            0x10, 0x00,                                     
            0, 0, 0, 0,                                     
            ecsBuffer.length >> 8, ecsBuffer.length & 0xff  
        ]);
        newBuffer = new Uint8Array(originalBuffer.length + optHeader.length + ecsBuffer.length);
        newBuffer.set(originalBuffer, 0);
        newBuffer.set(optHeader, originalBuffer.length);
        newBuffer.set(ecsBuffer, originalBuffer.length + optHeader.length);
        newBuffer[10] = (arcount + 1) >> 8;
        newBuffer[11] = (arcount + 1) & 0xff;
    }

    return newBuffer;
}

function normalizeHeaders(requestHeaders) {
    const headers = new Headers();
    for (const [key, value] of requestHeaders) {
        headers.set(key.toLowerCase(), value);
    }
    return headers;
}