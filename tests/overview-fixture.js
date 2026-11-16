'use strict';
// 浏览器隔离夹具：合成设备和 RPC，不访问真实路由器或改变网络。
window.createPortalOverviewFixture = function(source) {
	window.E = function(tag, attrs, children) {
		var node = document.createElement(tag);
		Object.keys(attrs || {}).forEach(function(key) {
			var value = attrs[key];
			if (typeof value === 'function') node.addEventListener(key, value);
			else if (value != null && value !== false) node.setAttribute(key, value === true ? '' : value);
		});
		function add(child) {
			if (Array.isArray(child)) child.forEach(add);
			else if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
		}
		add(children); return node;
	};
	var writes = [], currentStatus = { enabled: true, version: '0.1.3', nft: { auth_mac: 2 }, flow_offloading: true,
		flow_offloading_hw: true, offload_policy: 'allow', unauth_policy: 'drop', listen_8081: true, l2_support: true };
	var L = { bind: function(fn, target) { return fn.bind(target); } };
	var ui = {
		createHandlerFn: function(target, fn) { return typeof fn === 'string' ? target[fn].bind(target) : fn.bind(target); },
		showModal: function(title, nodes) { document.querySelector('#fixture-modal').replaceChildren(E('h3', {}, title), E('div', {}, nodes)); },
		hideModal: function() { document.querySelector('#fixture-modal').replaceChildren(); },
		addNotification: function() {}
	};
	var inventory;
	var rpc = { declare: function(spec) { return function() {
		var args = Array.from(arguments);
		if (spec.method === 'status') return Promise.resolve(currentStatus);
		if (spec.method === 'inventory') return Promise.resolve(inventory);
		if (spec.method === 'setoffload') { writes.push({ method: spec.method, args: args }); currentStatus = Object.assign({}, currentStatus, { offload_policy: args[0] }); return Promise.resolve({ ok: true }); }
		if (spec.method === 'audit') return Promise.resolve({ total: 0, lines: [] });
		writes.push({ method: spec.method, args: args }); return Promise.resolve({ ok: true });
	}; } };
	var impl = (new Function('view', 'dom', 'rpc', 'ui', 'poll', 'L', source))({ extend: function(x) { return x; } },
		{ create: E, content: function(node, children) { node.replaceChildren(); children.forEach(function(x) { node.append(x); }); } }, rpc, ui, { add: function() {} }, L);
	function device(n, state) {
		return { mac: '02:00:00:00:00:' + ('0' + n).slice(-2), vendor: '示例设备厂商', is_laa: true, hostname: '工作设备' + n,
			hostname_source: state === 'online' ? 'dhcp' : 'history', identity: 'id_00000001', identity_name: '示例身份', trusted: 0,
			policy: 'allow', egress: 'normal', label: '测试设备', note: '仅合成数据', state: 'registered', state_text: '正常上网',
			first_seen: '2026-11-16T10:00:00+08:00', first_observed: 1794794400, last_seen: 1794794400,
			online_state: state, online_way: state === 'online' ? 'wifi' : (state === 'unknown' ? 'unknown' : ''),
			ip: '192.0.2.' + n, ip_source: state === 'online' ? 'observed' : 'history', connected_s: 50, signal: -55,
			ipv6: state === 'online' ? [
				{ address: '2001:0db8:0000:0000:0000:0000:0000:0010', suffix: '0000:0000:0000:0010', kind: 'global' },
				{ address: 'fe80:0000:0000:0000:1234:5678:9abc:def0', suffix: '1234:5678:9abc:def0', kind: 'link-local' }
			] : [],
			ipv6_history: [
				{ address: '2001:0db8:0000:0000:0000:0000:0000:0010', suffix: '0000:0000:0000:0010', seen_at: 1794794400 },
				{ address: '2001:0db7:0000:0000:0000:0000:0000:0010', suffix: '0000:0000:0000:0010', seen_at: 1794794400 }
			], ipv6_candidates: [] };
	}
	var devices = [device(1, 'online'), device(2, 'offline')];
	var unknown = [device(3, 'online'), device(4, 'offline'), device(5, 'unknown')].map(function(x) {
		x.identity = ''; x.identity_name = ''; x.state = 'unregistered'; x.state_text = '仅允许登记及地址配置'; return x;
	});
	inventory = { devices: devices, unidentified: unknown };
	var identities = [{ id: 'id_00000001', name: '示例身份', note: '', created_at: '2026-11-16T10:00:00+08:00', device_count: 2, devices: devices.map(function(x) { return x.mac; }) }];
	var root = impl.render([currentStatus, { identities: identities }, inventory, { title: '设备身份门户', prompt: '请输入姓名' }, { lines: [], total: 0 }]);
	document.querySelector('#fixture-root').replaceChildren(root);
	window.portalFixture = { view: impl, writes: writes, inventory: inventory, status: currentStatus, device: device, ui: ui };
	window.runPortalOverviewTests = async function() {
		var results = [];
		function check(name, ok) { results.push({ name: name, ok: !!ok }); if (!ok) throw new Error(name); }
		var order = Array.from(root.querySelectorAll('[data-portal-section]')).map(function(x) { return x.dataset.portalSection; });
		check('八分区按指定顺序', order.join(',') === 'status,unidentified,identities,devices,history,audit,page,offload');
		check('顶部不再含卸载编辑控件', !impl.statusBarNode.querySelector('select'));
		check('底部含卸载编辑控件', !!impl.offloadSectionNode.querySelector('select'));
		check('在线池只包含确认在线', impl.unidentifiedTableNode.querySelectorAll('tr').length === 2 && impl.unidentifiedTableNode.textContent.includes(unknown[0].mac));
		check('历史池包含离线和未确认，不含在线', impl.historyTableNode.querySelectorAll('tr').length === 3 && !impl.historyTableNode.textContent.includes(unknown[0].mac));
		check('登记表合并为九列', impl.devicesTableNode.querySelectorAll('th').length === 9 && impl.devicesTableNode.querySelectorAll('tr')[1].children.length === 9);
		var row = impl.devicesTableNode.querySelectorAll('tr')[1];
		check('厂商和随机标记在 MAC 同一单元格下方', row.children[0].textContent.includes('示例设备厂商') && row.children[0].textContent.includes('随机 MAC'));
		check('两条当前 IPv6 直接逐行显示', row.querySelectorAll('.portal-ipv6-current').length === 2 && row.textContent.includes('2001:db8::10') && row.textContent.includes('fe80::1234:5678:9abc:def0'));
		check('历史地址不重复当前地址', row.querySelectorAll('.portal-ipv6-history').length === 1 && row.querySelector('.portal-ipv6-history .portal-address-value').textContent === '2001:db7::10');
		var network = row.children[7];
		check('合并网络列含状态、IPv4和双栈标签', network.textContent.includes('在线(Wi-Fi)') && network.textContent.includes('192.0.2.1') && network.textContent.includes('历史 IPv6'));
		check('IPv6 展开压缩和最长零组选择', impl.formatIPv6('0000:0000:0000:0000:0000:0000:0000:0001') === '::1' && impl.formatIPv6('2001:0db8:0000:0000:0001:0000:0000:0002') === '2001:db8::1:0:0:2');
		check('异常地址显示为文本而非解释', impl.formatIPv6('<img>') === '<img>');
		var bad = device(9, 'online'); bad.hostname = '<img src=x onerror=alert(1)>'; bad.vendor = '<script>测试</script>';
		var badRow = impl.renderDeviceRow(bad);
		check('主机名和厂商 HTML 不执行', !badRow.querySelector('img,script') && badRow.textContent.includes('<img'));
		row.querySelector('.portal-table-ops button:last-child').click();
		var first = document.querySelectorAll('#fixture-modal button').length; ui.hideModal(); row.querySelector('.portal-table-ops button:last-child').click();
		check('更多操作可重复打开', first >= 5 && document.querySelectorAll('#fixture-modal button').length === first); ui.hideModal();
		row.querySelector('.portal-address-details').click();
		check('IPv6 后缀时间详情仍可查看', document.querySelector('#fixture-modal').textContent.includes('0000:0000:0000:0010')); ui.hideModal();
		impl.offloadSectionNode.querySelector('select').value = 'require-off';
		impl.applyStatus(Object.assign({}, currentStatus, { nft: { auth_mac: 3 } }));
		check('周期状态更新保留底部未保存选择', impl.offloadSectionNode.querySelector('select').value === 'require-off');
		impl.offloadSectionNode.querySelector('button').click(); await new Promise(function(resolve) { setTimeout(resolve, 0); });
		check('卸载保存仍走原 RPC', writes.length === 1 && writes[0].method === 'setoffload' && writes[0].args[0] === 'require-off');
		check('保存后按后端配置刷新', impl.offloadSectionNode.querySelector('select').value === 'require-off');
		impl.applyInventory({ devices: devices, unidentified: [] });
		check('两个未识别空表列数正确', impl.unidentifiedTableNode.querySelector('[colspan]').colSpan === 7 && impl.historyTableNode.querySelector('[colspan]').colSpan === 7);
		impl.applyInventory(inventory); impl.deviceSearchText = '不匹配'; impl.updateDevicesTableRows();
		check('登记空表跨九列', impl.devicesTableNode.querySelector('[colspan]').colSpan === 9);
		impl.deviceSearchText = '工作设备'; impl.setDeviceFilter('all');
		check('切换筛选保留搜索输入', impl.devicesSectionNode.querySelector('input').value === '工作设备');
		impl.deviceSearchText = ''; impl.updateDevicesTableRows();
		impl.deviceSearchText = '2001:db8::10'; impl.updateDevicesTableRows();
		check('按页面压缩 IPv6 可搜索', impl.devicesTableNode.querySelectorAll('tr').length === 3);
		impl.deviceSearchText = ''; impl.updateDevicesTableRows();
		var moved = Object.assign({}, unknown[0], { online_state: 'offline', online_way: '' });
		impl.applyInventory({ devices: devices, unidentified: [moved, unknown[1], unknown[2]] });
		check('断开后由在线池移入历史，不重复展示', impl.unidentifiedTableNode.querySelectorAll('tr').length === 2 && !!impl.unidentifiedTableNode.querySelector('[colspan]') && impl.historyTableNode.querySelectorAll('tr').length === 4);
		impl.applyInventory(inventory);
		row = impl.devicesTableNode.querySelectorAll('tr')[1];
		check('历史默认折叠但保留数量', !row.querySelector('details').open && row.querySelector('summary').textContent.includes('1'));
		check('折叠历史不占布局空间', row.querySelector('.portal-ipv6-history').getBoundingClientRect().height === 0);
		var disclosure = row.querySelector('details'); disclosure.open = true;
		await new Promise(function(resolve) { setTimeout(resolve, 0); });
		check('展开后历史可见且当前地址不隐藏', row.querySelector('.portal-ipv6-history').getBoundingClientRect().height > 0 && row.querySelectorAll('.portal-ipv6-current').length === 2);
		impl.applyInventory(inventory); await new Promise(function(resolve) { setTimeout(resolve, 0); });
		row = impl.devicesTableNode.querySelectorAll('tr')[1];
		check('周期刷新保留历史展开', row.querySelector('details').open);
		row.querySelector('details').open = false; await new Promise(function(resolve) { setTimeout(resolve, 0); }); impl.applyInventory(inventory);
		await new Promise(function(resolve) { setTimeout(resolve, 0); }); row = impl.devicesTableNode.querySelectorAll('tr')[1];
		check('周期刷新保留主动收起', !row.querySelector('details').open);
		var beforeWrites = writes.length;
		row.querySelector('.portal-mac-button').click();
		check('点击 MAC 可查看完整时间和备注', document.querySelector('#fixture-modal').textContent.includes('2026-11-16') && document.querySelector('#fixture-modal').textContent.includes('仅合成数据'));
		check('只读详情不调用写接口', writes.length === beforeWrites); ui.hideModal();
		row.querySelector('.portal-note-preview').click();
		check('备注摘要可打开完整内容', document.querySelector('#fixture-modal').textContent.includes('仅合成数据')); ui.hideModal();
		var long = device(8, 'online'); long.note = '长备注'.repeat(80);
		long.ipv6_history = Array.from({ length: 16 }, function(_, i) { return { address: '2001:db7::' + (i + 1).toString(16), suffix: '', seen_at: 1794794400 }; });
		var longRow = impl.renderDeviceRow(long); impl.devicesTableNode.appendChild(longRow);
		check('16 条历史默认折叠不会撑高行', !longRow.querySelector('details').open && longRow.getBoundingClientRect().height < 150);
		check('长备注摘要至多两行', longRow.querySelector('.portal-note-preview').getBoundingClientRect().height < 40);
		longRow.querySelector('.portal-note-preview').click();
		check('长备注原文在详情完整保留', document.querySelector('#fixture-modal').textContent.includes(long.note)); ui.hideModal(); longRow.remove();
		var multiple = device(7, 'online'); multiple.ipv6 = multiple.ipv6.concat(multiple.ipv6.map(function(x) { return Object.assign({}, x, { address: x.address.replace('0010', '0011').replace('def0', 'def1') }); }));
		var multipleRow = impl.renderDeviceRow(multiple); impl.devicesTableNode.appendChild(multipleRow);
		check('四条当前 IPv6 均直接可见', multipleRow.querySelectorAll('.portal-ipv6-current').length === 4 && Array.from(multipleRow.querySelectorAll('.portal-ipv6-current')).every(function(x) { return x.getBoundingClientRect().height > 0; })); multipleRow.remove();
		impl.expandedHistory['已不在快照'] = true; impl.applyInventory(inventory);
		check('已删除设备展开状态被清理', !impl.expandedHistory['已不在快照']);
		window.portalOverviewTestResults = results; return results;
	};
};
