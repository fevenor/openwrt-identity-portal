#!/bin/sh
# 中立只读设备接口：一次快照、批量地址索引，身份与地址证据独立于授权判断。
portal_telemetry() {
 local now mac sec id name hostname os way source first last tab addr family evidence expiry owner suffix stamp kind v
 now="$(date +%s)"; tab="$(printf '\t')"
 # 先对已知IPv6流量的源地址做有界NDP补采，再读快照，使结果进入同一轮映射。
 if [ -r /usr/libexec/portal/ndp-probe.sh ]; then . /usr/libexec/portal/ndp-probe.sh; portal_ndp_probe; fi
 portal_snapshot || return 1
 # 当前邻居/租约的MAC与地址一次解析，不逐设备调用ip/ubus，也不写观察历史。
 awk -v now="$now" '
 function put(m,a,f,e,x){m=toupper(m); if(length(m)!=17||m~/[^0-9A-F:]/)return;k=m SUBSEP a;if(!seen[k]++)print m "\t" a "\t" f "\t" e "\t" x}
 FILENAME~/leases$/{if($1==0||$1>now)put($2,$3,4,"dhcp",$1);next}
 /FAILED|INCOMPLETE/{next}
 {for(i=1;i<NF;i++)if($i=="lladdr")put($(i+1),$1,index($1,":")?6:4,"neighbor:" $NF,0)}' \
  "$PORTAL_SNAPSHOT/leases" "$PORTAL_SNAPSHOT/neigh4" "$PORTAL_SNAPSHOT/neigh6" > "$PORTAL_SNAPSHOT/telemetry-addresses"
 # 当前MAC、登记MAC和历史MAC的并集，包含有线及未登记观测，不限受控AP。
 { portal_registry | cut -f1; cut -f1 "$PORTAL_SNAPSHOT/telemetry-addresses"; cut -f1 "$PORTAL_SNAPSHOT/history"; portal_wifi_macs; } | sort -u > "$PORTAL_SNAPSHOT/telemetry-macs"
 awk -v current="$PORTAL_SNAPSHOT/ipv6-map" -v historical="$PORTAL_SNAPSHOT/ipv6-history-map" \
  -f "${PORTAL_IPV6_AWK:-/usr/libexec/portal/ipv6.awk}" -f "${PORTAL_IPV6_INDEX_AWK:-/usr/libexec/portal/ipv6-index.awk}" \
  "$PORTAL_SNAPSHOT/neigh6" "$PORTAL_SNAPSHOT/history"
 json_init; json_add_int schema_version 1; json_add_string portal_version "$PORTAL_VERSION"; json_add_int observed_at "$now"
 json_add_string network "$PORTAL_LAN_DEV"; json_add_string scope 'registered-and-observed'; json_add_array devices
 while IFS= read -r owner; do
  mac="$(portal_norm_mac "$owner")" || continue
  sec="$(portal_find_device "$mac")"; id=;name=;config_get id "$sec" identity;config_get name "$id" name
  hostname="$(portal_hostname_of_mac "$mac")";source=dhcp
  if [ -z "$hostname" ];then hostname="$(portal_history_attr "$mac" 4)";source=history;fi
  [ -n "$hostname" ]||source=none
  way="$(portal_dev_online "$mac")";case "$way" in wifi|lan) os=online;;unknown) os=unknown;;*) os=offline;;esac
  first="$(portal_history_attr "$mac" 2)";last="$(portal_history_attr "$mac" 3)"
  case "$first" in ''|*[!0-9]*)first=0;;esac;case "$last" in ''|*[!0-9]*)last=0;;esac
  json_add_object '';json_add_string mac "$mac";json_add_string identity_id "$id";json_add_string identity_name "$name"
  for kind in label note;do config_get v "$sec" "$kind";json_add_string "$kind" "$v";done
  json_add_string hostname "$hostname";json_add_string hostname_source "$source";json_add_string registration_state "$(portal_device_state "$mac")"
  json_add_string online_state "$os";json_add_string online_evidence "${way:-none}";json_add_int observed_at "$now";json_add_int first_observed "$first";json_add_int last_seen "$last"
  json_add_array addresses
  while IFS="$tab" read -r owner addr family evidence expiry;do
   [ "$owner" = "$mac" ]||continue
   json_add_object '';json_add_string address "$addr";json_add_int family "$family";json_add_string evidence "$evidence";json_add_int observed_at "$now";json_add_int valid_until "${expiry:-0}";json_add_boolean historical 0;json_close_object
  done < "$PORTAL_SNAPSHOT/telemetry-addresses"
  json_close_array
  json_add_array historical_addresses
  addr="$(portal_history_attr "$mac" 5)"
  if [ -n "$addr" ];then json_add_object '';json_add_string address "$addr";json_add_int family 4;json_add_string evidence history;json_add_int observed_at "$last";json_add_boolean historical 1;json_close_object;fi
  while IFS="$tab" read -r owner addr suffix stamp;do
   [ "$owner" = "$mac" ]||continue
   json_add_object '';json_add_string address "$addr";json_add_int family 6;json_add_string suffix "$suffix";json_add_string evidence history;json_add_int observed_at "$stamp";json_add_boolean historical 1;json_close_object
  done < "$PORTAL_SNAPSHOT/ipv6-history-map"
  json_close_array;json_close_object
 done < "$PORTAL_SNAPSHOT/telemetry-macs"
 json_close_array;json_add_string note '地址证据不等于当前在线；历史地址和IPv6后缀不自动归属或授权';json_dump
}
