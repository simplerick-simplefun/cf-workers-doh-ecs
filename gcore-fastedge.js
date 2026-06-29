// Constants for Upstream DoH service providers
const URL_UPSTREAM_DNS_QUERY = 'https://dns.google/dns-query';
const URL_UPSTREAM_RESOLVE = 'https://dns.google/resolve';

// Constants for Content-Type and Accept headers
const APPL_DNS_MSG = 'application/dns-message';
const APPL_DNS_JSON = 'application/dns-json';

// Constants for query url path
const REQ_QUERY_PATHNAME = '/dns-query';
const REQ_RESOLVE_PATHNAME = '/resolve';

// Pure JavaScript Base64 Maps - SAFELY INITIALIZED
const b64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64Lookup = new Uint8Array(256);

// Immediate execution function to lock map generation and protect global context mutation
(() => {
    for (let i = 0; i < b64Chars.length; i++) {
        b64Lookup[b64Chars.charCodeAt(i)] = i;
    }
})();

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
        const method = request.method || 'GET';
        
        // SAFE URL PARSING: Handle potential relative request paths
        let urlStr = request.url || '/';
        if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
            urlStr = 'https://local-edge.internal' + (urlStr.startsWith('/') ? '' : '/') + urlStr;
        }
        
        const urlObj = new URL(urlStr);
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
        return new Response('Not Found', { status: 404 });
    }
}

function bufferToHex(buffer, max = 256) {
    const bytes = new Uint8Array(buffer);
    let out = [];
    
    const len = Math.min(bytes.length, max);

    for (let i = 0; i < len; i++) {
        out.push(bytes[i].toString(16).padStart(2, '0'));
    }

    return out.join(' ') + (bytes.length > max ? ' ...' : '');
}
/**
 * Handles GET-based DoH queries with /dns-query endpoint
 */
async function dns_query_get(request, params) {
    const dnsParam = params.get("dns");
    if (!dnsParam) {
        return new Response("Missing 'dns' parameter", { status: 400 });
    }
    console.log("STEP 4: ", params.toString());
    let ecsData = getECSData(request);
    if (ecsData) {
        try {
            let origBuffer = decodeBase64Url(dnsParam);
            let newBuffer = modifyDNSQuery(origBuffer, ecsData);
            
            console.log("origBuffer HEX:", bufferToHex(origBuffer));
            console.log("newBuffer HEX:", bufferToHex(newBuffer));
            
            params.set("dns", encodeBase64Url(newBuffer));
        } catch (e) {
            return new Response(`DNS decoding failure: ${e.message}`, { status: 400 });
        }
    }
    console.log("STEP 5: ", params.toString());
    const url = `${URL_UPSTREAM_DNS_QUERY}?${params.toString()}`;
    console.log("STEP 6");
    try {
        return await fetch(url, {
            method: "GET",
            headers: { "accept": APPL_DNS_MSG }
        });
    } catch (e) {
        console.error("FETCH FAILED:", e);
        return new Response("Upstream failure", { status: 502 });
    }
    console.log("STEP 7");
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
    if (!requestBody || requestBody.byteLength === 0) {
        return new Response("Empty query payload", { status: 400 });
    }

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
    let ip = request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for");
    if (!ip) return null;
    
    ip = ip.split(',')[0].trim();

    if (ip.includes(":")) { 
        let truncatedIPv6 = truncateIPv6To56(ip);
        console.log("ecs ip: ", truncatedIPv6);
        return { family: 2, subnet: truncatedIPv6, prefix: 56 };
    } else { 
        let truncatedIPv4 = ip.split(".").slice(0, 3).join(".") + ".0"; 
        console.log("ecs ip: ", truncatedIPv4);
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

  // Convert IP address to bytes
  // IP address already filled with 0s for missing segments
  //            already padded to full size for each segment with heading 0s,
  //            already trancated to prefix length with trailing 0s
  if (family === 2) {
      // IPv6
      addressBytes = subnet.split(':')
          .flatMap(part => 
              part.match(/../g).map(b => parseInt(b, 16))
          );
  } else {
      // IPv4
      addressBytes = subnet.split('.').map(n => parseInt(n, 10));
  }

  if (!addressBytes || addressBytes.length === 0) {
      throw new Error('Invalid IP address');
  }

  // We are using fixed prefix lengths of 24 and 56, so do not need to worry about not dividing evenly
  let addressLength = prefixLength / 8;                // Number of bytes(octects) to keep according to prefix length
  addressBytes = addressBytes.slice(0, addressLength); // Address (truncated address to prefix length)

  // Create buffer for header + truncated address
  let ecsLength = 8 + addressBytes.length;
  let ecsBuffer = new Uint8Array(ecsLength);
  
  ecsBuffer.set([                                      // EDNS Client Subnet structure:
      0x00, 0x08,                                      // uint16::Option Code = 8 (ECS)
      (ecsLength - 4) >> 8, (ecsLength - 4) & 0xff,    // uint16::Option Length
      (family >> 8) & 0xff, family & 0xff,             // uint16::Address Family (1 = IPv4, 2 = IPv6)
      prefixLength, 0x00,                              // uint8::Source Prefix Length, uint8::Scope Prefix Length (always 0)
      ...addressBytes                                  // variable_length::Address bytes (truncated to prefix length)
  ]);

  return ecsBuffer;
}

// Custom Pure JavaScript Base64Url Encoder
function encodeBase64Url(uint8Array) {
    let len = uint8Array.length;
    let base64 = '';
    for (let i = 0; i < len; i += 3) {
        let b1 = uint8Array[i];
        let b2 = i + 1 < len ? uint8Array[i + 1] : NaN;
        let b3 = i + 2 < len ? uint8Array[i + 2] : NaN;

        let enc1 = b1 >> 2;
        let enc2 = ((b1 & 3) << 4) | (isNaN(b2) ? 0 : b2 >> 4);
        let enc3 = isNaN(b2) ? 64 : ((b2 & 15) << 2) | (isNaN(b3) ? 0 : b3 >> 6);
        let enc4 = isNaN(b3) ? 64 : b3 & 63;

        base64 += b64Chars.charAt(enc1) + b64Chars.charAt(enc2) +
                  (enc3 === 64 ? '' : b64Chars.charAt(enc3)) +
                  (enc4 === 64 ? '' : b64Chars.charAt(enc4));
    }
    return base64.replace(/\+/g, '-').replace(/\//g, '_');
}

// Custom Pure JavaScript Base64Url Decoder
function decodeBase64Url(base64Url) {
    let str = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) {
        str += '=';
    }
    
    let len = str.length;
    let bufferLength = str.length * 0.75;
    if (str[str.length - 1] === '=') {
        bufferLength--;
        if (str[str.length - 2] === '=') bufferLength--;
    }

    let bytes = new Uint8Array(bufferLength);
    let p = 0;

    for (let i = 0; i < len; i += 4) {
        let enc1 = b64Lookup[str.charCodeAt(i)];
        let enc2 = b64Lookup[str.charCodeAt(i + 1)];
        let enc3 = b64Lookup[str.charCodeAt(i + 2)];
        let enc4 = b64Lookup[str.charCodeAt(i + 3)];

        bytes[p++] = (enc1 << 2) | (enc2 >> 4);
        if (enc3 !== 64 && p < bufferLength) {
            bytes[p++] = ((enc2 & 15) << 4) | (enc3 >> 2);
        }
        if (enc4 !== 64 && p < bufferLength) {
            bytes[p++] = ((enc3 & 3) << 6) | enc4;
        }
    }
    return bytes;
}

/**
 * Modifies a raw binary DNS query to include an ECS option
 */
function modifyDNSQuery(originalArrayBuffer, ecsData) {
    if (!originalArrayBuffer || originalArrayBuffer.byteLength === 0) {
        throw new Error('Invalid DNS query data');
    }

    const OPT_TYPE = 41; // EDNS OPT record type
    const ECS_OPTION_CODE = 0x08;

    let originalBuffer = new Uint8Array(originalArrayBuffer); // Convert to Uint8Array
    let offset = 12;
    let qdcount = (originalBuffer[4] << 8) | originalBuffer[5];
    let arcount = (originalBuffer[10] << 8) | originalBuffer[11];

    for (let i = 0; i < qdcount; i++) {
        while (originalBuffer[offset] !== 0) offset++;
        offset += 5; // Skip the end of QNAME + QTYPE + QCLASS
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

            // Check if the OPT record already contains an ECS option
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
        // If an OPT record already exists, append ECS data to it
        newBuffer = new Uint8Array(originalBuffer.length + ecsBuffer.length);
        newBuffer.set(originalBuffer.subarray(0, addOffset + 10), 0);
        newBuffer.set(ecsBuffer, addOffset + 10);
        newBuffer.set(originalBuffer.subarray(addOffset + 10), addOffset + 10 + ecsBuffer.length);
    } else {
        let optHeader = new Uint8Array(11);
        optHeader.set([
            0,                                              // uint8 ::MUST be 0 (root domain)
            OPT_TYPE >> 8, OPT_TYPE & 0xff,                 // uint16::OPT code (OPT_TYPE=41)
            0x10, 0x00,                                     // uint16::UDP payload size (4096)
            0, 0, 0, 0,                                     // uint32::extended RCODE and flags
            ecsBuffer.length >> 8, ecsBuffer.length & 0xff  // uint16::length of all RDATA
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
    if (requestHeaders) {
        for (const [key, value] of requestHeaders) {
            headers.set(key.toLowerCase(), value);
        }
    }
    return headers;
}
