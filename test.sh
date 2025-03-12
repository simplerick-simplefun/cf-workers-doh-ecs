## install q at:
## https://github.com/natesales/q

myDnsDomain="test.domain.com"
testDomain="douyu.com"
testSubnet="1.2.3.0/24"
testReqEncoded="RJ8BAAABAAAAAAAABWRvdXl1A2NvbQAAAgAB"

## GET /resolve JSON
curl --header "accept: application/dns-json" "https://${myDnsDomain}/resolve?name=${testDomain}"
curl --header "accept: application/dns-json" "https://${myDnsDomain}/resolve?name=${testDomain}&edns_client_subnet=${testSubnet}"

## GET /dns-query Base64 Encoded URL
curl --header 'accept: application/dns-message' --verbose 'https://${myDnsDomain}/dns-query?dns=${testReqEncoded}' | hexdump
# q --http-method=GET                          "${testDomain}" @https://${myDnsDomain}/dns-query
# q --http-method=GET --subnet="${testSubnet}" "${testDomain}" @https://${myDnsDomain}/dns-query

## POST /dns-query BODY
echo -n "${testReqEncoded}" | base64 --decode | curl --header 'content-type: application/dns-message' --data-binary @- "https://${myDnsDomain}/dns-query" --output - | hexdump
# q --http-method=POST                          "${testDomain}" @https://${myDnsDomain}/dns-query
# q --http-method=POST --subnet="${testSubnet}" "${testDomain}" @https://${myDnsDomain}/dns-query