// Constants for Upstream DoH service providers
const URL_UPSTREAM_DNS_QUERY = 'https://dns.google/dns-query';
const URL_UPSTREAM_RESOLVE = 'https://dns.google/resolve';

// Constants for Content-Type and Accept headers
const APPL_DNS_MSG = 'application/dns-message';
const APPL_DNS_JSON = 'application/dns-json';

// Constants for query url path
const REQ_QUERY_PATHNAME = '/dns-query';
const REQ_RESOLVE_PATHNAME = '/resolve';

// Customizable IP prefix length
// These initial values are recommended by RFC 7871, section 11.1
const ipv4PrefixLength = 24;
const ipv6PrefixLength = 56;



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
    let ecsData = getECSData(request);
    if (ecsData) {
        try {
            let origBuffer = decodeBase64Url(dnsParam);
            let newBuffer = modifyDNSQuery(origBuffer, ecsData);
            params.set("dns", encodeBase64Url(newBuffer));
        } catch (e) {
            return new Response(`DNS decoding failure: ${e.message}`, { status: 400 });
        }
    }
    const url = `${URL_UPSTREAM_DNS_QUERY}?${params.toString()}`;
    
    return fetch(url, {method: "GET", headers: { "accept": APPL_DNS_MSG }});
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
        let truncatedIPv6 = truncateIPv6To56(ip, ipv6PrefixLength);
        return { family: 2, subnet: truncatedIPv6, prefix: 56 };
    } else { 
        let truncatedIPv4 = truncateIPv4(ip, ipv4PrefixLength);
        return { family: 1, subnet: truncatedIPv4, prefix: 24 };
    }
}

function truncateIPv4(ip, prefixLength) {
    const parts = ip.split(".").map(Number);

    const ipInt =
        (parts[0] << 24) |
        (parts[1] << 16) |
        (parts[2] << 8)  |
        (parts[3]);

    const mask =
        prefixLength === 0
            ? 0
            : (0xffffffff << (32 - prefixLength)) >>> 0;

    const truncated = (ipInt & mask) >>> 0;

    return [
        (truncated >>> 24) & 0xff,
        (truncated >>> 16) & 0xff,
        (truncated >>> 8) & 0xff,
        truncated & 0xff
    ].join(".");
}

/**
 * Truncates an IPv6 address to its /56 prefix.
 */
function truncateIPv6To56(ipv6, prefixLength) {
    if (prefixLength < 0 || prefixLength > 128) {
        throw new Error("Invalid IPv6 prefix length");
    }

    let segments = ipv6.split(':');
    if (segments.length < 8) {
        const missingSegments = 8 - segments.length;
        const emptySegments = new Array(missingSegments).fill('0000');
        segments.splice(segments.indexOf(''), 0, ...emptySegments);
    }
    segments = segments.map(seg => seg.padStart(4, '0'));
    
    const fullGroups = Math.floor(prefixLength / 16);
    const remainingBits = prefixLength % 16;

    if (remainingBits === 0) {
        segments[fullGroups] = '0000';
    } else {
        const value = parseInt(segments[fullGroups], 16);
        const mask = (0xffff << (16 - remainingBits)) & 0xffff;
        
        segments[fullGroups] = (value & mask).toString(16).padStart(4, '0');
    }
    
    for (let i = fullGroups + 1; i < 8; i++) {
        segments[i] = '0000';
    }

    return segments.join(':');
}

// Encode to Base64Url format
function encodeBase64Url(data) {
  const base64 = btoa(String.fromCharCode(...data));
  return base64
      .replace(/\+/g, '-') // Replace '+' with '-'
      .replace(/\//g, '_') // Replace '/' with '_'
      .replace(/=+$/, ''); // Remove '=' padding
}

// Decode from Base64Url format
function decodeBase64Url(base64Url) {
  // Convert from Base64Url to standard Base64
  const base64 = base64Url
      .replace(/-/g, '+') // Replace '-' with '+'
      .replace(/_/g, '/') // Replace '_' with '/'
      .padEnd(base64Url.length + (4 - (base64Url.length % 4)) % 4, '='); // Fix padding if needed

  const binary = atob(base64);
  return new Uint8Array([...binary].map(char => char.charCodeAt(0)));
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
      addressBytes = [];
      for (const part of subnet.split(':')) {
          addressBytes.push(
              parseInt(part.substring(0, 2), 16),
              parseInt(part.substring(2, 4), 16)
          );
      }
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
  let optionLength = 4 + addressBytes.length;
  let ecsLength = 4 + optionLength;
  let ecsBuffer = new Uint8Array(ecsLength);
  
  ecsBuffer.set([                                      // EDNS Client Subnet structure:
      0x00, 0x08,                                      // uint16::Option Code = 8 (ECS)
      optionLength >> 8, optionLength & 0xff,    // uint16::Option Length
      (family >> 8) & 0xff, family & 0xff,             // uint16::Address Family (1 = IPv4, 2 = IPv6)
      prefixLength, 0x00,                              // uint8::Source Prefix Length, uint8::Scope Prefix Length (always 0)
      ...addressBytes                                  // variable_length::Address bytes (truncated to prefix length)
  ]);

  return ecsBuffer;
}

function skipQuestion(buf, pos, count) {
    for (let i = 0; i < count; i++) {
        while (true) {
            const len = buf[pos];
            if (len === 0) {
                pos += 1;
                break;
            }
            if ((len & 0xc0) === 0xc0) {
                // compression pointer
                pos += 2;
                break;
            }
            pos += len + 1;
        }
        pos += 4;
    }
    return pos;
}
function skipName(buf, pos) {
    while (true) {
        const len = buf[pos];
        // End of name
        if (len === 0) return pos + 1;
        // DNS compression pointer: 11xxxxxx xxxxxxxx
        if ((len & 0xc0) === 0xc0) {
            return pos + 2; // pointer is 2 bytes total
        }
        // normal label
        pos += len + 1;
        // safety guard (prevents infinite loop on corrupted packets)
        if (pos >= buf.length) {
            throw new Error("Malformed DNS name (out of bounds)");
        }
    }
}
function skipRR(buf, pos) {
    pos = skipName(buf, pos);

    const rdlen = (buf[pos + 8] << 8) | buf[pos + 9];
    pos += 10;      // TYPE+CLASS+TTL+RDLEN, move to RDATA
    pos += rdlen;   // skip RDATA

    return pos;
}
function skipSection(buf, pos, count) {
    for (let i = 0; i < count; i++) {
        pos = skipRR(buf, pos);
    }
    return pos;
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
    let qdcount = (originalBuffer[4] << 8) | originalBuffer[5];
    let ancount = (originalBuffer[6] << 8) | originalBuffer[7];
    let nscount = (originalBuffer[8] << 8) | originalBuffer[9];
    let arcount = (originalBuffer[10] << 8) | originalBuffer[11];

    let pos = 12;
    pos = skipQuestion(originalBuffer, pos, qdcount); // skip QD
    pos = skipSection(originalBuffer, pos, ancount);  // skip AN
    pos = skipSection(originalBuffer, pos, nscount);  // skip NS
    
    // prepare variables for OPT identification and ECS injection
    let hasOPT = false;
    let hasECS = false;
    let rdlen;
    let rdlenPos;
    let nextRRPos;

    // traverse AR
    for (let i = 0; i < arcount; i++) {
        // Data Structure(RR): NAME+TYPE(2)+CLASS(2)+TTL(4)+RDLEN(2)+RDATA...
        // NAME is either 'Plain label sequence' (variable length)
        //             or 'Compressed pointer'   (2 bytes)
        //             or 'Single zero octet'    (1 byte)
        
        // pos now at NAME[0]
        pos = skipName(originalBuffer, pos);
        // pos now at TYPE[0]
        rdlenPos = pos + 8;
        let rdataPos = rdlenPos + 2;
        rdlen = (originalBuffer[rdlenPos] << 8) | originalBuffer[rdlenPos + 1];
        nextRRPos = rdataPos + rdlen; // skip RDATA and move to next RR
        
        let arType = (originalBuffer[pos] << 8) | originalBuffer[pos + 1];
        // check for $hasOPT and $hasECS
        if (arType === OPT_TYPE) {
            hasOPT = true;
            // Check if the OPT record already contains an ECS option
            while (rdataPos + 4 < nextRRPos) {
                let optionCode = (originalBuffer[rdataPos] << 8) | originalBuffer[rdataPos + 1];
                if (optionCode === ECS_OPTION_CODE) {
                    hasECS = true;
                    break; // if found ECS, stop the loop "traverse OPT"
                }
                let optionLength = (originalBuffer[rdataPos + 2] << 8) | originalBuffer[rdataPos + 3];
                rdataPos += (4 + optionLength);
            }
            break; // if found OPT, stop the loop "traverse AR"
        }
        // move to next RR
        pos = nextRRPos;
    }

    if (hasECS) {
        return originalBuffer;
    }

    let ecsBuffer = encodeECStoBuffer(ecsData.family, ecsData.subnet, ecsData.prefix);
    let newBuffer;

    if (hasOPT) {
        // If an OPT record already exists, inject ECS data into it
        newBuffer = new Uint8Array(originalBuffer.length + ecsBuffer.length);
        newBuffer.set(originalBuffer.subarray(0, nextRRPos), 0);
        newBuffer.set(ecsBuffer, nextRRPos);
        newBuffer.set(originalBuffer.slice(nextRRPos), nextRRPos + ecsBuffer.length);
        // Update RDLEN of OPT
        let new_rdlen = rdlen + ecsBuffer.length;
        newBuffer[rdlenPos] = (new_rdlen >> 8) & 0xff;
        newBuffer[rdlenPos + 1] = new_rdlen & 0xff;
    } else {
        let optHeader = new Uint8Array(11);
        optHeader.set([
            0,                                              // uint8 ::MUST be 0 (root domain)
            OPT_TYPE >> 8, OPT_TYPE & 0xff,                 // uint16::OPT code (OPT_TYPE=41)
            0x04, 0xd0,                                     // uint16::UDP payload size (1232)
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
