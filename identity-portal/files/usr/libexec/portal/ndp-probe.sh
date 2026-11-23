#!/bin/sh
# 有界补采当前IPv6设备地址；运行状态仅在临时目录，不能代替在线或授权判断。
PORTAL_NDP_STATE="${PORTAL_NDP_STATE:-$PORTAL_RUN/ndp-probe}"
PORTAL_NDP_DELAY="${PORTAL_NDP_DELAY:-300}"
PORTAL_NDP_RETRY="${PORTAL_NDP_RETRY:-900}"
PORTAL_NDP_MAX="${PORTAL_NDP_MAX:-3}"
PORTAL_NDP_BATCH="${PORTAL_NDP_BATCH:-8}"
PORTAL_NDP_LIMIT="${PORTAL_NDP_LIMIT:-256}"
PORTAL_NDP_STALE="${PORTAL_NDP_STALE:-600}"
# 测试可重定位命令/内核文件，现场沿用已有工具，不新增服务。
PORTAL_NDP_IP="${PORTAL_NDP_IP:-/sbin/ip}"
PORTAL_NDP_CONNTRACK="${PORTAL_NDP_CONNTRACK:-/proc/net/nf_conntrack}"

portal_ndp_candidates() {
	local local6
	local6="$PORTAL_RUN/ndp-local.$$"
	"$PORTAL_NDP_IP" -6 addr show 2>/dev/null | awk '$1=="inet6"{split($2,a,"/");print a[1]}' > "$local6"
	# 复用门户的IPv6规范化函数；当前relay网络与上联共用/64。
	awk -f "${PORTAL_IPV6_AWK:-/usr/libexec/portal/ipv6.awk}" -f - "$local6" "$PORTAL_NDP_CONNTRACK" <<'AWK' | sort -u
		FILENAME==ARGV[1] {
			k=normalize($0)
			if(k=="")next
			local[k]=1
			if(k!~/^(fe[89ab]|ff|f[cd]|0000)/)lan[substr(k,1,19)]=1
			next
		}
		$1=="ipv6" {
			if($6=="TIME_WAIT"||$6=="CLOSE_WAIT"||$6=="LAST_ACK"||$6=="FIN_WAIT")next
			src="";dst="";mark="0"
			for(i=1;i<=NF;i++){
				if($i~/^src=/ && src=="")src=substr($i,5)
				else if($i~/^dst=/ && dst=="")dst=substr($i,5)
				else if($i~/^mark=/)mark=substr($i,6)
			}
			src=normalize(src);dst=normalize(dst)
			if(src==""||dst==""||mark!="0"||local[src])next
			if(src~/^(fe[89ab]|ff|f[cd]|0000)/||dst~/^(ff|f[cd]|0000)/)next
			if(!(substr(src,1,19) in lan))next
			print src
		}
AWK
	rm -f "$local6"
}

# 空候选仍保留尚未过期的原退避状态；所有地址使用同一种规范格式。
portal_ndp_plan() {
	local now cand state out probe
	now="$(date +%s)"
	cand="$PORTAL_RUN/ndp-cand.$$"
	state="$PORTAL_NDP_STATE"
	out="$PORTAL_RUN/ndp-state.$$"
	probe="$PORTAL_RUN/ndp-probe.$$"
	portal_ndp_candidates > "$cand" 2>/dev/null || : > "$cand"
	[ -f "$state" ] || : > "$state"
	: > "$out"; : > "$probe"
	awk -v now="$now" -v delay="$PORTAL_NDP_DELAY" -v retry="$PORTAL_NDP_RETRY" \
		-v maxa="$PORTAL_NDP_MAX" -v batch="$PORTAL_NDP_BATCH" \
		-v stale="$PORTAL_NDP_STALE" -v out="$out" -v probe="$probe" \
		-f "${PORTAL_IPV6_AWK:-/usr/libexec/portal/ipv6.awk}" -f - "$cand" "$state" <<'AWK'
		FILENAME==ARGV[1] { a=normalize($1);if(a!="")cand[a]=1;next }
		{
			addr=normalize($1);if(addr==""||NF!=5)next
			fs=$2;ls=$3;at=$4;lp=$5
			if(addr in cand){
				seen[addr]=1;ls=now
				if(now-fs>=delay && at<maxa && now-lp>=retry)want[addr]=1
			}else if(now-ls>stale){next}
			print addr,fs,ls,at,lp > out
		}
		END{
			for(a in cand)if(!seen[a])print a,now,now,0,0 > out
			n=0
			for(a in want){if(n++>=batch)break;print a > probe}
		}
AWK
	if [ "$(wc -l < "$out")" -gt "$PORTAL_NDP_LIMIT" ]; then
		sort -k3,3nr "$out" | head -n "$PORTAL_NDP_LIMIT" > "$out.trim" && mv "$out.trim" "$out"
	fi
	mv "$out" "$state"
	rm -f "$cand"
	if [ -s "$probe" ]; then cat "$probe"; fi
	rm -f "$probe"
}

portal_ndp_record() {
	local addr="$1" ok="$2" now state tmp
	now="$(date +%s)";state="$PORTAL_NDP_STATE";tmp="$state.$$"
	[ -f "$state" ] || return 0
	awk -v now="$now" -v addr="$addr" -v ok="$ok" '
		$1==addr{if(ok=="1")next;$4=$4+1;$5=now}
		{print}' "$state" > "$tmp" && mv "$tmp" "$state"
}

portal_ndp_known() {
	"$PORTAL_NDP_IP" -6 neigh show to "$1" dev "$PORTAL_LAN_DEV" 2>/dev/null |
		awk '/lladdr/ && !/FAILED|INCOMPLETE/{found=1} END{exit !found}'
}

portal_ndp_probe() (
	[ -d "$PORTAL_RUN" ] || exit 0
	# 复用已有flock依赖，避免并发telemetry丢失重试次数；不等待其他请求。
	exec 7>"$PORTAL_RUN/ndp-probe.lock"
	flock -n 7 || exit 0
	portal_ndp_plan | while IFS= read -r addr; do
		[ -n "$addr" ] || continue
		if ! portal_ndp_known "$addr"; then
			# neigh get不发送NS；绑定LAN的单次有时限ping触发真正的邻居解析。
			# 对端可以不回ICMP，只要已经取得有效链路层地址即可。
			ping -6 -I "$PORTAL_LAN_DEV" -c 1 -W 1 -w 1 "$addr" >/dev/null 2>&1 || :
		fi
		if portal_ndp_known "$addr"; then
			portal_ndp_record "$addr" 1
		else
			portal_ndp_record "$addr" 0
		fi
	done
)
