#!/bin/sh
# 从注册表生成原子替换的规则；登记、管理、同步与防火墙重载共用同一把锁。
. "${PORTAL_LIB:-/usr/libexec/portal/devices.sh}"
exec 9>"$PORTAL_LOCK"
portal_flock 9 || exit 1
portal_load || exit 1
[ "$(portal_enabled)" = 1 ] || exit 0
[ ! -f "$PORTAL_RUN/stopped" ] || exit 0
portal_valid_config || exit 1
if [ "$1" = --if-missing ] && nft list table inet portal >/dev/null 2>&1 && nft list table bridge portal_mark >/dev/null 2>&1; then exit 0; fi
mkdir -p "$PORTAL_RUN"
tmp="$(mktemp "$PORTAL_RUN/rules.XXXXXX")" || exit 1
trap 'rm -f "$tmp"' EXIT HUP INT TERM
emit_set() {
	local name="$1" values="$2"
	printf 'set %s { type ether_addr; ' "$name"
	[ -z "$values" ] || printf 'elements = { %s }; ' "$values"
	printf '}\n'
}
auth= block= limited=
for sec in $PORTAL_DEVICES; do
	config_get mac "$sec" mac
	mac="$(portal_norm_mac "$mac")" || exit 1
	state="$(portal_device_state "$mac")"
	config_get eg "$sec" egress normal
	case "$state" in
		blocked) block="${block:+$block, }$mac";;
		registered|trusted)
			if [ "$eg" = wifi-only ]; then limited="${limited:+$limited, }$mac"
			else auth="${auth:+$auth, }$mac"; fi;;
	esac
done
ifaces=
for iface in $PORTAL_WIFI_IFACES; do ifaces="${ifaces:+$ifaces, }\"$iface\""; done
{
	# destroy 需要 nftables >= 1.0.8；不先删除现场表，保证提交原子性。
	cat <<RULES
destroy table bridge portal_mark
destroy table inet portal
table bridge portal_mark {
$(emit_set auth_bmac "$auth")
$(emit_set block_bmac "$block")
 chain mark_wifi {
  type filter hook prerouting priority -300; policy accept;
  iifname { $ifaces } ether saddr @block_bmac counter drop
  iifname { $ifaces } ether saddr @auth_bmac return
  iifname { $ifaces } meta mark set meta mark | 0x40000000
 }
 chain isolate_wifi {
  type filter hook forward priority -300; policy accept;
  meta mark & 0x40000000 != 0 counter drop
 }
}
table inet portal {
$(emit_set auth_mac "$auth")
$(emit_set block_mac "$block")
$(emit_set limited_mac "$limited")
 set ready4 { type ether_addr . ipv4_addr; flags timeout; timeout ${PORTAL_READY_TTL}s; }
 set ready6 { type ether_addr . ipv6_addr; flags timeout; timeout ${PORTAL_READY_TTL}s; }
 set lan_deny { type ipv4_addr; flags interval; elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4 }; }
 chain pnat {
  type nat hook prerouting priority -160; policy accept;
  meta mark & 0x40000000 == 0 return
  ether saddr @block_mac return
  ether saddr . ip saddr @ready4 return
  ether saddr . ip6 saddr @ready6 return
RULES
	if [ "$PORTAL_MODE" = alias ]; then
		echo '  meta l4proto { tcp, udp } th dport 53 redirect to :5353'
	else
		echo '  meta l4proto { tcp, udp } th dport 53 redirect to :53'
		echo '  meta l4proto tcp tcp dport 80 redirect to :8081'
	fi
	cat <<RULES
 }
 chain pfilter {
  type filter hook prerouting priority -155; policy accept;
  meta mark & 0x40000000 == 0 return
  ether saddr @block_mac drop
  ip daddr { 255.255.255.255, $PORTAL_LISTEN_IP } udp sport 68 udp dport 67 accept
  ip6 daddr ff02::1:2 udp sport 546 udp dport 547 accept
  fib daddr type local udp sport 546 udp dport 547 accept
  meta l4proto ipv6-icmp ip6 hoplimit 255 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } accept
  fib daddr type local meta l4proto { tcp, udp } th dport 53 accept
  ip daddr $PORTAL_LISTEN_IP tcp dport 8081 accept
  meta nfproto ipv6 fib daddr type local tcp dport 8081 accept
RULES
	if [ "$PORTAL_MODE" = alias ]; then
		printf '  ip daddr %s tcp dport 80 accept\n' "$PORTAL_ALIAS_IP"
		echo '  fib daddr type local meta l4proto { tcp, udp } th dport 5353 accept'
	fi
	cat <<'RULES'
  fib daddr type local drop
  ether saddr @limited_mac ether saddr . ip saddr @ready4 meta l4proto { tcp, udp } meta mark set meta mark & 0xbfffffff return
  ether saddr @limited_mac ether saddr . ip6 saddr @ready6 meta l4proto { tcp, udp } meta mark set meta mark & 0xbfffffff return
  ether saddr @limited_mac drop
  ip daddr @lan_deny drop
  ether saddr . ip saddr @ready4 meta l4proto { tcp, udp } meta mark set meta mark & 0xbfffffff return
  drop
 }
}
RULES
} > "$tmp"
nft -c -f "$tmp" || exit 1
if [ "$PORTAL_DRYRUN" = 1 ]; then cat "$tmp"; exit 0; fi
nft -f "$tmp" || exit 1
rm -f "$PORTAL_RUN/ready-until"
portal_read_offloading
if [ "$(portal_offload_policy)" = allow ] && portal_offloading_configured; then
	logger -t identity-portal '已按用户策略允许流量卸载：卸载中的连接可能绕过拉黑、出口切换和许可到期检查'
fi
logger -t identity-portal '门户规则已原子替换，受限设备等待分流确认'
