#!/bin/sh
# 门户公共库。注册表按请求加载一次；写操作由调用者持有同一把锁。
# 测试可覆盖路径变量，生产环境使用 OpenWrt 原生路径。
. "${PORTAL_FUNCTIONS:-/lib/functions.sh}"
. "${PORTAL_JSHN:-/usr/share/libubox/jshn.sh}"
PORTAL_VERSION=0.1.4
PORTAL_CONFIG_DIR="${PORTAL_CONFIG_DIR:-/etc/config}"
PORTAL_RUN="${PORTAL_RUN:-/var/run/identity-portal}"
PORTAL_LOCK="${PORTAL_LOCK:-/var/lock/portal.lock}"
PORTAL_WWW_DIR="${PORTAL_WWW_DIR:-/tmp/identity-portal-www}"
PORTAL_TMPL="${PORTAL_TMPL:-/usr/share/portal/tmpl/index.html.tmpl}"
PORTAL_DHCP_LEASES="${PORTAL_DHCP_LEASES:-/tmp/dhcp.leases}"
PORTAL_OUI_TSV="${PORTAL_OUI_TSV:-/etc/portal/oui.tsv}"
PORTAL_UNAUTH_FILE="$PORTAL_RUN/unauth-src.yaml"
PORTAL_AUDIT_LOG="$PORTAL_RUN/audit.log"
PORTAL_BAN_TIME_MS=1800000
PORTAL_SYS_NET="${PORTAL_SYS_NET:-/sys/class/net}"
PORTAL_HISTORY_FILE="${PORTAL_HISTORY_FILE:-/etc/portal/history.tsv}"
umask 077

portal_load() {
	local data s typ old m cache_var existing
	# 只执行 UCI 自己导出的 shell 语法，绝不执行原始配置或 HTTP 内容。
	data="$(uci -c "$PORTAL_CONFIG_DIR" -t "${PORTAL_DELTA:-/tmp/.uci}" -s -n export portal)" || return 1
	# 清除上次读取的字段，防止同一进程中删除选项后仍读到旧值。
	for old in ${PORTAL_CONFIG_VARS:-}; do unset "$old"; done
	CONFIG_SECTIONS= CONFIG_LIST_STATE= CONFIG_NUM_SECTIONS=0
	eval "$data"
	PORTAL_CONFIG_VARS="$(set | sed -n 's/^\(CONFIG_[A-Za-z0-9_]*\)=.*/\1/p')"
	PORTAL_DEVICES= PORTAL_IDENTITIES=
	for s in $CONFIG_SECTIONS; do
		config_get typ "$s" TYPE
		case "$typ" in device) append PORTAL_DEVICES "$s";; identity) append PORTAL_IDENTITIES "$s";; esac
	done
	# 每次加载建立 MAC→节名索引，避免每台设备反复启动 tr 扫描整个注册表。
	for old in ${PORTAL_MAC_VARS:-}; do unset "$old"; done
	PORTAL_MAC_VARS=
	for s in $PORTAL_DEVICES; do
		config_get m "$s" mac
		m="$(portal_norm_mac "$m")" || continue
		cache_var="PORTAL_SEC_${m//:/_}"
		_get_var existing "$cache_var"
		[ -z "$existing" ] || continue
		_set_var "$cache_var" "$s"
		append PORTAL_MAC_VARS "$cache_var"
	done
	config_get PORTAL_WIFI_IFACES global wifi_ifaces
	config_get PORTAL_LAN_DEV global lan_device br-lan
	config_get PORTAL_MODE global capture_mode redirect
	config_get PORTAL_ALIAS_IP global alias_ipv4
	config_get PORTAL_LISTEN_IP global listen_ipv4
	config_get PORTAL_INTERVAL global sync_interval 15
	case "$PORTAL_INTERVAL" in ''|*[!0-9]*) PORTAL_INTERVAL=15;; esac
	[ "${#PORTAL_INTERVAL}" -le 3 ] && [ "$PORTAL_INTERVAL" -ge 5 ] && [ "$PORTAL_INTERVAL" -le 120 ] || PORTAL_INTERVAL=15
	PORTAL_READY_TTL=$((PORTAL_INTERVAL * 2 + 10))
}
portal_get() { config_get "$1" "$2"; }
portal_enabled() { local v; config_get v global enabled 0; printf '%s' "$v"; }
portal_unauth_policy() { local v; config_get v global unauth_policy drop; printf '%s' "$v"; }
portal_offload_policy() { local v; config_get v global offload_policy allow; printf '%s' "$v"; }
portal_read_offloading() {
	PORTAL_FLOW_OFFLOADING="$(uci -q get firewall.@defaults[0].flow_offloading)"
	PORTAL_FLOW_OFFLOADING_HW="$(uci -q get firewall.@defaults[0].flow_offloading_hw)"
	case "$PORTAL_FLOW_OFFLOADING" in 1|on|true|yes) PORTAL_FLOW_OFFLOADING=1;; *) PORTAL_FLOW_OFFLOADING=0;; esac
	case "$PORTAL_FLOW_OFFLOADING_HW" in 1|on|true|yes) PORTAL_FLOW_OFFLOADING_HW=1;; *) PORTAL_FLOW_OFFLOADING_HW=0;; esac
}
portal_offloading_configured() { [ "$PORTAL_FLOW_OFFLOADING" = 1 ] || [ "$PORTAL_FLOW_OFFLOADING_HW" = 1 ]; }
portal_check_offloading() {
	case "${1:-$(portal_offload_policy)}" in
		allow) return 0;;
		require-off)
			portal_read_offloading
			portal_offloading_configured || return 0
			echo '当前选择要求关闭卸载，请先关闭 firewall4 软件和硬件流量卸载，或选择允许卸载' >&2
			return 1;;
		*) echo '未知流量卸载兼容策略' >&2; return 1;;
	esac
}
portal_device_sections() { [ -z "$PORTAL_DEVICES" ] || printf '%s\n' $PORTAL_DEVICES; }
portal_identity_sections() { [ -z "$PORTAL_IDENTITIES" ] || printf '%s\n' $PORTAL_IDENTITIES; }
portal_dev_sec() { printf 'dev_%s' "$(printf '%s' "$1" | tr -d ':' | tr A-F a-f)"; }
portal_norm_mac() {
	local m
	m="$(printf '%s' "$1" | tr a-f A-F)"
	printf '%s' "$m" | grep -Eq '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$' || return 1
	case "$m" in ?[13579BDF]:*|00:00:00:00:00:00) return 1;; esac
	printf '%s' "$m"
}
portal_find_device() {
	local sec key
	case "$1" in ''|*[!0-9A-F:]*) return 1;; esac
	key="PORTAL_SEC_${1//:/_}"
	_get_var sec "$key"
	[ -n "$sec" ] || return 1
	printf '%s' "$sec"
}
portal_identity_exists() {
	local t
	case "$1" in id_????????) ;; *) return 1;; esac
	printf '%s' "$1" | grep -Eq '^id_[0-9a-f]{8}$' || return 1
	config_get t "$1" TYPE
	[ "$t" = identity ]
}
portal_device_state() {
	local s id trusted policy
	s="$(portal_find_device "$1")" || { echo unregistered; return; }
	config_get policy "$s" policy allow
	[ "$policy" = block ] && { echo blocked; return; }
	config_get id "$s" identity
	config_get trusted "$s" trusted 0
	if portal_identity_exists "$id"; then echo registered
	elif [ "$trusted" = 1 ]; then echo trusted
	else echo unregistered; fi
}
portal_registry() {
	local s m
	for s in $PORTAL_DEVICES; do
		config_get m "$s" mac
		m="$(portal_norm_mac "$m")" || continue
		printf '%s\t%s\n' "$m" "$(portal_device_state "$m")"
	done
}
portal_is_laa() { case "$1" in ?[26AE]:*) return 0;; esac; return 1; }
portal_now_iso() { date '+%Y-%m-%dT%H:%M:%S%z'; }
portal_audit() {
	mkdir -p "$PORTAL_RUN"
	# 操作审计最多两份，每份约 128 KiB；不扫描系统无线日志。
	[ "$(wc -c < "$PORTAL_AUDIT_LOG" 2>/dev/null || echo 0)" -lt 131072 ] || mv -f "$PORTAL_AUDIT_LOG" "$PORTAL_AUDIT_LOG.1"
	printf '%s\t%s\t%s\n' "$(portal_now_iso)" "$1" "$2" >> "$PORTAL_AUDIT_LOG"
	chmod 600 "$PORTAL_AUDIT_LOG"
	logger -t identity-portal "$1 $2"
}
portal_flock() {
	local fd="$1" limit="${2:-10}" n=0
	while [ "$n" -lt "$limit" ]; do
		flock -xn "$fd" && return 0
		sleep 1; n=$((n+1))
	done
	return 1
}
portal_flock_unlock() { flock -u "$1"; }
portal_new_id() {
	local n=0 v t
	while [ "$n" -lt 8 ]; do
		v="$(head -c 8 /proc/sys/kernel/random/uuid)"
		case "$v" in *[!0-9a-f]*|'') return 1;; esac
		[ "${#v}" = 8 ] || return 1
		config_get t "id_$v" TYPE
		[ -z "$t" ] && { printf 'id_%s' "$v"; return; }
		n=$((n+1))
	done
	return 1
}
# 一次 hexdump + awk 校验完整 UTF-8；不依赖精简固件可能缺少的 od。
portal_valid_utf8() {
	[ "${#1}" -le $(($2 * 4)) ] || return 1
	printf '%s' "$1" | hexdump -v -e '1/1 "%u "' | LC_ALL=C awk -v max="$2" -v name="$3" '
	{for(i=1;i<=NF;i++) a[++n]=$i}
	END {
	 for(i=1;i<=n;){ b=a[i++]; cp=b; k=0; low=0
	  if(b<32 || b==127) exit 1
	  if(b>=194 && b<=223){k=1;cp=b-192;low=128}
	  else if(b>=224 && b<=239){k=2;cp=b-224;low=2048}
	  else if(b>=240 && b<=244){k=3;cp=b-240;low=65536}
	  else if(b>=128) exit 1
	  while(k--){if(i>n || a[i]<128 || a[i]>191) exit 1; cp=cp*64+a[i++]-128}
	  if(cp<low || cp>1114111 || (cp>=55296 && cp<=57343) || (cp>=128 && cp<=159)) exit 1
	  if(name && !((cp>=48&&cp<=57)||(cp>=65&&cp<=90)||(cp>=97&&cp<=122)||(cp>=19968&&cp<=40959))) exit 1
	  count++
	 }
	 if(count<1 || count>max) exit 1
	}'
}
portal_valid_name() { portal_valid_utf8 "$1" 32 1; }
portal_valid_text() { portal_valid_utf8 "$1" "$2" 0; }
portal_valid_ip4() {
	printf '%s\n' "$1" | LC_ALL=C awk -F. 'NF!=4{exit 1}{for(i=1;i<=4;i++)if($i!~/^[0-9]+$/||length($i)>3||$i>255||($i~/^0/&&length($i)>1))exit 1}'
}
portal_valid_config() {
	local i
	[ -n "$PORTAL_WIFI_IFACES" ] || { echo '请先选择受控无线接口' >&2; return 1; }
	for i in $PORTAL_WIFI_IFACES "$PORTAL_LAN_DEV"; do
		case "$i" in ''|*[!A-Za-z0-9_.:-]*) return 1;; esac
		[ "${#i}" -le 15 ] || return 1
	done
	[ -n "$PORTAL_LISTEN_IP" ] && portal_valid_ip4 "$PORTAL_LISTEN_IP" || { echo '请配置门户所在接口的 IPv4 地址' >&2; return 1; }
	case "$PORTAL_MODE" in redirect) ;; alias) portal_valid_ip4 "$PORTAL_ALIAS_IP" || return 1;; *) return 1;; esac
	case "$(portal_unauth_policy)" in drop|wifi-only) ;; *) return 1;; esac
	# 用户选择兼容策略，门户不替用户修改全机的卸载开关。
	portal_check_offloading
}
# 每次请求只抓一次无线、邻居、租约；后续查询仅访问本地快照。
portal_snapshot() {
	local iface raw keys k m sig dur t assoc port
	[ -n "$PORTAL_SNAPSHOT" ] && return 0
	PORTAL_SNAPSHOT="$(mktemp -d /tmp/portal-read.XXXXXX)" || return 1
	: > "$PORTAL_SNAPSHOT/wifi-time"; : > "$PORTAL_SNAPSHOT/wifi"; : > "$PORTAL_SNAPSHOT/wifi-failed"; : > "$PORTAL_SNAPSHOT/wifi-ports"; : > "$PORTAL_SNAPSHOT/fdb"
	for iface in $PORTAL_WIFI_IFACES; do
		iw dev "$iface" station dump 2>/dev/null | awk '/^Station /{m=toupper($2)} /connected time:/{print m "\t" $3}' >> "$PORTAL_SNAPSHOT/wifi-time"
		port="$(cat "$PORTAL_SYS_NET/$PORTAL_LAN_DEV/brif/$iface/port_no" 2>/dev/null)"
		[ -z "$port" ] || printf "%s\n" "$((port))" >> "$PORTAL_SNAPSHOT/wifi-ports"
		raw="$(ubus call "hostapd.$iface" get_clients 2>/dev/null)" || { echo "$iface" >> "$PORTAL_SNAPSHOT/wifi-failed"; continue; }
		json_load "$raw" || continue
		json_select clients || continue
		json_get_keys keys
		for k in $keys; do
			json_select "$k" || continue
			json_get_var assoc assoc
			[ "$assoc" != 0 ] || { json_select ..; continue; }
			json_get_var m mac
			[ -n "$m" ] || m="$(printf '%s' "$k" | tr _ :)"
			m="$(portal_norm_mac "$m")" || { json_select ..; continue; }
			json_get_var sig signal; json_get_var dur connected_time
			case "$sig" in ''|*[!0-9-]*) sig=null;; esac
			case "$dur" in ''|*[!0-9]*) dur=null;; esac
			printf '%s\t%s\t%s\t%s\n' "$m" "$iface" "${sig:-null}" "${dur:-null}" >> "$PORTAL_SNAPSHOT/wifi"
			json_select ..
		done
	done
	ip -4 neigh show dev "$PORTAL_LAN_DEV" > "$PORTAL_SNAPSHOT/neigh4" 2>/dev/null
	ip -6 neigh show dev "$PORTAL_LAN_DEV" > "$PORTAL_SNAPSHOT/neigh6" 2>/dev/null
	cp "$PORTAL_DHCP_LEASES" "$PORTAL_SNAPSHOT/leases" 2>/dev/null || : > "$PORTAL_SNAPSHOT/leases"
	# 转发表只作为近期有线活动证据，不用租约或 STALE 邻居判断在线。
	brctl showmacs "$PORTAL_LAN_DEV" > "$PORTAL_SNAPSHOT/fdb" 2>/dev/null || :
	portal_history_snapshot
	json_cleanup
}
portal_snapshot_cleanup() { [ -z "$PORTAL_SNAPSHOT" ] || rm -rf "$PORTAL_SNAPSHOT"; PORTAL_SNAPSHOT=; }
portal_wifi_macs() { awk '!seen[$1]++{print $1}' "$PORTAL_SNAPSHOT/wifi"; }
portal_wifi_attr() {
 local v
 v="$(awk -v m="$1" -v a="$2" '$1==m{print (a=="signal"?$3:$4);exit}' "$PORTAL_SNAPSHOT/wifi")"
 if [ "$2" = connected_time ] && { [ -z "$v" ] || [ "$v" = null ]; }; then
  awk -v m="$1" '$1==m{print $2;exit}' "$PORTAL_SNAPSHOT/wifi-time"
 else printf '%s' "$v"; fi
}
portal_pool_macs() {
	local m
	for m in $( { portal_wifi_macs; cut -f1 "$PORTAL_SNAPSHOT/history"; portal_registry | cut -f1; } | sort -u); do
		[ "$(portal_device_state "$m")" = unregistered ] && echo "$m"
	done
}
portal_ips_of_mac() {
	local now
	now="$(date +%s)"
	awk -v m="$1" -v now="$now" 'FILENAME~/leases$/{if(toupper($2)==m&&($1==0||$1>now))print $3;next}
	 /FAILED|INCOMPLETE/{next}{for(i=1;i<NF;i++)if($i=="lladdr"&&toupper($(i+1))==m)print $1}' \
		"$PORTAL_SNAPSHOT/leases" "$PORTAL_SNAPSHOT/neigh4" "$PORTAL_SNAPSHOT/neigh6" | sort -u
}
portal_ip4_of_mac() {
	# 显示优先租约和近期邻居；连接清理仍使用完整地址集合。
	awk -v m="$1" -v now="$(date +%s)" '
	function take(ip,r){if(ip!~/^169\.254\./ && r>rank){best=ip;rank=r}}
	FILENAME~/leases$/{if(toupper($2)==m&&($1==0||$1>now))take($3,4);next}
	/FAILED|INCOMPLETE/{next}{for(i=1;i<NF;i++)if($i=="lladdr"&&toupper($(i+1))==m)take($1,($NF=="REACHABLE"?3:1))}
	END{if(best!="")print best}' "$PORTAL_SNAPSHOT/leases" "$PORTAL_SNAPSHOT/neigh4"
}
portal_ip6s_of_mac() { portal_ips_of_mac "$1" | awk 'index($0,":")&&$0!~/^[fF][eE][89aAbB][0-9a-fA-F]:/{print}'; }
portal_hostname_of_mac() { awk -v m="$1" 'toupper($2)==m&&$4!="*"{print $4;exit}' "$PORTAL_SNAPSHOT/leases"; }
portal_oui_vendor() { portal_is_laa "$1" && return; awk -F '\t' -v p="${1%:*:*:*}" '$1==p{print $2;exit}' "$PORTAL_OUI_TSV"; }
portal_dev_online() {
	grep -qF "$1" "$PORTAL_SNAPSHOT/wifi" && { echo wifi; return; }
	awk -v m="$1" 'FILENAME~/wifi-ports$/{wifi[$1]=1;next} toupper($2)==m&&$3=="no"&&$4+0<=30&&!wifi[$1]{found=1} END{exit !found}' "$PORTAL_SNAPSHOT/wifi-ports" "$PORTAL_SNAPSHOT/fdb" && { echo lan; return; }
	# AP 读取失败或只有近期三层证据时，不能推断设备是有线。
	[ ! -s "$PORTAL_SNAPSHOT/wifi-failed" ] || { echo unknown; return; }
	awk -v m="$1" '$NF=="REACHABLE"{for(i=1;i<NF;i++)if($i=="lladdr"&&toupper($(i+1))==m)found=1}END{exit !found}' "$PORTAL_SNAPSHOT/neigh4" "$PORTAL_SNAPSHOT/neigh6" && echo unknown
}
portal_mac_remote() {
	local addr="$1" m file
	case "$addr" in *:*) case "$addr" in *[!0-9a-fA-F:]*) return 1;; esac; file=neigh6;;
		*) portal_valid_ip4 "$addr" || return 1; file=neigh4;; esac
	# 使用当前邻居表；不以历史 DHCP 租约充当身份凭据。
	m="$(awk -v a="$addr" 'tolower($1)==tolower(a)&&!/FAILED|INCOMPLETE/{for(i=1;i<NF;i++)if($i=="lladdr"){print $(i+1);exit}}' "$PORTAL_SNAPSHOT/$file")"
	portal_norm_mac "$m"
}
portal_ct_flush_mac() {
	local ip family
	for ip in $(portal_ips_of_mac "$1"); do
		case "$ip" in *:*) family=ipv6;; *) family=ipv4;; esac
		conntrack -D -f "$family" -s "$ip" >/dev/null 2>&1
		conntrack -D -f "$family" -d "$ip" >/dev/null 2>&1
	done
	return 0
}
portal_ext_needed() {
	local s e
	[ "$(portal_enabled)" = 1 ] || return 1
	[ ! -f "$PORTAL_RUN/stopped" ] || return 1
	[ "$(portal_unauth_policy)" = wifi-only ] && return 0
	for s in $PORTAL_DEVICES; do config_get e "$s" egress; [ "$e" = wifi-only ] && return 0; done
	return 1
}
# 仅访问明确配置的本机控制器。密钥从 stdin 配置传递，避免进入进程参数。
portal_api() {
	local method="$1" path="$2" api secret
	config_get api global mihomo_api
	config_get secret global mihomo_secret
	case "$api" in http://127.0.0.1:[0-9]*|http://localhost:[0-9]*) ;; *) return 1;; esac
	printf '%s' "$api" | grep -Eq '^http://(127\.0\.0\.1|localhost):[0-9]{1,5}$' || return 1
	case "$secret" in *[!A-Za-z0-9_.~-]*) return 1;; esac
	{
		[ -z "$secret" ] || printf 'header = "Authorization: Bearer %s"\n' "$secret"
	} | curl --config - --noproxy '*' --silent --show-error --fail --connect-timeout 1 --max-time 3 -X "$method" "$api$path"
}
portal_verify_provider() {
	local raw count expected target type payload proxy mode
	config_get target global mihomo_target
	[ -n "$target" ] || { PORTAL_EXT_ERROR=target-missing; return 1; }
	raw="$(portal_api GET /configs)" || { PORTAL_EXT_ERROR=api-failed; return 1; }
	mode="$(printf '%s' "$raw" | jsonfilter -e '@.mode')"
	[ "$mode" = rule ] || { PORTAL_EXT_ERROR=mode-invalid; return 1; }
	raw="$(portal_api GET /providers/rules)" || { PORTAL_EXT_ERROR=provider-missing; return 1; }
	[ "$(printf '%s' "$raw" | jsonfilter -e '@.providers["unauth-src"].vehicleType')" = File ] || { PORTAL_EXT_ERROR=provider-invalid; return 1; }
	[ "$(printf '%s' "$raw" | jsonfilter -e '@.providers["unauth-src"].behavior')" = Classical ] || { PORTAL_EXT_ERROR=provider-invalid; return 1; }
	count="$(printf '%s' "$raw" | jsonfilter -e '@.providers["unauth-src"].ruleCount')"
	expected="$(grep -c SRC-IP-CIDR "$PORTAL_UNAUTH_FILE")"
	[ "$count" = "$expected" ] || { PORTAL_EXT_ERROR=provider-count; return 1; }
	raw="$(portal_api GET /rules)" || { PORTAL_EXT_ERROR=rules-failed; return 1; }
	type="$(printf '%s' "$raw" | jsonfilter -e '@.rules[0].type')"
	payload="$(printf '%s' "$raw" | jsonfilter -e '@.rules[0].payload')"
	proxy="$(printf '%s' "$raw" | jsonfilter -e '@.rules[0].proxy')"
	[ "$type" = RuleSet ] && [ "$payload" = unauth-src ] && [ "$proxy" = "$target" ] || { PORTAL_EXT_ERROR=rule-order-target; return 1; }
}
portal_mihomo_kill_mac() {
	local raw item ip id ips rc=0 file deadline
	ips="$(portal_ips_of_mac "$1")"
	[ -n "$ips" ] || return 0
	raw="$(portal_api GET /connections)" || return 1
	# 每个连接对象独立取 id 与 sourceIP，避免缺失字段导致两个数组错位。
	deadline=$(( $(date +%s) + 5 ))
	file="$(mktemp /tmp/portal-connections.XXXXXX)" || return 1
	printf '%s' "$raw" | jsonfilter -e '@.connections[*]' > "$file"
	while IFS= read -r item; do
		[ "$(date +%s)" -le "$deadline" ] || { rc=1; break; }
		ip="$(printf '%s' "$item" | jsonfilter -e '@.metadata.sourceIP')"
		printf '%s\n' "$ips" | grep -qxF "$ip" || continue
		id="$(printf '%s' "$item" | jsonfilter -e '@.id')"
		case "$id" in ''|*[!A-Za-z0-9-]*) continue;; esac
		portal_api DELETE "/connections/$id" >/dev/null || rc=1
	done < "$file"
	rm -f "$file"
	return "$rc"
}
portal_ext_active() {
	local deadline now
	read -r deadline 2>/dev/null < "$PORTAL_RUN/ready-until" || return 1
	case "$deadline" in ''|*[!0-9]*) return 1;; esac
	now="$(date +%s)"
	[ "$deadline" -gt "$now" ]
}
portal_safepaths_ok() { portal_ext_active; }

# 观察历史独立于准入注册表；查询只读，后台观察器负责写入。
. "${PORTAL_HISTORY_LIB:-/usr/libexec/portal/history.sh}"

portal_ext_message() {
 case "$1" in
 idle) echo '未要求指定出口';; ready) echo '指定出口同步已确认';;
 target-missing) echo '未配置 Mihomo 目标策略名';; api-failed) echo '控制器不可访问或鉴权失败';;
 provider-update) echo '规则文件更新失败：检查文件路径与 SAFE_PATHS';;
 provider-missing) echo '控制器未加载门户规则集合';; provider-invalid) echo '规则集合类型必须为 file/classical';;
 provider-count) echo '控制器规则数与生成文件不同，检查读取路径';; mode-invalid) echo 'Mihomo 必须处于规则模式';;
 rule-order-target) echo '门户规则必须位于首条并指向配置的目标';; rules-failed) echo '无法查询分流规则';;
 nft-failed) echo '内核访问许可集合更新失败';; expired) echo '同步许可已过期，检查同步进程';;
 *) echo '等待下一轮同步确认';;
 esac
}
