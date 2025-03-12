# cf-workers-doh

[中文版 README ](https://github.com/simplerick-simplefun/cf-workers-doh/blob/main/README-CN.md)

**A DNS-over-HTTPS Proxy with auto ECS feature**

Proxy DoH (DNS-over-HTTPS) with Auto ECS (EDNS Client Subnet) on Cloudflare Workers.

DNS DoH request with ECS produces DNS response that give accurate geo-located responses to the subnet specified in ECS when responding to name lookups. Refer to [https://developers.google.com/speed/public-dns/docs/ecs](https://developers.google.com/speed/public-dns/docs/ecs).

This is especially useful in DNS Proxy, as normally DNS Proxy produce DNS response that is geographically close to IP of the DNS Proxy, not the IP of the actual client sending DNS query/request (to DNS Proxy).

**With auto-ECS feature, DNS Proxy will be able to produce DNS response that is geographically close to IP of the actual client.**

**WARNING:** Designed to be completely compatible with [Google Public DNS](https://developers.google.com/speed/public-dns/docs/secure-transports) as upstream. Outcomes may vary when using other public DNS providers as upstream.

## Features:
- Automatically send EDNS Client Subnet (ECS) with DoH request to upstream DoH service. Uses end-user client's IP (the client IP sending DoH request to the DNS Proxy) as base for the subnet.
  - Subnet: /24 for ipv4 and /56 for ipv6, last digits are zeroed out.
  - Does not add/change ECS field if DoH request already contains ECS field.
  - Note that not all public DNS services suppt DoH with ECS. Google DoH supports ECS and is therefore set as default. Check [Public DNS Services](https://github.com/curl/curl/wiki/DNS-over-HTTPS) to see other public DNS services.
- Supports DoH with:
  - [GET /dns-query](https://developers.google.com/speed/public-dns/docs/doh#methods)
  - [POST /dns-query](https://developers.google.com/speed/public-dns/docs/doh#methods)
  - [GET /resolve (Google JSON API)](https://developers.google.com/speed/public-dns/docs/doh/json)
## Limitations:
- Since the DNS Proxy is deployed on Cloudflare Workers (and possibly other server-less services), it can only be accessed through domain name. Accessing the DNS Proxy with "https://ip" is not possible in this kind of deployment.
## Installation
- Sign up for a free [Cloudflare Workers](https://workers.cloudflare.com/) account, create a new worker, replace the Script with the content of [index.js](/index.js), deploy the worker, and you're done.
- Modify **URL_UPSTREAM_DNS_QUERY** and **URL_UPSTREAM_RESOLVE** to switch to other upstream DNS service providers.
- For Mainland China users: you might need a custom domain to bypass GFW. Cloudflare Worker's default domain name might be banned in your region. 
## Credit
- **Code Base**:
  - [https://github.com/tina-hello/doh-cf-workers](https://github.com/tina-hello/doh-cf-workers)
  - [https://github.com/GangZhuo/cf-doh](https://github.com/GangZhuo/cf-doh)
- ~~**Chatgpt**~~
  - ~~For being a stupid but somewhat useful helper.~~
