//// Change your DoH upstream here ////
const URL_UPSTREAM_DNS_QUERY = 'https://dns.google/dns-query';
const URL_UPSTREAM_RESOLVE = 'https://dns.google/resolve';
//// Change your DoH upstream here ////

const APPL_DNS_MSG = 'application/dns-message'
const APPL_DNS_JSON = 'application/dns-json'

// developers.cloudflare.com/workers/runtime-apis/fetch-event/#syntax-module-worker
export default {
    async fetch(r, env, ctx) {
        return handleRequest(r);
    },
};


/**
 * Truncates an IPv6 address to its /56 prefix.
 *
 * This function expands any "::" shorthand to ensure the address has 8 segments,
 * pads each segment to 4 digits, and then truncates the address to the first 5 segments.
 * The last two characters of the 5th segment are replaced with "00", and the remaining
 * segments are set to "0000".
 *
 * @param {string} ipv6 - The IPv6 address to truncate.
 * @returns {string} - The truncated IPv6 address with a /56 prefix.
 */
function truncateIPv6To56(ipv6) {
  // Expand "::" to have 8 segments
  let segments = ipv6.split(':');

  // If the address has fewer than 8 segments due to "::", fill in the missing segments
  if (segments.length < 8) {
    const missingSegments = 8 - segments.length;
    const emptySegments = new Array(missingSegments).fill('0000');
    segments.splice(segments.indexOf(''), 0, ...emptySegments);
  }

  // Ensure each segment is 4 digits long, pad with 0s if needed
  segments = segments.map(seg => seg.padStart(4, '0'));

  // truncate the 5th segment's last two characters to "00"
  segments[4] = segments[4].slice(0, 2) + '00'; // Modify the last 2 digits of the 5th segment

  // Keep first 5 segments, rejoin the segments and add the trailing 0s
  return segments.slice(0, 5).join(':') + ':0000:0000:0000';
}

/**
 * Extracts ECS (EDNS Client Subnet) data from client IP
 * @param {Request} request
 * @returns {Object|null} ECS Data { family, subnet, prefix } or null if not applicable
 */
function getECSData(request) {
  let ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return null;

  if (ip.includes(":")) { // IPv6
      let truncatedIPv6 = truncateIPv6To56(ip); // Truncate to /56
      return { family: 2, subnet: truncatedIPv6, prefix: 56 };
  } else { // IPv4
      let truncatedIPv4 = ip.split(".").slice(0, 3).join(".") + ".0"; // Truncate to /24
      return { family: 1, subnet: truncatedIPv4, prefix: 24 };
  }
}

/**
 * Encodes an IP address and prefix length into an EDNS Client Subnet (ECS) buffer.
 *
 * @param {number} family - The address family (1 for IPv4, 2 for IPv6).
 * @param {string} subnet - The IP address in string format.
 * @param {number} prefixLength - The prefix length of the subnet.
 * @returns {Uint8Array} The ECS buffer containing the encoded IP address and prefix length.
 * @throws {Error} If the IP address is invalid.
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

  // EDNS Client Subnet structure:
  // Option Code (2 bytes) - 8 for ECS
  // Option Length (2 bytes) - Length of the option data (excluding Option Code
  // Address Family (2 bytes) - 1 for IPv4, 2 for IPv6
  // Source Prefix Length (1 byte)
  // Scope Prefix Length (1 byte) - Usually set to 0
  // Address (truncated to prefix length)

  // Create buffer for header + truncated address

  let ecsLength = 8 + addressBytes.length;
  let ecsBuffer = new Uint8Array(ecsLength);

  ecsBuffer.set([
      0x00, 0x08,                                      // Option Code = 8 (ECS)
      (ecsLength - 4) >> 8, (ecsLength - 4) & 0xff,    // Option Length
      (family >> 8) & 0xff, family & 0xff,             // Address Family (1 = IPv4, 2 = IPv6)
      prefixLength, 0x00,                              // Source Prefix Length, Scope Prefix Length (always 0)
      ...addressBytes                                  // Address bytes
  ]);

  return ecsBuffer;
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
* Modifies a raw binary DNS query to include an ECS (EDNS Client Subnet) option
* Does not modify original buffer if it already contains an ECS option
* 
* @param {ArrayBuffer} originalArrayBuffer - Original DNS query in binary form
* @param {Object} ecsData - ECS data { family, subnet, prefix }
* @returns {Uint8Array} Modified DNS query
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

/**
* Handles GET-based DoH queries with /dns-query endpoint
* @param {Request} request
* @returns {Promise<Response>}
*/
async function dns_query_get(request) {
    const params = new URL(request.url).searchParams;
    
    let ecsData = getECSData(request);
    if (ecsData) {
        let origBuffer = decodeBase64Url(params.get("dns"));
        let newBuffer = modifyDNSQuery(origBuffer, ecsData);
        params.set("dns", encodeBase64Url(newBuffer));
    }

    let url = `${URL_UPSTREAM_DNS_QUERY}?${params.toString()}`;
    return fetch(url, { method: "GET", headers: { "accept": APPL_DNS_MSG } });
}

/**
* Handles DNS queries via Google's JSON API with /resolve endpoint
* @param {Request} request
* @returns {Promise<Response>}
*/
async function dns_resolve_googlejson(request) {
    const params = new URL(request.url).searchParams;
    
    if (!params.has("edns_client_subnet")) {
      // Extract Client IP to use for ECS
      let ecsData = getECSData(request);
      if (ecsData) {
          params.set("edns_client_subnet", `${ecsData.subnet}/${ecsData.prefix}`);
      }
    }
    
    let url = `${URL_UPSTREAM_RESOLVE}?${params.toString()}`;
    return fetch(url, { method: "GET", headers: { "accept": APPL_DNS_JSON } });
}

/**
* Handles POST-based DoH queries with /dns-query endpoint
* @param {Request} request
* @returns {Promise<Response>}
*/
async function dns_query_post(request) {
    let body = await request.arrayBuffer(); // Get raw binary DNS request

    let ecsData = getECSData(request);
    if (ecsData) {
        body = modifyDNSQuery(body, ecsData).buffer; // Convert back to ArrayBuffer 
    }

    return fetch(URL_UPSTREAM_DNS_QUERY, {
        method: "POST",
        headers: { "content-type": APPL_DNS_MSG },
        body: body
    });
}

/**
 * Normalizes the headers by converting all header keys to lowercase.
 *
 * @param {Headers} requestHeaders - The original headers from the request.
 * @returns {Headers} - A new Headers object with all keys in lowercase.
 */
function normalizeHeaders(requestHeaders) {
    const headers = new Headers();
    for (const [key, value] of requestHeaders) {
        headers.set(key.toLowerCase(), value);
    }
    return headers;
}

/**
 * Routes the incoming request based on the HTTP method, pathname, headers, and search parameters.
 * Routes to:
 *            /dns-query (POST) with Content-Type: application/dns-message
 *            /resolve   (GET)  with       Accept: application/dns-json
 *            /dns-query (GET)  with       Accept: application/dns-message
 * Returns 404 if the request does not match any of the above routes.
 *
 * @param {string} method - The HTTP method of the request (e.g., 'GET', 'POST').
 * @param {string} pathname - The pathname of the request URL.
 * @param {Headers} headers - The headers of the request.
 * @param {URLSearchParams} searchParams - The search parameters of the request URL.
 * @param {Request} request - The original request object.
 * @returns {Promise<Response>} - A promise that resolves to a Response object.
 */
function routeRequest(method, pathname, headers, searchParams, request) {
    if (       method === 'POST' && pathname === '/dns-query' && headers.get('content-type') === APPL_DNS_MSG) {
        return dns_query_post(request);
    } else if (method === 'GET'  && pathname === '/resolve'   && headers.get('accept') === APPL_DNS_JSON && searchParams.has('name')) {
        return dns_resolve_googlejson(request);
    } else if (method === 'GET'  && pathname === '/dns-query' && headers.get('accept') === APPL_DNS_MSG  && searchParams.has('dns')) {
        return dns_query_get(request);
    } else {
        return new Response(null, { status: 404 });
    }
}

/**
 * Handles incoming HTTP requests and routes them based on the request method, URL path, and headers.
 *
 * @param {Request} request - The incoming HTTP request object.
 * @returns {Promise<Response>} - A promise that resolves to the appropriate HTTP response.
 */
async function handleRequest(request) {
  // Returning a Promise<Response> allows the worker to yield control back to the runtime
  // while waiting for the fetch to complete, reducing the billed wall-time.
  const headers = normalizeHeaders(request.headers);
  const { method, url } = request;
  const { searchParams, pathname } = new URL(url);

  return routeRequest(method, pathname, headers, searchParams, request);
}
