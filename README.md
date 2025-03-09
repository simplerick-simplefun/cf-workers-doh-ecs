# cf-workers-doh
Proxy DNS-over-HTTPS (DoH) with EDNS Client Subnet (ECS) on Cloudflare Workers
## Feature:
- Automatically send EDNS Client Subnet (ECS) with DoH request to upstream DoH service. Uses end-user client's IP (the client IP sending DoH request to CF Worker) as base for the subnet.
  - Subnet: /24 for ipv4 and /56 for ipv6
  - Note that not all public DNS services suppt DoH with ECS. Google DoH supports ECS and is therefore set as default. Check [Public DNS Services](https://github.com/curl/curl/wiki/DNS-over-HTTPS) to see other public DNS services.
- Supports DoH with:
  - [GET /dns-query](https://developers.google.com/speed/public-dns/docs/doh#methods)
  - [POST /dns-query](https://developers.google.com/speed/public-dns/docs/doh#methods)
  - [GET /resolve (Google JSON API)](https://developers.google.com/speed/public-dns/docs/doh/json)
## Installation
- Sign up for a free [Cloudflare Workers](https://workers.cloudflare.com/) account, create a new worker, replace the Script with the content of [index.js](/index.js), deploy the worker, and you're done.
- Modify **URL_UPSTREAM_DNS_QUERY** and **URL_UPSTREAM_RESOLVE** to switch to other upstream DNS service providers.
- For Mainland China users: you might need a custom domain to bypass GFW. Cloudflare Worker's default domain name might be banned in your region. 
## Credit
- For code base:
  - [https://github.com/tina-hello/doh-cf-workers](https://github.com/tina-hello/doh-cf-workers)
  - [https://github.com/GangZhuo/cf-doh](https://github.com/GangZhuo/cf-doh)
- **Chatgpt**
  - For completing the code while I had abusolutely no knowledge/experirence in Javascript at all.
