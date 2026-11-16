"""隔离回归：使用真实 UCI、jsonfilter、jshn，替代网络和服务命令。"""
import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import urllib.parse
import time
import signal

ROOT = Path(__file__).resolve().parents[1]


class PortalTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='portal-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.fs = self.base / 'root'
        shutil.copytree(ROOT / 'identity-portal/files', self.fs)
        self.bin = self.base / 'bin'; self.bin.mkdir()
        self.config = self.fs / 'etc/config'
        self.run = self.base / 'run'; self.run.mkdir()
        self.delta = self.base / 'delta'; self.delta.mkdir()
        self.trace = self.base / 'trace'
        # 路径重定位只作用于测试副本；不会安装或执行真实 init 脚本。
        for f in self.fs.rglob('*'):
            if f.is_file() and f.read_bytes().startswith(b'#!/bin/sh'):
                text = f.read_text().replace('#!/bin/sh', '#!' + os.environ.get('PORTAL_TEST_SHELL', '/bin/bash'), 1)
                for path in ['/etc/portal/', '/etc/init.d/', '/usr/libexec/portal/', '/usr/libexec/rpcd/', '/usr/share/portal/']:
                    text = text.replace(path, str(self.fs / path.lstrip('/')) + '/')
                f.write_text(text); f.chmod(0o755)
        for f in (self.fs / 'etc/init.d').iterdir():
            f.write_text('#!/bin/sh\nprintf "service %s\\n" "$*" >> "$TRACE"\n'); f.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.bin) + ':' + os.environ['PATH'],
                        PORTAL_LIB=str(self.fs / 'usr/libexec/portal/devices.sh'),
                        PORTAL_FUNCTIONS=os.environ['FUNCTIONS_SH'], PORTAL_JSHN=os.environ['JSHN_SH'],
                        PORTAL_CONFIG_DIR=str(self.config), PORTAL_RUN=str(self.run),
                        PORTAL_LOCK=str(self.base / 'lock'), PORTAL_DELTA=str(self.delta),
                        PORTAL_WWW_DIR=str(self.base / 'www'),
                        PORTAL_TMPL=str(self.fs / 'usr/share/portal/tmpl/index.html.tmpl'),
                        PORTAL_OUI_TSV=str(self.fs / 'etc/portal/oui.tsv'),
                        PORTAL_DHCP_LEASES=str(self.base / 'leases'),
                        PORTAL_SYS_NET=str(self.base / 'sys-net'),
                        TRACE=str(self.trace), TEST_CONFIG=str(self.config), TEST_DELTA=str(self.delta), TEST_BASE=str(self.base))
        self.stub('uci', '#!/bin/sh\nprintf "uci\\n" >> "$TRACE"\nexec "'+os.environ['UCI_BIN']+'" -c "$TEST_CONFIG" -t "$TEST_DELTA" "$@"\n')
        for name, env in [('jsonfilter', 'JSONFILTER_BIN'), ('jshn', 'JSHN_BIN')]:
            (self.bin / name).symlink_to(os.environ[env])
        if os.environ.get('HEXDUMP_BIN'):
            (self.bin / 'hexdump').symlink_to(os.environ['HEXDUMP_BIN'])
        for name in ['logger', 'conntrack']:
            self.stub(name, '#!/bin/sh\nprintf "'+name+' %s\\n" "$*" >> "$TRACE"\n')
        self.stub('nft', '#!/bin/sh\nprintf "nft %s\\n" "$*" >> "$TRACE"\n[ ! -e "$TEST_BASE/nft-fail" ] || exit 1\ncase "$*" in "-f -") cat >> "$TRACE";; *"-f "*) for p in "$@"; do [ ! -f "$p" ] || cat "$p" >> "$TRACE"; done;; esac\n')
        self.stub('brctl', '#!/bin/sh\ncat "$TEST_BASE/fdb"\n')
        self.stub('iw', '#!/bin/sh\ncat "$TEST_BASE/iw-stations"\n')
        (self.base/'fdb').write_text('')
        (self.base/'iw-stations').write_text('')
        self.stub('ip', '#!/bin/sh\ncase "$*" in "-4 neigh"*) cat "$TEST_BASE/neigh4";; "-6 neigh"*) cat "$TEST_BASE/neigh6";; esac\n')
        self.stub('ubus', '''#!/bin/sh
case "$*" in
 *get_clients*) cat "$TEST_BASE/wifi";;
 *network.wireless*) cat "$TEST_BASE/wireless-status";;
 *) echo '{}';;
esac
''')
        self.stub('curl', '''#!/bin/sh
cat >/dev/null
[ ! -e "$TEST_BASE/api-fail" ] || exit 22
for last in "$@"; do :; done
case "$last" in
 */configs) if [ -e "$TEST_BASE/api-mode" ]; then cat "$TEST_BASE/api-mode"; else printf '{"mode":"rule"}'; fi;;
 */providers/rules) n=$(grep -c SRC-IP-CIDR "$PORTAL_RUN/unauth-src.yaml"); printf '{"providers":{"unauth-src":{"vehicleType":"File","behavior":"Classical","ruleCount":%s}}}' "$n";;
 */rules) if [ -e "$TEST_BASE/api-rules" ]; then cat "$TEST_BASE/api-rules"; else printf '{"rules":[{"type":"RuleSet","payload":"unauth-src","proxy":"出口示例"}]}'; fi;;
 */connections) cat "$TEST_BASE/connections";;
 */connections/*) printf 'closed %s\\n' "$last" >> "$TRACE";;
esac
''')
        self.mac = '02:00:00:00:00:01'
        (self.base / 'wifi').write_text(json.dumps({'clients': {self.mac.lower(): {'signal': -50, 'connected_time': 12}}}))
        (self.base / 'wireless-status').write_text(json.dumps({'radio0': {'interfaces': [{'ifname': 'wlan0', 'section': 'ap0'}]}}))
        (self.base / 'neigh4').write_text('192.0.2.10 lladdr 02:00:00:00:00:01 REACHABLE\n')
        (self.base / 'neigh6').write_text('2001:db8::10 lladdr 02:00:00:00:00:01 REACHABLE\nfd00::10 lladdr 02:00:00:00:00:01 STALE\n')
        (self.base / 'leases').write_text('0 02:00:00:00:00:01 192.0.2.10 example *\n')
        (self.base / 'connections').write_text(json.dumps({'connections': [{'id': 'v6-1', 'metadata': {'sourceIP': '2001:db8::10'}}, {'id': 'ula-1', 'metadata': {'sourceIP': 'fd00::10'}}, {'id': 'other', 'metadata': {'sourceIP': '192.0.2.11'}}]}))
        (self.config / 'wireless').write_text("config wifi-iface 'ap0'\n option mode 'ap'\n")
        (self.config / 'firewall').write_text("config defaults\n option flow_offloading '0'\n")
        for field, value in [('enabled','1'),('wifi_ifaces','wlan0'),('listen_ipv4','192.0.2.1'),('mihomo_api','http://127.0.0.1:9090'),('mihomo_target','出口示例')]:
            self.uci('set', f'portal.global.{field}={value}')
        self.uci('commit', 'portal')

    def stub(self, name, text):
        f = self.bin / name; f.write_text(text); f.chmod(0o755)

    def execute(self, args, data=None, **extra):
        return subprocess.run(args, input=data, env={**self.env, **extra}, text=True, capture_output=True, timeout=25)

    def uci(self, *args):
        r=self.execute(['uci',*args]); self.assertEqual(r.returncode, 0, r.stderr); return r.stdout.strip()

    def admin(self, *args, ok=True):
        r=self.execute([str(self.fs/'etc/portal/portal-admin'), *args])
        try: result=json.loads(r.stdout)
        except ValueError: self.fail(f'非法 JSON: {r.stdout}\n{r.stderr}')
        self.assertEqual(bool(result.get('ok')), ok, str(result)+'\n'+r.stderr)
        return result

    def rpc(self, method, args=None):
        r=self.execute([str(self.fs/'usr/libexec/rpcd/portal'), 'call', method], json.dumps(args or {}))
        try: return json.loads(r.stdout)
        except ValueError: self.fail(f'非法 JSON: {r.stdout}\n{r.stderr}')

    def test_name_and_utf8(self):
        for name in ['Alice','张三Q','张三q','张三Z']:
            r=self.execute(['sh','-c','. "$PORTAL_LIB"; portal_valid_name "$1"','test',name]); self.assertEqual(r.returncode,0,r.stderr)
        for name in ['bad name','<script>','A'*33]:
            r=self.execute(['sh','-c','. "$PORTAL_LIB"; portal_valid_name "$1"','test',name]); self.assertNotEqual(r.returncode,0)

    def test_utf8_validation_without_od(self):
        # 精简 OpenWrt 不一定启用 BusyBox od；故意让任何 od 调用失败。
        self.stub('od','#!/bin/sh\nprintf "unexpected od\\n" >> "$TRACE"\nexit 127\n')
        self.admin('split',self.mac,'中文A')
        self.admin('setpage','登记测试','请输入姓名')
        self.assertIn('登记测试',(self.base/'www/index.html').read_text())
        self.assertNotIn('unexpected od',self.trace.read_text())

    def test_registration_block_and_recovery(self):
        self.admin('block',self.mac,'','L1')
        self.admin('register','192.0.2.10','张三Q',ok=False)
        self.assertEqual(self.uci('get','portal.dev_020000000001.policy'),'block')
        self.admin('unblock',self.mac)
        self.admin('register','192.0.2.10','张三Q')
        self.admin('register','192.0.2.10','重复')
        self.assertEqual(len(self.rpc('identities')['identities']),1)

    def test_identity_trust_egress_orthogonal(self):
        self.admin('split',self.mac,'示例')
        self.admin('whitelist',self.mac,'1')
        self.admin('setegress',self.mac,'wifi-only')
        self.admin('assign',self.mac,'')
        self.assertEqual(self.rpc('devices')['devices'][0]['state'],'trusted')
        self.admin('block',self.mac,'','L1'); self.admin('unblock',self.mac)
        self.assertEqual(self.uci('get','portal.dev_020000000001.egress'),'wifi-only')
        self.admin('whitelist',self.mac,'0')
        self.assertEqual(self.rpc('devices')['devices'][0]['state'],'unregistered')
        self.admin('setegress',self.mac,'wifi-only',ok=False)
        self.admin('forget',self.mac)
        self.assertEqual(self.rpc('devices')['devices'],[])

    def test_invalid_changes_do_not_leak(self):
        before=(self.config/'portal').read_bytes()
        self.admin('setdevice',self.mac,'Valid','bad\nnote',ok=False)
        self.admin('setpage','Valid','bad\nprompt',ok=False)
        self.assertEqual(before,(self.config/'portal').read_bytes())
        self.assertEqual(self.uci('changes','portal'),'')

    def test_optional_fields_and_literal_dash(self):
        self.admin('setdevice',self.mac,'Label','Note')
        self.rpc('setdevice',{'mac':self.mac,'note':'-'})
        self.assertEqual(self.uci('get','portal.dev_020000000001.label'),'Label')
        self.assertEqual(self.uci('get','portal.dev_020000000001.note'),'-')
        self.rpc('setdevice',{'mac':self.mac,'note':''})
        self.assertEqual(self.execute(['uci','-q','get','portal.dev_020000000001.note']).returncode,1)

    def test_wireless_ownership(self):
        self.uci('set','wireless.ap0.macfilter=deny'); self.uci('add_list','wireless.ap0.maclist=02:00:00:00:00:99'); self.uci('commit','wireless')
        self.admin('block',self.mac,'','L2'); self.admin('unblock',self.mac)
        self.assertEqual(self.uci('get','wireless.ap0.maclist'),'02:00:00:00:00:99')
        self.assertEqual(self.uci('get','wireless.ap0.macfilter'),'deny')
        self.uci('set','wireless.ap0.macfilter=allow'); self.uci('commit','wireless')
        self.admin('block',self.mac,'','L2',ok=False)
        self.assertEqual(self.uci('get','wireless.ap0.macfilter'),'allow')

    def test_provider_union_and_fault_closes(self):
        self.admin('split',self.mac,'示例'); self.admin('setegress',self.mac,'wifi-only')
        (self.base/'wifi').write_text(json.dumps({'clients': {self.mac.lower(): {}, '02:00:00:00:00:02': {}}}))
        with (self.base/'neigh4').open('a') as f: f.write('192.0.2.20 lladdr 02:00:00:00:00:02 REACHABLE\n')
        self.uci('set','portal.global.unauth_policy=wifi-only'); self.uci('commit','portal')
        self.execute([str(self.fs/'etc/portal/portal-sync-unauth'),'--force'])
        payload=(self.run/'unauth-src.yaml').read_text()
        self.assertIn('192.0.2.20/32',payload)
        self.assertIn('2001:db8::10/128',payload); self.assertIn('fd00::10/128',payload)
        self.assertTrue((self.run/'ready-until').exists())
        (self.base/'api-fail').touch()
        r=self.execute([str(self.fs/'etc/portal/portal-sync-unauth'),'--force'])
        self.assertNotEqual(r.returncode,0); self.assertFalse((self.run/'ready-until').exists())
        self.assertIn('flush set inet portal ready6',self.trace.read_text())

    def test_ipv6_conntrack_and_mihomo(self):
        self.admin('split',self.mac,'示例'); self.admin('setegress',self.mac,'wifi-only')
        log=self.trace.read_text()
        self.assertIn('conntrack -D -f ipv6 -s 2001:db8::10',log)
        self.assertIn('conntrack -D -f ipv6 -s fd00::10',log)
        self.assertIn('closed http://127.0.0.1:9090/connections/v6-1',log)
        self.assertNotIn('closed http://127.0.0.1:9090/connections/other',log)

    def test_get_and_disabled_registration(self):
        cgi=str(self.fs/'usr/share/portal/www/cgi-bin/portal/register')
        r=self.execute([cgi],REQUEST_METHOD='GET',QUERY_STRING='name=Alice')
        self.assertIn('请通过门户',r.stdout)
        self.uci('set','portal.global.enabled=0'); self.uci('commit','portal')
        self.admin('register','192.0.2.10','Alice',ok=False)

    def test_cgi_post_validation(self):
        cgi=str(self.fs/'usr/share/portal/www/cgi-bin/portal/register')
        def post(body, **extra):
            return self.execute([cgi],body,REQUEST_METHOD='POST',CONTENT_TYPE='application/x-www-form-urlencoded',CONTENT_LENGTH=str(len(body)),REMOTE_ADDR='192.0.2.10',HTTP_HOST='192.0.2.1:8081',**extra)
        r=post('name=Alice',HTTP_ORIGIN='http://example.invalid')
        self.assertNotIn('登记成功',r.stdout)
        for body in ['name=A&name=B','name=%00','name=%','name=%ff','name=bad+name']:
            self.assertNotIn('登记成功',post(body).stdout)
        r=post(urllib.parse.urlencode({'name':'张三Q'}),HTTP_ORIGIN='http://192.0.2.1:8081')
        self.assertIn('登记成功',r.stdout,r.stderr)
        self.assertEqual(self.rpc('identities')['identities'][0]['name'],'张三Q')

    def cgi_post(self, name='测试设备', remote='192.0.2.10'):
        body=urllib.parse.urlencode({'name':name})
        return self.execute([str(self.fs/'usr/share/portal/www/cgi-bin/portal/register')],body,
                            REQUEST_METHOD='POST',CONTENT_TYPE='application/x-www-form-urlencoded',
                            CONTENT_LENGTH=str(len(body)),REMOTE_ADDR=remote,
                            HTTP_HOST='192.0.2.1:8081',HTTP_ORIGIN='http://192.0.2.1:8081')

    def test_cgi_ipv6_registration_and_repeated_post(self):
        self.assertIn('登记成功',self.cgi_post(remote='2001:db8::10').stdout)
        self.assertIn('登记成功',self.cgi_post(remote='fd00::10').stdout)
        self.assertEqual(len(self.rpc('devices')['devices']),1)
        self.assertEqual(len(self.rpc('identities')['identities']),1)

    def test_cgi_rejects_wired_and_stale_lease_without_writes(self):
        before=(self.config/'portal').read_bytes()
        (self.base/'wifi').write_text('{"clients":{}}')
        self.assertNotIn('登记成功',self.cgi_post().stdout)
        (self.base/'wifi').write_text(json.dumps({'clients':{self.mac.lower():{}}}))
        (self.base/'neigh4').write_text('192.0.2.10 FAILED\n')
        self.assertNotIn('登记成功',self.cgi_post().stdout)
        self.assertEqual(before,(self.config/'portal').read_bytes())

    def test_cgi_blacklist_and_disabled_preserve_registry(self):
        self.admin('block',self.mac,'测试封禁','L1')
        before=(self.config/'portal').read_bytes()
        self.assertIn('管理员封禁',self.cgi_post().stdout)
        self.assertEqual(before,(self.config/'portal').read_bytes())
        self.admin('setenabled','0')
        before=(self.config/'portal').read_bytes()
        self.assertIn('尚未启用',self.cgi_post().stdout)
        self.assertEqual(before,(self.config/'portal').read_bytes())

    def test_cgi_nft_failure_does_not_report_success(self):
        (self.base/'nft-fail').touch()
        response=self.cgi_post()
        self.assertNotIn('登记成功',response.stdout)
        self.assertIn('规则应用失败',response.stdout)
        # 已保存的登记不会丢失；修复后可幂等重试，不创建重复身份。
        (self.base/'nft-fail').unlink()
        self.assertIn('登记成功',self.cgi_post().stdout)
        self.assertEqual(len(self.rpc('identities')['identities']),1)

    def test_redirect_rules_only_mark_controlled_wifi(self):
        self.trace.write_text('')
        r=self.execute([str(self.fs/'etc/portal/gen_rules.sh')])
        self.assertEqual(r.returncode,0,r.stderr)
        rules=self.trace.read_text()
        self.assertIn('iifname { "wlan0" } meta mark set',rules)
        self.assertIn('meta mark & 0x40000000 == 0 return',rules)
        self.assertIn('redirect to :53',rules)
        self.assertIn('redirect to :8081',rules)
        self.assertNotIn('th dport { 53, 80',rules)
        self.assertNotIn('nft delete table',rules)
        self.assertNotIn('conntrack -F',rules)

    def test_alias_rules_keep_dns_and_portal_but_not_admin_http(self):
        self.uci('set','portal.global.capture_mode=alias')
        self.uci('set','portal.global.alias_ipv4=192.0.2.254'); self.uci('commit','portal')
        self.trace.write_text('')
        r=self.execute([str(self.fs/'etc/portal/gen_rules.sh')])
        self.assertEqual(r.returncode,0,r.stderr)
        rules=self.trace.read_text()
        self.assertIn('redirect to :5353',rules)
        self.assertIn('fib daddr type local meta l4proto { tcp, udp } th dport 5353 accept',rules)
        self.assertIn('ip daddr 192.0.2.254 tcp dport 80 accept',rules)
        self.assertNotIn('fib daddr type local tcp dport 80 accept',rules)
        self.assertNotIn('ip daddr 192.0.2.1 tcp dport 80 accept',rules)

    def test_rpc_acl_and_types(self):
        r=self.execute([str(self.fs/'usr/libexec/rpcd/portal'),'list'])
        methods=json.loads(r.stdout)
        acl=json.loads((ROOT/'luci-app-identity-portal/root/usr/share/rpcd/acl.d/luci-app-identity-portal.json').read_text())['luci-app-identity-portal']
        read=set(acl['read']['ubus']['portal']); write=set(acl['write']['ubus']['portal'])
        self.assertFalse(read & write)
        self.assertEqual(set(methods),read|write)
        self.assertIsInstance(methods['whitelist']['trusted'],int)
        self.assertIsInstance(methods['setenabled']['enabled'],int)

    def test_offloading_prevents_rule_install(self):
        self.uci('set','portal.global.offload_policy=require-off'); self.uci('commit','portal')
        self.uci('set','firewall.@defaults[0].flow_offloading=1'); self.uci('commit','firewall')
        self.trace.write_text('')
        r=self.execute([str(self.fs/'etc/portal/gen_rules.sh')])
        self.assertNotEqual(r.returncode,0)
        self.assertNotIn('nft -f',self.trace.read_text())

    def test_default_allows_offloading_without_changing_firewall(self):
        self.uci('set','firewall.@defaults[0].flow_offloading=1')
        self.uci('set','firewall.@defaults[0].flow_offloading_hw=1'); self.uci('commit','firewall')
        before=(self.config/'firewall').read_bytes()
        self.admin('split',self.mac,'示例')
        self.assertEqual(before,(self.config/'firewall').read_bytes())
        status=self.rpc('status')
        self.assertEqual(status['offload_policy'],'allow')
        self.assertTrue(status['flow_offloading']); self.assertTrue(status['flow_offloading_hw'])
        self.assertIn('nft -f',self.trace.read_text())

    def test_offload_policy_rpc_and_validation(self):
        self.assertTrue(self.rpc('setoffload',{'policy':'require-off'})['ok'])
        self.assertEqual(self.rpc('config')['offload_policy'],'require-off')
        before=(self.config/'portal').read_bytes()
        self.assertEqual(self.rpc('setoffload',{'policy':'invalid'})['error'],'E_PARAM')
        self.assertEqual(before,(self.config/'portal').read_bytes())
        self.assertTrue(self.rpc('setoffload',{'policy':'allow'})['ok'])

    def test_strict_policy_rejects_active_offload_without_partial_save(self):
        self.uci('set','firewall.@defaults[0].flow_offloading=1'); self.uci('commit','firewall')
        before=(self.config/'portal').read_bytes()
        self.admin('setoffload','require-off',ok=False)
        self.assertEqual(before,(self.config/'portal').read_bytes())
        self.admin('setenabled','0')
        self.admin('setoffload','require-off')
        self.admin('setenabled','1',ok=False)
        self.assertEqual(self.uci('get','portal.global.enabled'),'0')

    def test_missing_offload_option_preserves_system_setting(self):
        self.uci('delete','portal.global.offload_policy'); self.uci('commit','portal')
        self.uci('set','firewall.@defaults[0].flow_offloading=1'); self.uci('commit','firewall')
        self.admin('setenabled','1')
        self.assertEqual(self.rpc('status')['offload_policy'],'allow')

    def test_offload_boolean_spellings_match_firewall4(self):
        for value in ['1','on','true','yes']:
            self.uci('set','firewall.@defaults[0].flow_offloading='+value); self.uci('commit','firewall')
            self.assertTrue(self.rpc('status')['flow_offloading'])
            self.admin('setoffload','require-off',ok=False)
        for value in ['0','off','false','no']:
            self.uci('set','firewall.@defaults[0].flow_offloading='+value); self.uci('commit','firewall')
            self.assertFalse(self.rpc('status')['flow_offloading'])

    def test_concurrent_registration(self):
        def call(i): return self.admin('register','192.0.2.10','示例')
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: list(pool.map(call,range(4)))
        self.assertEqual(len(self.rpc('identities')['identities']),1)
        self.assertEqual(len(self.rpc('devices')['devices']),1)


    def observe(self):
        r=self.execute([str(self.fs/'etc/portal/portal-observe'),'--once'])
        self.assertEqual(r.returncode,0,r.stderr)

    def test_ipv4_prefers_lease_over_link_local(self):
        with (self.base/'neigh4').open('a') as f: f.write('169.254.123.45 lladdr '+self.mac+' STALE\n')
        self.assertEqual(self.rpc('unidentified')['devices'][0]['ip'],'192.0.2.10')
        self.admin('split',self.mac,'示例')
        self.trace.write_text(''); self.admin('block',self.mac,'','L1')
        self.assertIn('conntrack -D -f ipv4 -s 169.254.123.45',self.trace.read_text())

    def test_ipv4_reachable_preferred_without_valid_lease(self):
        (self.base/'leases').write_text('1 '+self.mac+' 192.0.2.20 stale *\n')
        (self.base/'neigh4').write_text('169.254.123.45 lladdr '+self.mac+' STALE\n192.0.2.30 lladdr '+self.mac+' STALE\n192.0.2.99 lladdr '+self.mac+' REACHABLE\n')
        self.assertEqual(self.rpc('unidentified')['devices'][0]['ip'],'192.0.2.99')

    def test_offline_dhcp_and_stale_not_online(self):
        self.observe(); (self.base/'wifi').write_text('{"clients":{}}')
        (self.base/'neigh4').write_text('192.0.2.10 FAILED\n')
        (self.base/'neigh6').write_text('fd00::10 lladdr '+self.mac+' STALE\n')
        dev=self.rpc('unidentified')['devices'][0]
        self.assertEqual(dev['online_state'],'offline'); self.assertEqual(dev['online_way'],'')
        self.assertEqual(dev['ip'],'192.0.2.10'); self.assertEqual(dev['ip_source'],'history')

    def test_reachable_without_port_is_unknown_not_lan(self):
        self.observe(); (self.base/'wifi').write_text('{"clients":{}}')
        self.assertEqual(self.rpc('unidentified')['devices'][0]['online_way'],'unknown')

    def test_recent_wired_fdb_is_lan(self):
        self.observe(); (self.base/'wifi').write_text('{"clients":{}}')
        (self.base/'fdb').write_text('3 '+self.mac.lower()+' no 0.20\n')
        self.assertEqual(self.rpc('unidentified')['devices'][0]['online_way'],'lan')
        (self.base/'fdb').write_text('3 '+self.mac.lower()+' no 100.00\n')
        self.assertEqual(self.rpc('unidentified')['devices'][0]['online_way'],'unknown')

    def test_wifi_fdb_does_not_become_lan(self):
        self.observe(); (self.base/'wifi').write_text('{"clients":{}}')
        port=self.base/'sys-net/br-lan/brif/wlan0'; port.mkdir(parents=True); (port/'port_no').write_text('0x5\n')
        (self.base/'fdb').write_text('5 '+self.mac.lower()+' no 0.20\n')
        self.assertNotEqual(self.rpc('unidentified')['devices'][0]['online_way'],'lan')

    def test_unassociated_hostapd_entry_not_online(self):
        (self.base/'wifi').write_text(json.dumps({'clients': {self.mac.lower(): {'assoc':False}}}))
        self.admin('register','192.0.2.10','示例',ok=False)

    def test_failed_hostapd_marks_unknown(self):
        self.observe(); self.stub('ubus','#!/bin/sh\nexit 1\n')
        self.assertEqual(self.rpc('unidentified')['devices'][0]['online_state'],'unknown')

    def test_history_keeps_unregistered_offline_and_hostname(self):
        before=(self.config/'portal').read_bytes(); self.observe()
        self.assertEqual(before,(self.config/'portal').read_bytes())
        for name in ['wifi','leases','neigh4','neigh6']:
            (self.base/name).write_text('{"clients":{}}' if name=='wifi' else '')
        self.observe(); dev=self.rpc('unidentified')['devices'][0]
        self.assertEqual(dev['hostname'],'example'); self.assertEqual(dev['hostname_source'],'history')
        self.assertEqual(dev['online_state'],'offline'); self.assertGreater(dev['last_seen'],0)
        self.assertEqual(dev['state'],'unregistered')

    def test_offline_history_whitelist_and_block(self):
        self.observe(); (self.base/'wifi').write_text('{"clients":{}}')
        self.admin('whitelist',self.mac,'1'); self.assertEqual(self.rpc('unidentified')['devices'],[])
        self.admin('block',self.mac,'','L1'); self.assertEqual(self.rpc('devices')['devices'][0]['state'],'blocked')

    def test_queries_never_write_history_or_registry(self):
        self.observe(); before=(self.run/'history.tsv').read_bytes(); registry=(self.config/'portal').read_bytes()
        self.rpc('devices'); self.rpc('inventory'); self.rpc('unidentified')
        self.assertEqual(before,(self.run/'history.tsv').read_bytes()); self.assertEqual(registry,(self.config/'portal').read_bytes())

    def test_history_flush_and_restart_readback(self):
        self.observe(); self.assertFalse((self.fs/'etc/portal/history.tsv').exists())
        r=self.execute([str(self.fs/'etc/portal/portal-observe'),'--flush']); self.assertEqual(r.returncode,0,r.stderr)
        saved=self.fs/'etc/portal/history.tsv'; self.assertTrue(saved.exists()); self.assertEqual(saved.stat().st_mode&0o777,0o600)
        (self.run/'history.tsv').unlink(); (self.base/'wifi').write_text('{"clients":{}}'); (self.base/'leases').write_text('')
        self.assertEqual(self.rpc('unidentified')['devices'][0]['hostname'],'example')

    def test_history_disconnect_event_captures_short_visit(self):
        raw=json.dumps({'disassoc': {'address': '02:00:00:00:00:99'}})
        r=self.execute([str(self.fs/'etc/portal/portal-observe'),'--event',raw]); self.assertEqual(r.returncode,0,r.stderr)
        dev=next(d for d in self.rpc('unidentified')['devices'] if d['mac']=='02:00:00:00:00:99')
        self.assertEqual(dev['online_state'],'offline'); self.assertGreater(dev['last_seen'],0)
        self.assertEqual(dev['state'],'unregistered')

    def test_history_ignores_unrelated_event_and_invalid_mac(self):
        for raw in [{'probe': {'address':self.mac}}, {'disassoc':{'address':'invalid'}}]:
            self.execute([str(self.fs/'etc/portal/portal-observe'),'--event',json.dumps(raw)])
        self.assertFalse((self.run/'history.tsv').exists())

    def test_history_capacity_and_ipv6_bound(self):
        rows=self.base/'observations'; rows.write_text(''.join(f'02:00:00:00:{i//256:02X}:{i%256:02X}\t{i+1}\t{i+1}\thost\t192.0.2.10\twifi\t\n' for i in range(520)))
        r=self.execute(['sh','-c','. "$PORTAL_LIB"; portal_history_merge "$TEST_BASE/observations"'])
        self.assertEqual(r.returncode,0,r.stderr); self.assertEqual(len((self.run/'history.tsv').read_text().splitlines()),512)
        v6=';'.join(f'2001:db8::{i:x}@1' for i in range(1,30)); rows.write_text(f'{self.mac}\t1\t1000\thost\t\twifi\t{v6}\n')
        self.execute(['sh','-c','. "$PORTAL_LIB"; portal_history_merge "$TEST_BASE/observations"'])
        line=next(l for l in (self.run/'history.tsv').read_text().splitlines() if l.startswith(self.mac+'\t'))
        self.assertEqual(len(line.split('\t')[6].split(';')),16)

    def test_ipv6_suffix_normalization_and_rejection(self):
        for addr in ['2001:db8::10','2001:0DB8:0:0:0:0:0:0010']:
            r=self.execute(['sh','-c','. "$PORTAL_LIB"; portal_ipv6_normalize "$1"','test',addr])
            self.assertEqual(r.stdout.strip().split('\t')[1],'0000:0000:0000:0010')
        for addr in [':::10','2001::db8::10','12345::1','::ffff:192.0.2.1','fe80::1%wlan0',':1:2:3:4:5:6:7']:
            self.assertEqual(self.execute(['sh','-c','. "$PORTAL_LIB"; portal_ipv6_normalize "$1"','test',addr]).stdout,'')

    def test_ipv6_history_suffix_conflict_never_assigns(self):
        self.observe(); before=(self.config/'portal').read_bytes()
        with (self.base/'neigh6').open('a') as f: f.write('2001:db9::10 lladdr 02:00:00:00:00:02 REACHABLE\n')
        dev=next(d for d in self.rpc('unidentified')['devices'] if d['mac']==self.mac)
        self.assertTrue(dev['ipv6_candidates'][0]['conflict']); self.assertEqual(dev['ipv6_candidates'][0]['mac'],'02:00:00:00:00:02')
        self.assertEqual(before,(self.config/'portal').read_bytes())
        self.assertTrue(dev['ipv6_history']); self.assertTrue(dev['ipv6'])

    def test_registered_forget_keeps_observation_not_authority(self):
        self.observe(); self.admin('split',self.mac,'示例'); self.admin('forget',self.mac)
        self.assertEqual(self.rpc('devices')['devices'],[]); self.assertEqual(self.rpc('unidentified')['devices'][0]['state'],'unregistered')

    def test_inventory_uses_one_config_and_one_wifi_snapshot(self):
        self.admin('split',self.mac,'示例'); self.trace.write_text('')
        self.stub('ubus','#!/bin/sh\nprintf "wifi-snapshot\\n" >> "$TRACE"\ncat "$TEST_BASE/wifi"\n')
        result=self.rpc('inventory'); self.assertEqual(len(result['devices']),1); self.assertEqual(result['unidentified'],[])
        self.assertEqual(self.trace.read_text().splitlines().count('uci'),1); self.assertEqual(self.trace.read_text().splitlines().count('wifi-snapshot'),1)

    def test_iw_connected_duration_fallback(self):
        (self.base/'iw-stations').write_text('Station '+self.mac.lower()+' (on wlan0)\n\tconnected time:\t123 seconds\n')
        (self.base/'wifi').write_text(json.dumps({'clients':{self.mac.lower():{'assoc':True}}}))
        self.assertEqual(self.rpc('unidentified')['devices'][0]['connected_s'],123)

    def test_integration_error_specific_target_and_rule(self):
        self.admin('split',self.mac,'示例')
        self.uci('delete','portal.global.mihomo_target'); self.uci('commit','portal'); self.admin('setegress',self.mac,'wifi-only')
        self.assertEqual(self.rpc('status')['integration_state'],'target-missing')
        self.uci('set','portal.global.mihomo_target=出口示例'); self.uci('commit','portal')
        (self.base/'api-rules').write_text('{"rules":[{"type":"Match","payload":"","proxy":"DIRECT"}]}')
        self.execute([str(self.fs/'etc/portal/portal-sync-unauth'),'--force'])
        self.assertEqual(self.rpc('status')['integration_state'],'rule-order-target'); self.assertFalse((self.run/'ready-until').exists())

    def test_last_limited_device_stops_sync_service(self):
        self.admin('split',self.mac,'示例'); self.admin('setegress',self.mac,'wifi-only')
        self.trace.write_text(''); self.admin('setegress',self.mac,'normal')
        self.assertIn('service stop',self.trace.read_text()); self.assertFalse((self.run/'ready-until').exists())

    def test_alias_dual_stack_dns_local_nodata_contract(self):
        self.uci('set','portal.global.capture_mode=alias'); self.uci('set','portal.global.alias_ipv4=192.0.2.254'); self.uci('commit','portal')
        self.trace.write_text(''); self.execute([str(self.fs/'etc/portal/gen_rules.sh')]); rules=self.trace.read_text()
        self.assertNotIn('meta nfproto ipv4 meta l4proto { tcp, udp } th dport 53 redirect to :5353',rules)
        self.assertIn('fib daddr type local meta l4proto { tcp, udp } th dport 5353 accept',rules)
        init=(ROOT/'identity-portal/files/etc/init.d/portal').read_text()
        self.assertIn('--local=/#/',init); self.assertIn('--conf-file=/dev/null',init); self.assertIn('--interface="$PORTAL_LAN_DEV"',init)


    def test_concurrent_history_events_keep_every_mac(self):
        def observe(i):
            raw=json.dumps({'disassoc':{'address':f'02:00:00:00:01:{i:02X}'}})
            return self.execute([str(self.fs/'etc/portal/portal-observe'),'--event',raw])
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results=list(pool.map(observe,range(4)))
        self.assertTrue(all(r.returncode==0 for r in results))
        self.assertEqual(len((self.run/'history.tsv').read_text().splitlines()),4)

    def test_idle_sync_daemon_waits_for_explicit_service_stop(self):
        process=subprocess.Popen([str(self.fs/'etc/portal/portal-sync-unauth')],env=self.env,
                                 stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        try:
            time.sleep(0.3)
            self.assertIsNone(process.poll())
        finally:
            if process.poll() is None: os.killpg(process.pid,signal.SIGTERM)
            process.wait(timeout=3)


    def test_mac_index_reload_discards_removed_device(self):
        self.admin('split',self.mac,'示例')
        code='. "$PORTAL_LIB"; portal_load; portal_find_device "$1" || exit 2; uci delete "portal.dev_020000000001"; uci commit portal; portal_load; ! portal_find_device "$1"'
        result=self.execute([os.environ.get('PORTAL_TEST_SHELL','/bin/bash'),'-c',code,'test',self.mac])
        self.assertEqual(result.returncode,0,result.stderr)

    def test_identity_query_single_uci(self):
        self.admin('split',self.mac,'示例'); self.trace.write_text('')
        self.assertEqual(len(self.rpc('identities')['identities']),1)
        self.assertEqual(self.trace.read_text().splitlines().count('uci'),1)

    def test_html_escape(self):
        self.admin('setpage','<script>"&','提示 \\ / &')
        html=(self.base/'www/index.html').read_text()
        self.assertIn('&lt;script&gt;',html); self.assertNotIn('<script>',html)

    def test_nft_error_reported(self):
        (self.base/'nft-fail').touch()
        self.assertEqual(self.admin('block',self.mac,'','L1',ok=False)['error'],'E_NFT')

    def test_restore_last_restricted_device(self):
        self.admin('split',self.mac,'示例'); self.admin('setegress',self.mac,'wifi-only')
        self.admin('setegress',self.mac,'normal')
        self.assertNotIn('192.0.2.10', (self.run/'unauth-src.yaml').read_text())
        self.assertFalse((self.run/'ready-until').exists())

    def test_unblock_when_ap_offline(self):
        self.admin('block',self.mac,'','L2')
        (self.base/'wireless-status').write_text('{}')
        self.admin('unblock',self.mac)
        self.assertNotIn(self.mac,(self.config/'wireless').read_text())

    def test_registration_from_wrong_network(self):
        self.admin('register','192.0.2.99','示例',ok=False)
        (self.base/'wifi').write_text('{"clients":{}}')
        self.admin('register','192.0.2.10','示例',ok=False)
        self.assertEqual(self.rpc('devices')['devices'],[])

    def test_external_pending_change_rejected(self):
        self.uci('set','portal.page.title=外部待提交')
        self.assertEqual(self.admin('split',self.mac,'示例',ok=False)['error'],'E_CONFLICT')
        self.assertIn('外部待提交',self.uci('changes','portal'))

    def test_portal_load_clears_removed_option(self):
        self.uci('set','portal.global.test_option=旧值'); self.uci('commit','portal')
        r=self.execute([os.environ.get('PORTAL_TEST_SHELL','/bin/bash'),'-c', '. "$PORTAL_LIB"; portal_load; uci delete portal.global.test_option; uci commit portal; portal_load; config_get value global test_option 默认; printf "%s" "$value"'])
        self.assertEqual(r.stdout,'默认',r.stderr)


if __name__ == '__main__':
    unittest.main()
