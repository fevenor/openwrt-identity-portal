# TSV：MAC、首次观察秒、最近在线秒、主机名、IPv4、最后接入方式、IPv6@观察秒列表。
# 只保存有界观察信息，不产生身份或准入权限；每台最多保留 16 个 IPv6 地址。
BEGIN{FS=OFS="\t"}
function valid(m){return m~/^[0-9A-F][0-9A-F](:[0-9A-F][0-9A-F]){5}$/&&substr(m,2,1)!~/[13579BDF]/&&m!="00:00:00:00:00:00"}
function merge6(old,new, a,b,n,i,v,k,result,count){
 n=split(new ";" old,a,";");delete b;result="";count=0
 for(i=1;i<=n;i++){split(a[i],v,"@");k=v[1];if(k==""||b[k]||k!~/^[0-9a-fA-F:]+$/||v[2]!~/^[0-9]+$/)continue;b[k]=1
  if(++count<=16)result=result (result!=""?";":"") a[i]}
 return result
}
valid($1)&&NF==7&&$2~/^[0-9]+$/&&$3~/^[0-9]+$/&&length($4)<=256 {
 m=$1
 if(!(m in first)||($2>0&&(first[m]==0||$2<first[m])))first[m]=$2
 if($3>last[m])last[m]=$3
 if($4!="")host[m]=$4
 if($5!="")ip[m]=$5
 if($6=="wifi"||$6=="lan")way[m]=$6
 v6[m]=merge6(v6[m],$7)
}
END{for(m in first)print m,first[m]+0,last[m]+0,host[m],ip[m],way[m],v6[m]}
