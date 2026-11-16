# 规范化 IPv6 及低 64 位；仅处理原生 IPv6，拒绝含 IPv4 尾部和作用域的字符串。
function normalize(ip, a,b,x,n,l,r,i,k,out) {
 ip=tolower(ip); if(ip !~ /^[0-9a-f:]+$/ || index(ip,":::") || index(ip,"."))return ""
 k=index(ip,"::")
 if(k){l=substr(ip,1,k-1);r=substr(ip,k+2);if(index(r,"::"))return "";n=0
  if(l!=""){x=split(l,a,":");for(i=1;i<=x;i++)b[++n]=a[i]}
  x=(r==""?0:split(r,a,":"));if(n+x>=8)return ""
  while(n<8-x)b[++n]="0";for(i=1;i<=x;i++)b[++n]=a[i]
 }else{n=split(ip,b,":");if(n!=8)return ""}
 out="";for(i=1;i<=8;i++){if(b[i]==""||length(b[i])>4||b[i]!~/^[0-9a-f]+$/)return "";while(length(b[i])<4)b[i]="0"b[i];out=out (i>1?":":"") b[i]}
 return out
}
mode=="normalize"{ip=normalize($1);if(ip!="")print ip "\t" substr(ip,21)}
