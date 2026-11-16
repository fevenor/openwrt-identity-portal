# 单次扫描无线、转发表、租约及邻居，只产生本轮确有证据的观察项。
BEGIN{OFS="\t"}
function mac(m){m=toupper(m);return m~/^[0-9A-F][0-9A-F](:[0-9A-F][0-9A-F]){5}$/&&substr(m,2,1)!~/[13579BDF]/&&m!="00:00:00:00:00:00"?m:""}
function primary(m,ip,r){if(ip!~/^169\.254\./&&r>rank[m]){ip4[m]=ip;rank[m]=r}}
FILENAME~/\/wifi$/{m=mac($1);if(m!=""){seen[m]=1;way[m]="wifi"};next}
FILENAME~/wifi-ports$/{ports[$1]=1;next}
FILENAME~/\/fdb$/{m=mac($2);if(m!=""&&$3=="no"&&$4+0<=30&&!ports[$1]){seen[m]=1;if(way[m]!="wifi")way[m]="lan"};next}
FILENAME~/\/leases$/{m=mac($2);if(m!=""){seen[m]=1;if($4!="*")hostname[m]=$4;if($1==0||$1>now)primary(m,$3,4)};next}
/FAILED|INCOMPLETE/{next}
{m="";for(i=1;i<NF;i++)if($i=="lladdr")m=mac($(i+1));if(m=="")next;seen[m]=1
 if(index($1,":")){ip=normalize($1);if(ip!="")v6[m]=v6[m] (v6[m]!=""?";":"") ip "@" (way[m]!=""?now:0)}
 else primary(m,$1,($NF=="REACHABLE"?3:1))
}
END{for(m in seen){stamp=(way[m]!=""?now:0);print m,stamp,stamp,hostname[m],ip4[m],way[m],v6[m]}}
