# 批量建立当前与历史 IPv6 索引，避免每台/每地址重复执行规范化程序。
BEGIN{OFS="\t";printf "%s","" > current;printf "%s","" > historical}
FILENAME~/history$/{
 n=split($0,f,"\t");if(n!=7)next
 n=split(f[7],entries,";")
 for(j=1;j<=n;j++){split(entries[j],v,"@");address=normalize(v[1]);if(address==""||v[2]!~/^[0-9]+$/)continue
  print f[1],address,substr(address,21),v[2] > historical}
 next
}
/FAILED|INCOMPLETE/{next}
{owner="";for(i=1;i<NF;i++)if($i=="lladdr")owner=toupper($(i+1));address=normalize($1)
 if(owner==""||address==""||seen[owner,address]++)next
 kind=(address~/^fe[89ab]/?"link-local":(address~/^f[cd]/?"ula":"global"))
 print owner,address,substr(address,21),kind > current
}
END{close(current);close(historical)}
