# cf-workers-doh

使用 Chatgpt 翻译的 README 中文版

**一个具有 自动 ECS 功能的 DNS-over-HTTPS 代理**

在 Cloudflare Workers 上部署具有自动 ECS（EDNS Client Subnet）功能的 DoH（DNS-over-HTTPS）代理。

带有 ECS 的 DNS DoH 请求会 根据 ECS 中指定的子网 生成 DNS 响应，为域名查找提供准确的、最接近该子网地理位置的解析结果。更多关于ECS，请参阅 [https://developers.google.com/speed/public-dns/docs/ecs](https://developers.google.com/speed/public-dns/docs/ecs?hl=zh-cn)。

ECS 对于 DNS 代理 特别有用，因为通常 DNS 代理 会生成一个地理位置接近 DNS 代理 IP 的 DNS 响应，而不是接近 实际发送 DNS 查询请求（到DNS代理）的 实际客户端的 IP。

**通过自动 ECS 功能，DNS 代理将能够生成地理位置接近实际客户端 IP 的 DNS 响应。**

**警告：** 设计为完全支持 [Google 公共 DNS](https://developers.google.com/speed/public-dns/docs/secure-transports?hl=zh-cn) 作为上游服务。使用其他公共 DNS 作为上游服务时，结果可能会变化。

## 功能：
- DoH 请求发送到上游 DoH 服务时，自动附加 EDNS 客户端子网（ECS）。使用实际终端用户客户端的 IP（即向 DNS 代理发送 DoH 请求的客户端 IP）作为子网的基础。
  - 子网掩码：IPv4 为 /24，IPv6 为 /56，最后几位数会被置为零。
  - 如果代理的 DoH 请求已包含 ECS 字段，则不会添加或更改 ECS 字段。
  - 请注意，并非所有公共 DNS 服务都支持 ECS。Google DoH 支持 ECS，因此默认设置为 Google。请查看 [公共 DNS 服务](https://github.com/curl/curl/wiki/DNS-over-HTTPS) 以了解其他公共 DNS 服务。
- 支持 DoH：
  - [GET /dns-query](https://developers.google.com/speed/public-dns/docs/doh?hl=zh-cn#methods)
  - [POST /dns-query](https://developers.google.com/speed/public-dns/docs/doh?hl=zh-cn#methods)
  - [GET /resolve (Google JSON API)](https://developers.google.com/speed/public-dns/docs/doh/json?hl=zh-cn)

## 安装
- 注册一个免费的 [Cloudflare Workers](https://workers.cloudflare.com/) 账户，创建一个新的 Worker，将脚本替换为 [index.js](/index.js) 的内容，部署 Worker，就完成了。
- 修改 **"URL_UPSTREAM_DNS_QUERY"** **"URL_UPSTREAM_RESOLVE"**，以切换到其他上游 DNS 服务提供商。
- 对于中国大陆用户：你可能需要一个自定义域名来绕过 GFW。Cloudflare Worker 的默认域名在你所在的地区可能会被封锁。

## 限制：
- 由于 DNS 代理部署在 Cloudflare Workers 上（以及可能其他无服务器服务），它只能通过域名访问。在这种部署方式下，无法通过 "https://ip" 访问 DNS 代理。

## 致谢
- **代码基础**：
  - [https://github.com/tina-hello/doh-cf-workers](https://github.com/tina-hello/doh-cf-workers)
  - [https://github.com/GangZhuo/cf-doh](https://github.com/GangZhuo/cf-doh)
- ~~**Chatgpt**~~
  - ~~作为一个愚蠢但有点用的助手~~
