// SPDX-License-Identifier: 0BSD


//// Change your DoH upstream here ////
const URL_UPSTREAM_DNS_QUERY = 'https://dns.google/dns-query';
const URL_UPSTREAM_RESOLVE = 'https://dns.google/resolve';
//// Change your DoH upstream here ////

const contype = 'application/dns-message'
const jstontype = 'application/dns-json'
const path = ''; // default allow all, must start with '/' if specified, eg. "/dns-query"
const r404 = new Response(null, {status: 404});

// developers.cloudflare.com/workers/runtime-apis/fetch-event/#syntax-module-worker
export default {
    async fetch(r, env, ctx) {
        return handleRequest(r);
    },
};




/**
 * Extracts ECS (EDNS Client Subnet) data from client IP
 * @param {Request} request
 * @returns {Object|null} ECS Data { family, subnet, prefix } or null if not applicable
 */
function getECSData(request) {
  let ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return null;

  if (ip.includes(":")) { // IPv6
      let truncatedIPv6 = ip.split(":").slice(0, 3).join(":") + "::"; // Truncate to /56
      return { family: 2, subnet: truncatedIPv6, prefix: 56 };
  } else { // IPv4
      let truncatedIPv4 = ip.split(".").slice(0, 3).join(".") + ".0"; // Truncate to /24
      return { family: 1, subnet: truncatedIPv4, prefix: 24 };
  }
}

/**
* Modifies a raw binary DNS query to include an ECS (EDNS Client Subnet) option
* @param {Buffer} originalBuffer - Original DNS query in binary form
* @param {Object} ecsData - ECS data { family, subnet, prefix }
* @returns {Buffer} Modified DNS query
*/
function modifyDNSQuery(originalArrayBuffer, ecsData) {
    const OPT_TYPE = 41; // EDNS OPT record type
    let originalBuffer = new Uint8Array(originalArrayBuffer); // Convert to Uint8Array
    let offset = 12;
    let qdcount = (originalBuffer[4] << 8) | originalBuffer[5];
    let arcount = (originalBuffer[10] << 8) | originalBuffer[11];

    for (let i = 0; i < qdcount; i++) {
        while (originalBuffer[offset] !== 0) offset++;
        offset += 5;
    }

    let addOffset = offset;
    let hasOPT = false;
    for (let i = 0; i < arcount; i++) {
        let pos = addOffset;
        while (originalBuffer[pos] !== 0) pos++;
        pos++;
        let type = (originalBuffer[pos] << 8) | originalBuffer[pos + 1];
        if (type === OPT_TYPE) {
            hasOPT = true;
            break;
        }
        addOffset = pos + 10 + ((originalBuffer[pos + 8] << 8) | originalBuffer[pos + 9]);
    }

    let ecsBuffer = new Uint8Array(8 + (ecsData.family === 1 ? 4 : 16));
    ecsBuffer.set([0x00, 0x08, 0x00, ecsBuffer.length - 4, ecsData.family, 0, ecsData.prefix, 0], 0);
    ecsBuffer.set(ecsData.subnet.split(".").map(Number), 8);

    let newBuffer;
    if (hasOPT) {
        newBuffer = new Uint8Array(originalBuffer.length + ecsBuffer.length);
        newBuffer.set(originalBuffer.subarray(0, addOffset + 10), 0);
        newBuffer.set(ecsBuffer, addOffset + 10);
        newBuffer.set(originalBuffer.subarray(addOffset + 10), addOffset + 10 + ecsBuffer.length);
    } else {
        let optHeader = new Uint8Array(11);
        optHeader.set([0, OPT_TYPE >> 8, OPT_TYPE & 0xff, 0x10, 0, 0, 0, 0, 0, ecsBuffer.length >> 8, ecsBuffer.length & 0xff]);
        newBuffer = new Uint8Array(originalBuffer.length + optHeader.length + ecsBuffer.length);
        newBuffer.set(originalBuffer, 0);
        newBuffer.set(optHeader, originalBuffer.length);
        newBuffer.set(ecsBuffer, originalBuffer.length + optHeader.length);
        newBuffer[10] = (arcount + 1) >> 8;
        newBuffer[11] = (arcount + 1) & 0xff;
    }

    return newBuffer.buffer; // Convert back to ArrayBuffer
}


/**
* Handles GET-based DoH queries
* @param {Request} request
* @returns {Promise<Response>}
*/
async function dns_query_get(request) {
  const params = new URL(request.url).searchParams;
  if (!params.has("dns")) return new Response("Bad Request", { status: 400 });

  let ecsData = getECSData(request);
  if (ecsData) {
      params.set("edns_client_subnet", `${ecsData.subnet}/${ecsData.prefix}`);
  }

  let url = `${URL_UPSTREAM_DNS_QUERY}?${params.toString()}`;
  return fetch(url, { method: "GET", headers: { "accept": "application/dns-message" } });
}

/**
* Handles POST-based DoH queries
* @param {Request} request
* @returns {Promise<Response>}
*/
async function dns_query_post(request) {
    let body = await request.arrayBuffer(); // Get raw binary DNS request
    let ecsData = getECSData(request);
    if (ecsData) {
        body = modifyDNSQuery(body, ecsData);
    }

    return fetch(URL_UPSTREAM_DNS_QUERY, {
        method: "POST",
        headers: { "content-type": "application/dns-message" },
        body: body
    });
}


/**
* Handles traditional DNS resolution via Google's DoH resolver
* @param {Request} request
* @returns {Promise<Response>}
*/
async function resolve(request) {
    const params = new URL(request.url).searchParams;
    let url = `${URL_UPSTREAM_RESOLVE}?${params.toString()}`;

    // Extract Client IP to use for ECS
    let ecsData = getECSData(request);
    if (ecsData) {
        params.set("edns_client_subnet", `${ecsData.subnet}/${ecsData.prefix}`);
        url = `${URL_UPSTREAM_RESOLVE}?${params.toString()}`;
    }

    let response = await fetch(url, {
        method: "GET",
        headers: request.headers
    });

    // Return the response from Google DoH
    return new Response(response.body, {
        status: response.status,
        headers: response.headers
    });
}




async function handleRequest(request) {
    // when res is a Promise<Response>, it reduces billed wall-time
    // blog.cloudflare.com/workers-optimization-reduces-your-bill
    let res = r404;
    const { method, headers, url } = request
    const {searchParams, pathname} = new URL(url)
    
    //Check path
    if (!pathname.startsWith(path)) {
        return r404;
    }
    if (method == 'GET' && searchParams.has('dns')) {
        res = dns_query_get(request);
    } else if (method === 'POST' && headers.get('content-type') === contype) {
        res = dns_query_post(request);
    } else if (method === 'GET' && headers.get('Accept') === jstontype) {
        res = resolve(request);
    } else {
        res = new Response('Hello worker!');
    }
    return res;
}
