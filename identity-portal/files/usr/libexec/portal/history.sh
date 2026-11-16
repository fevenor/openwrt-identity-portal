#!/bin/sh
# 固定上限 512 台设备，运行期原子更新；15 分钟合并刷盘，正常停止主动保存。
PORTAL_HISTORY_MAX=512
PORTAL_HISTORY_INTERVAL=900
portal_history_snapshot() {
 local file="$PORTAL_RUN/history.tsv"
 [ -f "$file" ] || file="$PORTAL_HISTORY_FILE"
 if [ -f "$file" ]; then head -c 2097152 "$file" > "$PORTAL_SNAPSHOT/history"; else : > "$PORTAL_SNAPSHOT/history"; fi
}
portal_history_attr() { awk -F '\t' -v m="$1" -v n="$2" '$1==m{print $n;exit}' "$PORTAL_SNAPSHOT/history"; }
portal_history_macs() { cut -f1 "$PORTAL_SNAPSHOT/history"; }
portal_ipv6_normalize() { printf '%s\n' "$1" | awk -v mode=normalize -f "${PORTAL_IPV6_AWK:-/usr/libexec/portal/ipv6.awk}"; }
portal_history_merge() {
 local observations="$1" tmp
 mkdir -p "$PORTAL_RUN"
 exec 7>"$PORTAL_RUN/history.lock"
 portal_flock 7 5 || return 1
 [ -f "$PORTAL_RUN/history.tsv" ] || { if [ -f "$PORTAL_HISTORY_FILE" ]; then head -c 2097152 "$PORTAL_HISTORY_FILE" > "$PORTAL_RUN/history.tsv"; else : > "$PORTAL_RUN/history.tsv"; fi; }
 tmp="$(mktemp "$PORTAL_RUN/history.XXXXXX")" || { portal_flock_unlock 7; return 1; }
 awk -f "${PORTAL_HISTORY_AWK:-/usr/libexec/portal/history-merge.awk}" "$PORTAL_RUN/history.tsv" "$observations" | sort -t "$(printf '\t')" -k3,3nr -k2,2nr -k1,1 | head -n "$PORTAL_HISTORY_MAX" > "$tmp"
 if ! cmp -s "$tmp" "$PORTAL_RUN/history.tsv"; then mv -f "$tmp" "$PORTAL_RUN/history.tsv"; : > "$PORTAL_RUN/history-dirty"; else rm -f "$tmp"; fi
 portal_flock_unlock 7
}
portal_history_flush() {
 local force="${1:-0}" now last=0 tmp
 mkdir -p "$PORTAL_RUN"
 exec 7>"$PORTAL_RUN/history.lock"; portal_flock 7 5 || return 1
 now="$(date +%s)"; read -r last 2>/dev/null < "$PORTAL_RUN/history-saved" || last=0
 case "$last" in ''|*[!0-9]*) last=0;; esac
 if [ "$force" != 1 ] && [ "$last" = 0 ]; then printf '%s\n' "$now" > "$PORTAL_RUN/history-saved"; portal_flock_unlock 7; return 0; fi
 if [ -f "$PORTAL_RUN/history-dirty" ] && { [ "$force" = 1 ] || [ $((now-last)) -ge "$PORTAL_HISTORY_INTERVAL" ]; }; then
  mkdir -p "${PORTAL_HISTORY_FILE%/*}"
  tmp="$(mktemp "${PORTAL_HISTORY_FILE}.XXXXXX")" || { portal_flock_unlock 7; return 1; }
  if cat "$PORTAL_RUN/history.tsv" > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$PORTAL_HISTORY_FILE"; then
   rm -f "$PORTAL_RUN/history-dirty"; printf '%s\n' "$now" > "$PORTAL_RUN/history-saved"
  else rm -f "$tmp"; portal_flock_unlock 7; return 1; fi
 fi
 portal_flock_unlock 7
}
portal_history_observe() {
 local now work
 now="$(date +%s)"; work="$(mktemp /tmp/portal-observations.XXXXXX)" || return 1
 # 所有设备一次 awk 处理；不随离线历史增长产生逐设备外部命令。
 awk -v now="$now" -f "${PORTAL_IPV6_AWK:-/usr/libexec/portal/ipv6.awk}" -f "${PORTAL_OBSERVE_AWK:-/usr/libexec/portal/history-observe.awk}" \
  "$PORTAL_SNAPSHOT/wifi" "$PORTAL_SNAPSHOT/wifi-ports" "$PORTAL_SNAPSHOT/fdb" "$PORTAL_SNAPSHOT/leases" "$PORTAL_SNAPSHOT/neigh4" "$PORTAL_SNAPSHOT/neigh6" > "$work"
 portal_history_merge "$work"; rm -f "$work"
 portal_history_flush
}
portal_history_event() {
 local raw="$1" event mac now tmp
 [ "${#raw}" -le 4096 ] || return 1
 json_load "$raw" || return 1; json_get_keys event
 case "$event" in sta-authorized|disassoc|deauth|local-deauth|inactive-deauth) ;; *) return 0;; esac
 json_select "$event" || return 1; json_get_var mac address; mac="$(portal_norm_mac "$mac")" || return 1
 now="$(date +%s)"; tmp="$(mktemp /tmp/portal-event.XXXXXX)" || return 1
 printf '%s\t%s\t%s\t\t\twifi\t\n' "$mac" "$now" "$now" > "$tmp"
 portal_history_merge "$tmp"; rm -f "$tmp"
}
