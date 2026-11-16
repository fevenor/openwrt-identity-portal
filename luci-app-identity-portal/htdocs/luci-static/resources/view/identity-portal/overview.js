'use strict';
'require view';
'require dom';
'require poll';
'require rpc';
'require ui';

/*
 * 设备身份门户 (luci-app-identity-portal) 主视图
 * 纯客户端 JS 视图，所有数据与写操作均经由 rpcd portal 对象
 */

// 安全获取全局 dom.create (E) 辅助函数
var E = (typeof window.E === 'function') ? window.E : dom.create;

// =========================================================================
// =========================================================================

// 1. 系统与状态类
var callPortalStatus = rpc.declare({
	object: 'portal',
	method: 'status',
	expect: {}
});

var callPortalConfig = rpc.declare({
	object: 'portal',
	method: 'config',
	expect: {}
});

// 2. 同一快照返回登记表与历史未识别池，避免重复采集。
var callPortalInventory = rpc.declare({ object: 'portal', method: 'inventory', expect: {} });

// 兼容原有独立接口
var callPortalUnidentified = rpc.declare({
	object: 'portal',
	method: 'unidentified',
	expect: {}
});

// 3. 注册表全量设备
var callPortalDevices = rpc.declare({
	object: 'portal',
	method: 'devices',
	expect: {}
});

// 4. 身份列表
var callPortalIdentities = rpc.declare({
	object: 'portal',
	method: 'identities',
	expect: {}
});

// 5. 审计日志 (tail, offset, grep)
var callPortalAudit = rpc.declare({
	object: 'portal',
	method: 'audit',
	params: ['tail', 'offset', 'grep'],
	expect: {}
});

// 6. 门户文案读写
var callPortalPage = rpc.declare({
	object: 'portal',
	method: 'page',
	expect: {}
});

var callPortalSetpage = rpc.declare({
	object: 'portal',
	method: 'setpage',
	params: ['title', 'prompt'],
	expect: {}
});

var callPortalSetenabled = rpc.declare({
	object: 'portal',
	method: 'setenabled',
	params: ['enabled'],
	expect: {}
});

var callPortalSetoffload = rpc.declare({
	object: 'portal',
	method: 'setoffload',
	params: ['policy'],
	expect: {}
});

// 7. 身份写方法
var callPortalRename = rpc.declare({
	object: 'portal',
	method: 'rename',
	params: ['id', 'name'],
	expect: {}
});

var callPortalMerge = rpc.declare({
	object: 'portal',
	method: 'merge',
	params: ['src_id', 'dst_id'],
	expect: {}
});

var callPortalSplit = rpc.declare({
	object: 'portal',
	method: 'split',
	params: ['mac', 'new_name'],
	expect: {}
});

var callPortalDelete = rpc.declare({
	object: 'portal',
	method: 'delete',
	params: ['id'],
	expect: {}
});

var callPortalSetidentity = rpc.declare({
	object: 'portal',
	method: 'setidentity',
	params: ['id', 'note'],
	expect: {}
});

// 8. 黑名单写方法
var callPortalBlock = rpc.declare({
	object: 'portal',
	method: 'block',
	params: ['mac', 'reason', 'level'],
	expect: {}
});

var callPortalUnblock = rpc.declare({
	object: 'portal',
	method: 'unblock',
	params: ['mac'],
	expect: {}
});

// 9. 设备管理写方法 (白名单、身份指派、设备属性)
var callPortalWhitelist = rpc.declare({
	object: 'portal',
	method: 'whitelist',
	params: ['mac', 'trusted'],
	expect: {}
});

var callPortalAssign = rpc.declare({
	object: 'portal',
	method: 'assign',
	params: ['mac', 'identity'],
	expect: {}
});

var callPortalSetdevice = rpc.declare({
	object: 'portal',
	method: 'setdevice',
	params: ['mac', 'label', 'note'],
	expect: {}
});

var callPortalForget = rpc.declare({
	object: 'portal',
	method: 'forget',
	params: ['mac'],
	expect: {}
});

var callPortalSetegress = rpc.declare({
	object: 'portal',
	method: 'setegress',
	params: ['mac', 'egress'],
	expect: {}
});

// =========================================================================
// 视图主体实现
// =========================================================================

return view.extend({
	// 页面缓存数据
	portalStatus: null,
	identitiesList: [],
	devicesList: [],
	unidentifiedList: [],
	pageConfig: null,
	deviceFilter: 'all',
	inventoryPromise: null,
	expandedHistory: {},
	deviceSearchText: '',
	auditTailCount: 200,
	auditGrepText: '',
	pollFn: null,

	// 禁用 LuCI 默认的底部 CBI 提交按钮栏
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	// ---------------------------------------------------------------------
	// 工具函数：格式化与人读展示
	// ---------------------------------------------------------------------

	// 格式化时间为 YYYY-MM-DD HH:mm:ss
	formatTime: function(isoStr) {
		if (!isoStr) return '-';
		var d = new Date(isoStr);
		if (isNaN(d.getTime())) return String(isoStr);
		var pad = function(n) { return (n < 10 ? '0' : '') + n; };
		return d.getFullYear() + '-' +
			pad(d.getMonth() + 1) + '-' +
			pad(d.getDate()) + ' ' +
			pad(d.getHours()) + ':' +
			pad(d.getMinutes()) + ':' +
			pad(d.getSeconds());
	},

	// 格式化秒数为时分秒
	formatDuration: function(seconds) {
		if (seconds == null || isNaN(seconds)) return '-';
		var s = Math.floor(seconds);
		if (s < 60) return s + '秒';
		var m = Math.floor(s / 60);
		s = s % 60;
		if (m < 60) return m + '分' + (s > 0 ? (s + '秒') : '');
		var h = Math.floor(m / 60);
		m = m % 60;
		if (h < 24) return h + '小时' + (m > 0 ? (m + '分') : '');
		var d = Math.floor(h / 24);
		h = h % 24;
		return d + '天' + (h > 0 ? (h + '小时') : '') + (m > 0 ? (m + '分') : '');
	},

	// 格式化 WiFi 信号
	formatSignal: function(signal) {
		if (signal == null || isNaN(signal)) return E('span', { 'class': 'portal-signal-na' }, '-');
		var sig = parseInt(signal, 10);
		var colorClass = 'portal-signal-good';
		if (sig < -75) {
			colorClass = 'portal-signal-bad';
		} else if (sig < -65) {
			colorClass = 'portal-signal-medium';
		}
		return E('span', { 'class': colorClass }, sig + ' dBm');
	},

	// 渲染出口状态三态 Badge
	renderStateTextBadge: function(stateText) {
		var text = stateText || '未知状态';
		var badgeClass = 'portal-badge portal-badge-neutral';
		if (text === '仅允许登记及地址配置') {
			badgeClass = 'portal-badge portal-badge-warning';
		} else if (text.indexOf('指定出口已就绪') === 0) {
			badgeClass = 'portal-badge portal-badge-info';
		} else if (text === '阻断(同步中/故障)') {
			badgeClass = 'portal-badge portal-badge-danger';
		}
		return E('span', { 'class': badgeClass }, text);
	},

	// 通知辅助方法：自动消失 + 统一出口（挂载在 view 对象上）
	notify: function(msg, type) {
		ui.addNotification(null, E('p', {}, msg), type || 'info');
		// 自动消失（error 常驻，供手动忽略）
		if (type === 'error') return;
		var delay = (type === 'warning') ? 8000 : 4000;
		// 依据实证：luci-base 26.159.10282 ui.js 中 addNotification 执行 mc.insertBefore(msg, mc.firstElementChild)
		// 新通知始终插入为 #maincontent (或 body) 的第一个子节点，因此 querySelectorAll 后必须取首项 nodes[0]
		var nodes = document.querySelectorAll('#maincontent > .alert-message, body > .alert-message');
		var el = nodes[0]; // 新插入的通知位于容器最前端
		if (el) window.setTimeout(function() {
			el.classList.add('fade-out');
			window.setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 500);
		}, delay);
	},

	// 统一处理 RPC 返回结果或捕获的异常
	checkRpcResult: function(res, defaultSuccessMsg) {
		if (!res) {
			this.notify('未收到后端响应', 'error');
			return false;
		}
		if (res instanceof Error || res.error) {
			var errMsg = res.message || ('操作失败: ' + (res.error || '网络异常'));
			this.notify(errMsg, 'error');
			return false;
		}
		if (defaultSuccessMsg && res.ok !== true) {
			this.notify('操作未确认成功，请刷新状态后重试', 'error');
			return false;
		}
		if (defaultSuccessMsg) {
			this.notify(defaultSuccessMsg, 'info');
		}
		return true;
	},

	// ---------------------------------------------------------------------
	// 数据加载 (初始)
	// ---------------------------------------------------------------------
	load: function() {
		// 通知淡出样式在视图初始化时注入一次。
		if (!document.getElementById('portal-notif-fix')) {
			document.head.appendChild(E('style', { 'id': 'portal-notif-fix' },
				'.alert-message.fade-out{animation:portalFadeOut .4s ease forwards;pointer-events:none}' +
				'@keyframes portalFadeOut{to{opacity:0}}'
			));
		}

		var self = this;
		return Promise.all([
			callPortalStatus().catch(function(e) { return { error: 'E_RPC', message: String(e) }; }),
			callPortalIdentities().catch(function(e) { return { error: 'E_RPC', message: String(e) }; }),
			callPortalInventory().catch(function(e) { return { error: 'E_RPC', message: String(e) }; }),
			callPortalPage().catch(function(e) { return { error: 'E_RPC', message: String(e) }; }),
			callPortalAudit(self.auditTailCount, 0, '').catch(function(e) { return { error: 'E_RPC', message: String(e) }; })
		]);
	},

	// ---------------------------------------------------------------------
	// 主页面渲染
	// ---------------------------------------------------------------------
	render: function(data) {
		data.forEach(function(res) { this.checkRpcResult(res); }, this);
		this.portalStatus = data[0] || {};
		this.identitiesList = (data[1] && Array.isArray(data[1].identities)) ? data[1].identities : [];
		this.devicesList = (data[2] && Array.isArray(data[2].devices)) ? data[2].devices : [];
		this.unidentifiedList = (data[2] && Array.isArray(data[2].unidentified)) ? data[2].unidentified : [];
		this.pageConfig = data[3] || { title: '', prompt: '' };
		this.auditData = data[4] || { lines: [], total: 0 };

		var viewRoot = E('div', { 'class': 'portal-container' });

		// 1. 注入轻量内嵌样式，保证各 LuCI 主题下的现代美观排版
		viewRoot.appendChild(this.renderCustomStyles());

		// 2. 页面标题与简述
		viewRoot.appendChild(E('h2', { 'class': 'portal-title' }, '设备身份门户'));
		viewRoot.appendChild(E('p', { 'class': 'portal-desc' },
			'登记设备归属，管理免登记白名单、黑名单及可选出口策略。姓名为自助填写，不代表真实身份认证。'
		));

		// 3. 顶部状态条区块
		this.statusBarNode = this.renderStatusBar();
		viewRoot.appendChild(this.statusBarNode);

		// 常用信息在前，低频配置在底部；在线池与离线历史同一快照分组。
		this.unidentifiedSectionNode = this.renderUnidentifiedSection(false);
		viewRoot.appendChild(this.unidentifiedSectionNode);
		this.identitiesSectionNode = this.renderIdentitiesSection();
		viewRoot.appendChild(this.identitiesSectionNode);
		this.devicesSectionNode = this.renderDevicesSection();
		viewRoot.appendChild(this.devicesSectionNode);
		this.historySectionNode = this.renderUnidentifiedSection(true);
		viewRoot.appendChild(this.historySectionNode);
		this.auditSectionNode = this.renderAuditSection();
		viewRoot.appendChild(this.auditSectionNode);
		this.pageConfigSectionNode = this.renderPageConfigSection();
		viewRoot.appendChild(this.pageConfigSectionNode);
		this.offloadSectionNode = this.renderOffloadSection();
		viewRoot.appendChild(this.offloadSectionNode);

		// -----------------------------------------------------------------
		// 注册 15 秒自动轮询（设备、历史池和状态），页面隐藏时暂停
		// -----------------------------------------------------------------
		this.pollFn = L.bind(function() {
			if (document.hidden) {
				return Promise.resolve();
			}
			return this.refreshUnidentifiedPool(true);
		}, this);
		poll.add(this.pollFn, 15);

		// 监听可见性变更，恢复可见时即刻拉取一次
		document.addEventListener('visibilitychange', L.bind(function() {
			if (!document.hidden) {
				this.refreshUnidentifiedPool(true);
			}
		}, this));

		return viewRoot;
	},

	wrapTable: function(table) { return E('div', { 'class': 'portal-table-scroll', 'tabindex': 0, 'aria-label': '设备表格，可横向滚动' }, table); },
	formatObserved: function(epoch) { return epoch > 0 ? this.formatTime(new Date(epoch * 1000).toISOString()) : '未记录'; },
	renderOnline: function(dev) {
		var text = '离线', cls = 'neutral';
		if (dev.online_way === 'wifi') { text = '在线(Wi-Fi)'; cls = 'success'; }
		else if (dev.online_way === 'lan') { text = '在线(有线近期活动)'; cls = 'info'; }
		else if (dev.online_way === 'unknown') { text = '状态未确认'; cls = 'warning'; }
		return E('span', { 'class': 'portal-badge portal-badge-' + cls }, text);
	},
	compactOperations: function(ops, dev) {
		var first = ops.firstChild;
		var group = E('div', { 'class': 'portal-table-ops portal-table-compact' }, first);
		var actions = Array.from(ops.children);
		group.appendChild(E('button', { 'class': 'btn cbi-button', 'click': function() {
			ui.showModal('设备操作 ' + dev.mac, [E('p', {}, '操作针对此 MAC，离线也可管理。观察历史不等于准入授权。'),
				E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:8px;margin:16px 0;' }, actions),
				E('button', { 'class': 'btn', 'click': ui.hideModal }, '关闭')]);
		} }, '更多操作'));
		return group;
	},
	renderMac: function(dev) {
		var self = this;
		var nodes = [E('button', { 'type': 'button', 'class': 'portal-tag-mac portal-mac-button', 'title': '查看完整设备信息',
			'aria-label': '查看设备 ' + dev.mac + ' 的完整信息', 'click': function() { self.showDeviceInfo(dev); } }, (dev.mac || '').toUpperCase()),
			E('small', { 'class': 'portal-vendor' }, dev.vendor || '未知厂商')];
		if (dev.is_laa) nodes.push(E('span', { 'class': 'portal-badge portal-badge-warning', 'title': '本地管理地址，可能是随机 MAC；不是厂商标识' }, '随机 MAC / LAA'));
		return E('div', { 'class': 'portal-mac-info' }, nodes);
	},
	formatIPv6: function(address) {
		// 仅压缩后端已规范化的八组十六进制，保留原值用于复制、搜索和详情。
		var groups = String(address || '').split(':');
		if (groups.length !== 8 || groups.some(function(x) { return !/^[0-9a-f]{1,4}$/i.test(x); })) return String(address || '');
		groups = groups.map(function(x) { return parseInt(x, 16).toString(16); });
		var start = -1, length = 1;
		for (var i = 0; i < groups.length;) {
			if (groups[i] !== '0') { i++; continue; }
			var end = i; while (end < groups.length && groups[end] === '0') end++;
			if (end - i > length) { start = i; length = end - i; }
			i = end;
		}
		return start < 0 ? groups.join(':') : groups.slice(0, start).join(':') + '::' + groups.slice(start + length).join(':');
	},
	showDeviceInfo: function(dev) {
		var self = this, current = dev.ipv6 || [], history = dev.ipv6_history || [], conflicts = dev.ipv6_candidates || [];
		var values = [
			['主机名', (dev.hostname || '未记录') + (dev.hostname_source === 'history' ? '（历史记录）' : '')],
			['厂商 / MAC 类型', (dev.vendor || '未知厂商') + (dev.is_laa ? '；本地管理 / 随机 MAC' : '')],
			['归属身份', dev.identity_name || '未指派'], ['标签', dev.label || '—'], ['备注', dev.note || '—'],
			['登记时间', self.formatTime(dev.first_seen)], ['首次观察', self.formatObserved(dev.first_observed)],
			['最近观察', self.formatObserved(dev.last_seen)], ['封禁原因', dev.block_reason || '—']
		];
		var rows = [E('dl', { 'class': 'portal-info-list' }, values.map(function(x) { return E('div', {}, [E('dt', {}, x[0]), E('dd', {}, x[1])]); })),
			E('p', {}, 'IPv6 后缀为低 64 位，仅作辅助查找，不能自动确认身份或授予访问。')];
		current.forEach(function(x) { rows.push(E('p', {}, ['当前邻居：' + x.address, E('br'), '后缀：' + x.suffix + '（' + x.kind + '）'])); });
		history.forEach(function(x) { rows.push(E('p', {}, ['历史：' + x.address, E('br'), '后缀：' + x.suffix + '；观察：' + self.formatObserved(x.seen_at)])); });
		conflicts.forEach(function(x) { rows.push(E('p', { 'class': 'portal-ipv6-conflict' }, '后缀冲突：' + x.address + ' 当前属于 ' + x.mac + '，未自动关联')); });
		rows.push(E('button', { 'class': 'btn', 'click': ui.hideModal }, '关闭'));
		ui.showModal('设备信息 · ' + dev.mac, E('div', { 'class': 'portal-device-info' }, rows));
	},
	renderNote: function(dev) {
		var self = this, text = [dev.label, dev.note, dev.block_reason ? '封禁：' + dev.block_reason : ''].filter(Boolean).join(' · ');
		return text ? E('button', { 'type': 'button', 'class': 'portal-note-preview', 'title': text, 'aria-label': '查看完整标签和备注',
			'click': function() { self.showDeviceInfo(dev); } }, text) : E('span', { 'class': 'portal-muted' }, '—');
	},
	renderObservedTimes: function(dev) {
		var self = this;
		function line(label, value) {
			var valid = value && value !== '未记录' && value !== '-';
			return E('div', { 'class': 'portal-time-line', 'title': label + '：' + (value || '未记录') }, [
				E('span', { 'class': 'portal-muted' }, label + ' '), E('span', {}, valid ? value.slice(5, 16) : '未记录')]);
		}
		return E('div', { 'class': 'portal-time-summary' }, [line('登记', self.formatTime(dev.first_seen)), line('最近', self.formatObserved(dev.last_seen))]);
	},
	renderAddresses: function(dev) {
		var self = this, live = dev.ip_source === 'observed';
		var current = dev.ipv6 || [], history = dev.ipv6_history || [], conflicts = dev.ipv6_candidates || [], known = {};
		current.forEach(function(x) { known[self.formatIPv6(x.address)] = true; });
		var past = history.filter(function(x) { return !known[self.formatIPv6(x.address)]; });
		var node = E('div', { 'class': 'portal-addresses' }, [this.renderOnline(dev)]);
		function addressLine(family, address, attrs) {
			return E('div', Object.assign({ 'class': 'portal-address-line' }, attrs || {}), [
				E('span', { 'class': 'portal-family-label' }, family), E('span', { 'class': 'portal-address-value' }, address)]);
		}
		node.appendChild(addressLine('IPv4', dev.ip || '未记录', { 'class': 'portal-address-line' + (live ? '' : ' portal-address-cached'),
			'title': live ? '当前观察 IPv4' : '最后记录 IPv4（不表示当前在线）' }));
		current.forEach(function(x) {
			node.appendChild(addressLine('IPv6', self.formatIPv6(x.address), { 'class': 'portal-address-line portal-ipv6-current',
				'title': x.address + '；后缀：' + x.suffix + '（' + x.kind + '）' }));
		});
		var footer = E('div', { 'class': 'portal-address-footer' });
		if (past.length) {
			var key = dev.mac;
			var details = E('details', { 'class': 'portal-history-disclosure', 'open': this.expandedHistory[key] ? '' : null }, [
				E('summary', { 'aria-label': '展开历史 IPv6 地址 ' + past.length + ' 条' }, '历史 IPv6 · ' + past.length),
				E('div', { 'class': 'portal-history-addresses' }, past.map(function(x) {
					return addressLine('IPv6', self.formatIPv6(x.address), { 'class': 'portal-address-line portal-ipv6-history',
						'title': x.address + '；观察时间：' + self.formatObserved(x.seen_at) });
				}))
			]);
			// 记录前端展开状态；自动更新时不把用户正在看的历史收起。
			details.addEventListener('toggle', function() { if (details.isConnected) self.expandedHistory[key] = details.open; });
			footer.appendChild(details);
		}
		if (current.length || history.length || conflicts.length) footer.appendChild(E('button', {
			'type': 'button', 'class': 'portal-address-details portal-text-action', 'title': '查看完整地址、后缀和观察时间',
			'click': function() { self.showDeviceInfo(dev); }
		}, '详情'));
		if (footer.childNodes.length) node.appendChild(footer);
		if (conflicts.length) node.appendChild(E('small', { 'class': 'portal-ipv6-conflict' }, '后缀冲突 · ' + conflicts.length + '，未关联'));
		return node;
	},
	applyInventory: function(res) {
		this.devicesList = Array.isArray(res.devices) ? res.devices : [];
		this.unidentifiedList = Array.isArray(res.unidentified) ? res.unidentified : [];
		var active = {}; this.devicesList.concat(this.unidentifiedList).forEach(function(dev) { active[dev.mac] = true; });
		Object.keys(this.expandedHistory).forEach(function(key) { if (!active[key]) delete this.expandedHistory[key]; }, this);
		this.updateDevicesTableRows(); this.updateUnidentifiedTableRows();
	},
	applyStatus: function(status, preserveDraft) {
		if (!this.statusBarNode || (preserveDraft !== false && JSON.stringify(this.portalStatus) === JSON.stringify(status))) return;
		var select = this.offloadSectionNode && this.offloadSectionNode.querySelector('select');
		var draft = select && select.value;
		this.portalStatus = status;
		var node = this.renderStatusBar(); this.statusBarNode.replaceWith(node); this.statusBarNode = node;
		if (this.offloadSectionNode) {
			var settings = this.renderOffloadSection(); this.offloadSectionNode.replaceWith(settings); this.offloadSectionNode = settings;
			if (preserveDraft !== false && draft != null) settings.querySelector('select').value = draft;
		}
	},

	// =====================================================================
	// 样式注入
	// =====================================================================
	renderCustomStyles: function() {
		var css = `
			/* 设备行采用紧凑层级：当前地址直接显示，低频历史主动展开。 */
			.portal-container .portal-addresses { line-height: 1.4; }
			.portal-container .portal-address-line { display: flex; gap: 5px; align-items: baseline; margin-top: 2px; }
			.portal-container .portal-family-label { flex: 0 0 28px; color: #64748b; font-size: 10px; }
			.portal-container .portal-address-line .portal-address-value { min-width: 0; font-size: 12px; }
			.portal-container .portal-address-cached .portal-address-value { color: #64748b; }
			.portal-container .portal-address-footer { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; margin-top: 3px; }
			.portal-container .portal-history-disclosure { min-width: 0; max-width: 100%; }
			.portal-container .portal-history-disclosure[open] { flex-basis: 100%; }
			.portal-container .portal-history-disclosure:not([open]) .portal-history-addresses { display: none; }
			.portal-container .portal-history-disclosure summary { color: #526483; font-size: 11px; cursor: pointer; padding: 2px 0; }
			.portal-container .portal-text-action,
			.portal-container .portal-note-preview { appearance: none; background: transparent; border: 0; box-shadow: none; color: var(--primary, #5267c4); cursor: pointer; }
			.portal-container .portal-addresses .portal-text-action { font-size: 11px; line-height: 16px; min-height: 20px; padding: 2px 0; margin: 0; }
			.portal-container .portal-note-preview { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; width: 100%; height: auto; min-height: 24px; padding: 0; line-height: 1.4; font-size: 12px; text-align: left; }
			.portal-container .portal-muted { color: #64748b; font-size: 11px; }
			.portal-container .portal-host-name { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
			.portal-container .portal-host-info small { display: block; margin-top: 2px; }
			.portal-container .portal-time-line { font-size: 11px; line-height: 1.6; white-space: normal; }
			.portal-container .portal-mac-button { appearance: none; height: auto; min-height: 24px; line-height: 1.4; cursor: pointer; text-align: left; }
			.portal-container button:focus-visible,
			.portal-container summary:focus-visible { outline: 2px solid var(--primary, #5267c4); outline-offset: 2px; }
			.portal-container .portal-text-action:hover,
			.portal-container .portal-mac-button:hover { text-decoration: underline; }
			.portal-container .portal-table-scroll table.portal-devices-table .tr .td { padding: 7px 6px; text-align: left; }
			.portal-container .portal-devices-table .tr:not(.table-titles):hover { background-color: rgba(94,114,228,.055); }
			.portal-device-info { overflow-wrap: anywhere; }
			.portal-info-list > div { display: grid; grid-template-columns: 88px minmax(0,1fr); gap: 8px; margin-bottom: 7px; }
			.portal-info-list dt { color: #64748b; font-size: 12px; }
			.portal-info-list dd { margin: 0; white-space: pre-wrap; }

			/* 样式限定在门户内；窄屏保持表头，横向滚动只发生在表格容器。 */
			.portal-container { min-width: 0; max-width: 100%; }
			.portal-container .portal-table-scroll { max-width: 100%; overflow-x: auto; }
			.portal-container .portal-table-scroll table.table { display: table; width: 100%; min-width: 0; table-layout: fixed; overflow: visible; }
			.portal-container .portal-table-scroll table.table .tr { display: table-row; }
			.portal-container .portal-table-scroll table.table .td,
			.portal-container .portal-table-scroll table.table .th { display: table-cell; vertical-align: middle; white-space: normal; }
			.portal-container .portal-table-scroll .td { padding: 10px 6px; max-width: 220px; overflow-wrap: anywhere; }
			.portal-container .portal-table-ops { display: flex; flex-wrap: wrap; gap: 5px; justify-content: flex-end; min-width: 0; }
			.portal-container .portal-table-compact { flex-direction: column; align-items: stretch; }
			.portal-container .portal-table-compact button { padding: 4px 6px; font-size: 12px; width: 100%; box-sizing: border-box; }
			.portal-container .portal-table-ops button { margin: 0; height: auto; min-height: 32px; white-space: nowrap; }
			.portal-container .portal-tag-mac { white-space: normal; overflow-wrap: anywhere; }
			.portal-container .portal-header-row { flex-wrap: wrap; gap: 8px; }
			.portal-container .portal-header-row h3 { width: auto; }
			.portal-container .portal-filter-bar input { min-width: 0 !important; max-width: 100%; }
			.portal-container .portal-addresses { min-width: 0; max-width: 100%; text-align: left; }
			.portal-container .portal-addresses small { display: block; color: #6b7280; }
			.portal-container .portal-addresses button { padding: 2px 6px; height: auto; }
			.portal-container .portal-address-label { margin-top: 5px; }
			.portal-container .portal-address-value { font-family: monospace; font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
			.portal-container .portal-address-none { color: #9ca3af; font-size: 11px; }
			.portal-container .portal-ipv6-history { color: #6b7280; }
			.portal-container .portal-ipv6-conflict { color: #b91c1c; }
			.portal-container .portal-address-details { margin-top: 6px; }
			.portal-container .portal-devices-table .portal-badge { padding: 2px 4px; font-size: 11px; }
			.portal-container [data-portal-section="audit"] .portal-header-row > div:last-child { flex-wrap: wrap; max-width: 100%; }
			.portal-container [data-portal-section="audit"] input { min-width: 0; max-width: 100%; }
			.portal-container .portal-vendor { display: block; color: #6b7280; margin: 5px 0; }
			.portal-container .portal-tag-mac { padding: 2px 3px; font-size: 11px; }
			.portal-container .portal-devices-table .th:nth-child(1) { width: 15%; }
			.portal-container .portal-devices-table .th:nth-child(2) { width: 9%; }
			.portal-container .portal-devices-table .th:nth-child(3) { width: 7%; }
			.portal-container .portal-devices-table .th:nth-child(4) { width: 7%; }
			.portal-container .portal-devices-table .th:nth-child(5) { width: 9%; }
			.portal-container .portal-devices-table .th:nth-child(6) { width: 8%; }
			.portal-container .portal-devices-table .th:nth-child(7) { width: 12%; }
			.portal-container .portal-devices-table .th:nth-child(8) { width: 23%; }
			.portal-container .portal-devices-table .th:nth-child(9) { width: 10%; }
			.portal-container .portal-pool-table .th:nth-child(1) { width: 17%; }
			.portal-container .portal-pool-table .th:nth-child(2) { width: 11%; }
			.portal-container .portal-pool-table .th:nth-child(3) { width: 28%; }
			.portal-container .portal-pool-table .th:nth-child(4) { width: 10%; }
			.portal-container .portal-pool-table .th:nth-child(5) { width: 14%; }
			.portal-container .portal-pool-table .th:nth-child(6) { width: 10%; }
			.portal-container .portal-pool-table .th:nth-child(7) { width: 10%; }
			@media (max-width: 900px) { .portal-container .portal-table-scroll table.table { min-width: 860px; } }
			@media (min-width: 901px) { .portal-container .portal-table-scroll .th { font-size: 12px; padding: 8px 4px; } }

			@media (max-width: 600px) { .portal-container .portal-filter-bar > div { width: 100%; margin-left: 0 !important; } }

			.portal-container { margin-bottom: 30px; font-size: 14px; }
			.portal-title { margin-bottom: 6px; font-weight: 600; }
			.portal-desc { color: #666; margin-bottom: 18px; line-height: 1.5; }
			.portal-status-grid {
				display: grid;
				grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
				gap: 12px;
				margin-bottom: 20px;
			}
			.portal-card {
				background: var(--background-color, #fff);
				border: 1px solid var(--border-color, #e5e7eb);
				border-radius: 6px;
				padding: 12px 16px;
				box-shadow: 0 1px 3px rgba(0,0,0,0.05);
			}
			.portal-card-label { font-size: 12px; color: #6b7280; margin-bottom: 4px; }
			.portal-card-val { font-size: 16px; font-weight: 600; }
			.portal-card-sub { font-size: 11px; color: #9ca3af; margin-top: 4px; }
			.portal-badge {
				display: inline-block;
				padding: 2px 8px;
				font-size: 12px;
				font-weight: 500;
				border-radius: 4px;
				line-height: 1.4;
			}
			.portal-badge-success { background: #d1fae5; color: #065f46; }
			.portal-badge-warning { background: #fef3c7; color: #92400e; }
			.portal-badge-danger { background: #fee2e2; color: #991b1b; }
			.portal-badge-info { background: #dbeafe; color: #1e40af; }
			.portal-badge-neutral { background: #f3f4f6; color: #374151; }
			.portal-badge-orange { background: #ffedd5; color: #c2410c; }
			.portal-signal-good { color: #059669; font-weight: 600; }
			.portal-signal-medium { color: #d97706; font-weight: 600; }
			.portal-signal-bad { color: #dc2626; font-weight: 600; }
			.portal-signal-na { color: #9ca3af; }
			.portal-tag-mac {
				font-family: monospace;
				font-weight: bold;
				background: #f3f4f6;
				padding: 2px 6px;
				border-radius: 3px;
				border: 1px solid #e5e7eb;
			}
			.portal-table-ops button { margin-right: 4px; margin-bottom: 2px; }
			.portal-header-row {
				display: flex;
				justify-content: space-between;
				align-items: center;
				margin-bottom: 10px;
			}
			.portal-filter-bar {
				display: flex;
				flex-wrap: wrap;
				gap: 8px;
				align-items: center;
				margin-bottom: 12px;
			}
			.portal-log-viewer {
				background: #1e1e1e;
				color: #d4d4d4;
				font-family: monospace;
				font-size: 12px;
				padding: 12px;
				border-radius: 4px;
				max-height: 360px;
				overflow-y: auto;
				white-space: pre-wrap;
				line-height: 1.5;
			}
			.portal-table-empty {
				text-align: center;
				padding: 24px 0;
				color: #9ca3af;
				font-style: italic;
			}
			.portal-hint-box {
				background: #eff6ff;
				border-left: 4px solid #3b82f6;
				padding: 10px 14px;
				margin-bottom: 14px;
				color: #1e40af;
				font-size: 13px;
			}
		`;
		return E('style', { 'type': 'text/css' }, css);
	},

	// =====================================================================
	// 1. 状态条 (顶部区块)
	// =====================================================================
	renderStatusBar: function() {
		var self = this;
		var s = this.portalStatus || {};
		var nft = s.nft || {};

		var isEnabled = (s.enabled === 1 || s.enabled === true);
		var enabledBadge = isEnabled ?
			E('span', { 'class': 'portal-badge portal-badge-success' }, '已启用') :
			E('span', { 'class': 'portal-badge portal-badge-neutral' }, '已禁用');
		var toggleBtn = E('button', {
			'class': 'btn cbi-button ' + (isEnabled ? 'cbi-button-remove' : 'cbi-button-apply'),
			'click': ui.createHandlerFn(this, 'handleToggleEnabled'),
			'style': 'margin-left:8px;padding:2px 10px;font-size:12px;'
		}, isEnabled ? '停止拦截' : '启动拦截');

		// 未认证出口策略
		var policyText = '阻断待登记 (drop)';
		if (s.unauth_policy === 'wifi-only') {
			policyText = '仅指定出口（未登记）';
		} else if (s.unauth_policy && s.unauth_policy !== 'drop') {
			policyText = s.unauth_policy;
		}

		// 扩展就绪状态文案
		var extText = '未启用扩展';
		var extBadge = 'portal-badge-neutral';
		if (s.integration_needed) {
			if (s.ext_ok) {
				extText = '扩展就绪 (正常)';
				extBadge = 'portal-badge-success';
			} else {
				extText = s.integration_message || '等待指定出口同步确认';
				extBadge = 'portal-badge-danger';
			}
		}

		// 8081 监听状态
		var listenBadge = s.listen_8081 ?
			E('span', { 'class': 'portal-badge portal-badge-success' }, '监听中 (8081)') :
			E('span', { 'class': 'portal-badge portal-badge-danger' }, '未监听');

		// L2 支持状态
		var l2Text = s.l2_support ? '支持无线持久禁连' : '仅普通断流';

		var grid = E('div', { 'class': 'portal-status-grid' }, [
			E('div', { 'class': 'portal-card' }, [
				E('div', { 'class': 'portal-card-label' }, '基础门户运行状态'),
				E('div', { 'class': 'portal-card-val' }, [ enabledBadge, toggleBtn ]),
				E('div', { 'class': 'portal-card-sub' }, '版本: ' + (s.version || '0.1.1'))
			]),
			E('div', { 'class': 'portal-card' }, [
				E('div', { 'class': 'portal-card-label' }, '未登记策略 / 分流'),
				E('div', { 'class': 'portal-card-val', 'style': 'font-size:14px;' }, policyText),
				E('div', { 'class': 'portal-card-sub' }, E('span', { 'class': 'portal-badge ' + extBadge }, extText))
			]),
			E('div', { 'class': 'portal-card' }, [
				E('div', { 'class': 'portal-card-label' }, '设备权限计数'),
				E('div', { 'class': 'portal-card-val' },
					'放行: ' + (nft.auth_mac || 0) + ' | 阻断: ' + (nft.block_mac || 0)
				),
				E('div', { 'class': 'portal-card-sub' }, '指定出口设备: ' + (nft.limited_mac || 0))
			]),
			E('div', { 'class': 'portal-card' }, [
				E('div', { 'class': 'portal-card-label' }, '登录重定向与二层防御'),
				E('div', { 'class': 'portal-card-val' }, listenBadge),
				E('div', { 'class': 'portal-card-sub' }, l2Text)
			])
		]);

		var statusBarChildren = [
			E('div', { 'class': 'portal-header-row' }, [
				E('h3', {}, '运行状态'),
				E('button', {
					'class': 'btn cbi-button cbi-button-reset',
					'click': ui.createHandlerFn(this, 'refreshAllStatus')
				}, '刷新状态')
			])
		];

		if (s.integration_needed && !s.ext_ok) {
			statusBarChildren.push(E('div', {
				'class': 'portal-hint-box',
				'style': 'background:#fffbeb; border-left-color:#f59e0b; color:#b45309; margin-bottom:14px;'
			}, '指定出口普通上网已阻断：' + (s.integration_message || '等待同步确认') + '。控制器确认不能代替实际双栈流量和故障出口验证。'));
		}

		statusBarChildren.push(grid);
		var offloadPolicy = s.offload_policy || 'allow';
		if (isEnabled && (s.flow_offloading || s.flow_offloading_hw)) {
			statusBarChildren.push(E('div', { 'class': 'portal-hint-box', 'style': 'background:#fffbeb;color:#92400e;' },
				offloadPolicy === 'require-off' ? '当前系统配置不满足所选严格策略，门户新规则可能应用失败。请关闭系统卸载或改为允许卸载。' :
				'当前允许系统卸载：门户继续运行，但不能保证已卸载连接在拉黑或分流故障时立即停止。'));
		}

		return E('div', { 'class': 'cbi-section', 'data-portal-section': 'status' }, statusBarChildren);
	},

	renderOffloadSection: function() {
		var self = this, s = this.portalStatus || {};
		var offloadPolicy = s.offload_policy || 'allow';
		var offloadSelect = E('select', { 'class': 'cbi-input-select', 'aria-label': '流量卸载兼容策略' }, [
			E('option', { 'value': 'allow', 'selected': offloadPolicy === 'allow' }, '允许系统流量卸载（默认）'),
			E('option', { 'value': 'require-off', 'selected': offloadPolicy === 'require-off' }, '要求关闭流量卸载')
		]);
		return E('div', { 'class': 'cbi-section portal-offload-section', 'data-portal-section': 'offload' }, [
			E('h3', {}, '流量卸载兼容策略'),
			offloadSelect,
			E('button', { 'class': 'btn cbi-button cbi-button-apply', 'style': 'margin-left:8px;', 'click': function() {
				return callPortalSetoffload(offloadSelect.value).then(function(res) {
					if (self.checkRpcResult(res, '兼容策略已保存；系统流量卸载开关未改变')) return self.refreshAllStatus();
				}).catch(function(err) { self.checkRpcResult(err); });
			} }, '保存兼容策略'),
			E('p', { 'class': 'portal-card-sub' }, '系统配置：软件卸载' + (s.flow_offloading ? '开启' : '关闭') +
				'，硬件卸载' + (s.flow_offloading_hw ? '开启' : '关闭') + '。门户只检查这些设置，不自动修改。'),
			E('p', {}, '允许卸载可保留系统加速，但已卸载连接可能绕过拉黑、出口切换和许可到期检查；要求关闭卸载时，需在系统防火墙中手动关闭后才能启用门户。')
		]);
	},

	handleToggleEnabled: function(ev) {
		var self = this;
		var s = this.portalStatus || {};
		var isEnabled = (s.enabled === 1 || s.enabled === true);
		var newVal = isEnabled ? 0 : 1;
		var confirmText = isEnabled ?
			'停止后拦截立即解除：未登记设备可直接上网且不登记；重新开启后，关闭期间放过的设备仍需登记。登记数据保留。无线持久禁连及现有 Mihomo 出口规则可能继续生效。' :
			'开启后受控 WiFi 的未登记设备按配置进入登记限制或指定出口。门户是否自动弹出由客户端决定，也可手动访问门户地址。';
		if (!isEnabled && (s.flow_offloading || s.flow_offloading_hw)) {
			confirmText += (s.offload_policy === 'require-off') ? ' 当前选择要求关闭卸载，请先关闭系统卸载，否则启动会被拒绝。' :
				' 系统配置了流量卸载，将保留该设置；已卸载连接的拉黑、出口切换和故障阻断不能保证及时生效。';
		}

		ui.showModal(
			isEnabled ? '停止门户拦截' : '启动门户拦截',
			E('div', {}, [
				E('p', { 'style': 'max-width:420px;line-height:1.6;' }, confirmText),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn cbi-button',
						'click': ui.hideModal
					}, '取消'),
					' ',
					E('button', {
						'class': 'btn cbi-button ' + (isEnabled ? 'cbi-button-remove' : 'cbi-button-action'),
						'click': function() {
							ui.hideModal();
							return callPortalSetenabled(newVal).then(function(res) {
								if (self.checkRpcResult(res, isEnabled ? '门户拦截已停止（注册表保留）' : '门户拦截已启动（已请求启动，请检查监听状态）')) {
									self.refreshAllStatus();
								}
							}).catch(function(err) {
								self.checkRpcResult(err);
							});
						}
					}, isEnabled ? '确认停止' : '确认开启')
				])
			])
		);
	},

	// 刷新全部状态数据
	refreshAllStatus: function() {
		var self = this;
		return callPortalStatus().then(function(s) {
			if (!self.checkRpcResult(s)) return;
			self.applyStatus(s || {}, false);
			self.notify('运行状态已刷新', 'info');
		}).catch(function(err) { self.checkRpcResult(err); });
	},

	// =====================================================================
	// 2. 未识别池 (核心区块，15s 轮询)
	// =====================================================================
	renderUnidentifiedSection: function(historical) {
		var table = E('table', { 'class': 'table cbi-section-table portal-pool-table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, 'MAC / 厂商'),
				E('th', { 'class': 'th' }, '主机名及来源'),
				E('th', { 'class': 'th' }, '在线状态 / IP'),
				E('th', { 'class': 'th' }, '信号 / 关联时长'),
				E('th', { 'class': 'th' }, '首次 / 最近观察'),
				E('th', { 'class': 'th' }, '出口状态'),
				E('th', { 'class': 'th right' }, '操作')
			])
		]);
		if (historical) this.historyTableNode = table; else this.unidentifiedTableNode = table;
		this.updateUnidentifiedTableRows();
		return E('div', { 'class': 'cbi-section', 'data-portal-section': historical ? 'history' : 'unidentified' }, [
			E('div', { 'class': 'portal-header-row' }, [
				E('div', {}, [
					E('h3', { 'style': 'margin:0;' }, historical ? '历史未识别设备' : '未识别设备'),
					E('span', { 'style': 'font-size:12px; color:#6b7280;' }, historical ?
						'未登记的离线及状态未确认记录，仍可指派、加白和拉黑；历史最多 512 台，异常断电可能丢失最近 15 分钟。' :
						'当前确认在线且尚未登记或加入白名单的设备，每 15 秒刷新；离线记录位于下方历史列表。')
				]),
				E('button', { 'class': 'btn cbi-button cbi-button-reset', 'click': ui.createHandlerFn(this, function() { return this.refreshUnidentifiedPool(false); }) }, '刷新设备')
			]),
			this.wrapTable(table)
		]);
	},

	// 刷新未识别池数据
	refreshUnidentifiedPool: function(silent) {
		var self = this;
		if (this.inventoryPromise) return this.inventoryPromise;
		this.inventoryPromise = Promise.all([callPortalInventory(), callPortalStatus()]).then(function(results) {
			if (!results[0] || results[0].error) throw results[0];
			self.applyInventory(results[0]);
			if (results[1] && !results[1].error) self.applyStatus(results[1]);
			if (!silent) self.notify('设备与历史信息已刷新', 'info');
		}).catch(function(err) { if (!silent) self.checkRpcResult(err); }).finally(function() { self.inventoryPromise = null; });
		return this.inventoryPromise;
	},

	// 更新未识别池表格行内容
	updateUnidentifiedTableRows: function() {
		var self = this;
		[{ table: this.unidentifiedTableNode, historical: false }, { table: this.historyTableNode, historical: true }].forEach(function(group) {
			var table = group.table; if (!table) return;
			while (table.childNodes.length > 1) table.removeChild(table.lastChild);
			var list = (self.unidentifiedList || []).filter(function(dev) { return group.historical ? dev.online_state !== 'online' : dev.online_state === 'online'; });
			if (!list.length) {
				table.appendChild(E('tr', { 'class': 'tr' }, E('td', { 'class': 'td portal-table-empty', 'colspan': 7 }, group.historical ?
					'暂无离线或状态未确认的未识别历史；已彻底消失且从未采集的设备无法追溯。' : '当前暂无确认在线的未识别设备。')));
				return;
			}
			list.forEach(function(dev) { table.appendChild(self.renderUnidentifiedRow(dev)); });
		});
	},

	// 渲染未识别池单行
	renderUnidentifiedRow: function(dev) {
		var self = this;
		var mac = (dev.mac || '').toUpperCase();

		// OUI 厂商与 LAA 标记


		// 主机名与来源
		var hostnameNodes = [E('strong', {}, dev.hostname || '-')];
		if (dev.hostname_source) {
			var srcText = dev.hostname_source === 'dhcp' ? 'DHCP租约' : (dev.hostname_source === 'history' ? '历史记录' : '未记录');
			hostnameNodes.push(E('br'));
			hostnameNodes.push(E('small', { 'style': 'color:#6b7280;' }, '(' + srcText + ')'));
		}

		// 信号与连接时长
		var signalNodes = [
			this.formatSignal(dev.signal),
			E('br'),
			E('small', {}, '已关联 ' + this.formatDuration(dev.connected_s))
		];

		// 操作按钮组
		var opsNode = E('div', { 'class': 'portal-table-ops right' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(self, function() { return self.showAssignModal(dev); })
			}, '指派身份'),
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'title': '加入免登记白名单',
				'click': ui.createHandlerFn(self, function() { return self.showWhitelistModal(dev); })
			}, '加白'),
			E('button', {
				'class': 'btn cbi-button cbi-button-negative',
				'click': ui.createHandlerFn(self, function() { return self.showBlockModal(mac); })
			}, '拉黑'),
			E('button', {
				'class': 'btn cbi-button',
				'title': '修改设备备注',
				'click': ui.createHandlerFn(self, function() { return self.showNoteModal(dev); })
			}, '备注')
		]);

		return E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td' }, this.renderMac(dev)),
			E('td', { 'class': 'td' }, hostnameNodes),
			E('td', { 'class': 'td' }, this.renderAddresses(dev)),
			E('td', { 'class': 'td' }, signalNodes),
			E('td', { 'class': 'td' }, [dev.first_seen ? this.formatTime(dev.first_seen) : this.formatObserved(dev.first_observed), E('br'), E('small', {}, '最近：' + this.formatObserved(dev.last_seen))]),
			E('td', { 'class': 'td' }, this.renderStateTextBadge(dev.state_text)),
			E('td', { 'class': 'td right' }, this.compactOperations(opsNode, dev))
		]);
	},

	// ---------------------------------------------------------------------
	// 未识别池交互弹窗
	// ---------------------------------------------------------------------

	// 弹窗：指派设备身份 (支持选择已有身份 assign 或新建身份 split，以及解绑身份)
	showAssignModal: function(dev) {
		var self = this;
		var mac = (dev.mac || '').toUpperCase();
		var hasExistingIdentity = Boolean(dev.identity || dev.identity_name);

		var nameInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': '例如：张三、李四 (1-32字符)',
			'style': 'width: 100%; margin-top: 6px;'
		});

		var identitySelect = E('select', {
			'class': 'cbi-input-select',
			'style': 'width: 100%; margin-top: 6px;'
		});
		identitySelect.appendChild(E('option', { 'value': '' }, '-- 选择已有身份 --'));
		for (var i = 0; i < this.identitiesList.length; i++) {
			var idObj = this.identitiesList[i];
			var opt = E('option', { 'value': idObj.id }, idObj.name + ' (' + idObj.device_count + '台设备)');
			if (dev.identity && dev.identity === idObj.id) {
				opt.selected = true;
			}
			identitySelect.appendChild(opt);
		}

		var modeRadioExisting = E('input', {
			'type': 'radio',
			'name': 'assign_mode',
			'id': 'assign_mode_existing',
			'value': 'existing',
			'checked': (this.identitiesList.length > 0) ? 'checked' : null
		});
		var modeRadioNew = E('input', {
			'type': 'radio',
			'name': 'assign_mode',
			'id': 'assign_mode_new',
			'value': 'new',
			'checked': (this.identitiesList.length === 0) ? 'checked' : null
		});
		var modeRadioUnassign = E('input', {
			'type': 'radio',
			'name': 'assign_mode',
			'id': 'assign_mode_unassign',
			'value': 'unassign'
		});

		var modalChildren = [
			E('p', {}, [
				'正在为设备 ',
				E('strong', { 'class': 'portal-tag-mac' }, mac),
				(dev.hostname ? (' (' + dev.hostname + ')') : ''),
				' 设置归属身份：'
			]),
			E('div', { 'style': 'margin-bottom: 12px; padding: 10px; background: #f9fafb; border-radius: 4px;' }, [
				E('label', { 'style': 'display:block; font-weight:600; margin-bottom:6px;' }, [
					modeRadioExisting,
					' 指派至已有身份'
				]),
				E('div', { 'style': 'margin-left: 20px;' }, [
					E('span', { 'style': 'font-size:12px; color:#6b7280;' }, '将该设备归属于系统名下已存在的身份中（调用 assign 方法）：'),
					identitySelect
				])
			]),
			E('div', { 'style': 'margin-bottom: 12px; padding: 10px; background: #f9fafb; border-radius: 4px;' }, [
				E('label', { 'style': 'display:block; font-weight:600; margin-bottom:6px;' }, [
					modeRadioNew,
					' 登记/拆分至新建身份'
				]),
				E('div', { 'style': 'margin-left: 20px;' }, [
					E('span', { 'style': 'font-size:12px; color:#6b7280;' }, '输入新身份的使用者姓名（调用 split 方法新建身份并绑定该设备）：'),
					nameInput
				])
			])
		];

		// 若设备当前已有身份归属，或设备在注册表中，提供取消指派选项
		if (hasExistingIdentity || dev.policy) {
			modalChildren.push(
				E('div', { 'style': 'margin-bottom: 16px; padding: 10px; background: #f9fafb; border-radius: 4px;' }, [
					E('label', { 'style': 'display:block; font-weight:600; margin-bottom:6px; color:#b91c1c;' }, [
						modeRadioUnassign,
						' 取消身份指派（清空归属身份）'
					]),
					E('div', { 'style': 'margin-left: 20px;' }, [
						E('div', { 'class': 'portal-hint-box', 'style': 'background:#fff1f2; border-left-color:#e11d48; color:#9f1239; margin: 4px 0 0 0;' },
							'语义说明：取消后该设备回未识别状态，重连将弹门户（若 trusted 为 0）。'
						)
					])
				])
			);
		}

		modalChildren.push(
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.hideModal
				}, '取消'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': function() {
						if (modeRadioUnassign.checked) {
							// 取消指派: identity 传空串 ""
							ui.hideModal();
							return callPortalAssign(mac, '').then(function(res) {
								if (self.checkRpcResult(res, '设备 ' + mac + ' 已成功取消身份指派（取消后该设备回未识别状态，重连将弹门户）')) {
									self.refreshUnidentifiedPool(true);
									self.refreshIdentitiesAndDevices();
									self.refreshAllStatus();
								}
							}).catch(function(err) {
								self.checkRpcResult(err);
							});
						} else if (modeRadioNew.checked) {
							var newName = (nameInput.value || '').trim();
							if (!newName) {
								self.notify('请输入新身份姓名', 'warning');
								nameInput.focus();
								return;
							}
							if (newName.length > 32) {
								self.notify('姓名长度不得超过 32 字符', 'warning');
								return;
							}
							ui.hideModal();
							return callPortalSplit(mac, newName).then(function(res) {
								if (self.checkRpcResult(res, '设备 ' + mac + ' 已成功登记至身份「' + newName + '」')) {
									self.refreshUnidentifiedPool(true);
									self.refreshIdentitiesAndDevices();
									self.refreshAllStatus();
								}
							}).catch(function(err) {
								self.checkRpcResult(err);
							});
						} else {
							// 选择已有身份模式 (assign)
							var selectedId = identitySelect.value;
							if (!selectedId) {
								self.notify('请选择目标归属身份', 'warning');
								identitySelect.focus();
								return;
							}
							ui.hideModal();
							return callPortalAssign(mac, selectedId).then(function(res) {
								if (self.checkRpcResult(res, '设备 ' + mac + ' 已成功指派归属身份')) {
									self.refreshUnidentifiedPool(true);
									self.refreshIdentitiesAndDevices();
									self.refreshAllStatus();
								}
							}).catch(function(err) {
								self.checkRpcResult(err);
							});
						}
					}
				}, '确认指派')
			])
		);

		ui.showModal('指派设备身份', E('div', {}, modalChildren));
	},

	// 弹窗：未识别池设备加白名单 (trusted=1)
	showWhitelistModal: function(dev) {
		var self = this;
		var mac = (dev.mac || '').toUpperCase();

		var modalContent = E('div', {}, [
			E('p', {}, [
				'确定要将未识别设备 ',
				E('strong', { 'class': 'portal-tag-mac' }, mac),
				(dev.hostname ? (' (' + dev.hostname + ')') : ''),
				' 加入免认证白名单吗？'
			]),
			E('div', { 'class': 'portal-hint-box' }, [
				E('strong', {}, '白名单说明：'),
				'加入白名单后保存设备记录并免去登记。黑名单优先，已有指定出口设置仍然生效。'
			]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.hideModal
				}, '取消'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': function() {
						ui.hideModal();
						return callPortalWhitelist(mac, 1).then(function(res) {
							if (self.checkRpcResult(res, '设备 ' + mac + ' 已成功加入白名单（长期直通免登记）')) {
								self.refreshUnidentifiedPool(true);
								self.refreshIdentitiesAndDevices();
								self.refreshAllStatus();
							}
						}).catch(function(err) {
							self.checkRpcResult(err);
						});
					}
				}, '确认加白')
			])
		]);
		ui.showModal('设备加白名单确认', modalContent);
	},

	// 弹窗：拉黑设备 (block)
	showBlockModal: function(mac) {
		var self = this;
		var cleanMac = (mac || '').toUpperCase();

		var reasonInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': '拉黑原因（选填）',
			'style': 'width: 100%; margin-top: 6px;'
		});

		var levelL1Radio = E('input', {
			'type': 'radio',
			'name': 'block_level',
			'id': 'block_level_l1',
			'value': 'L1',
			'checked': 'checked'
		});
		var levelL2Radio = E('input', {
			'type': 'radio',
			'name': 'block_level',
			'id': 'block_level_l2',
			'value': 'L2'
		});

		var modalContent = E('div', {}, [
			E('p', {}, [
				'确定要拉黑设备 ',
				E('strong', { 'class': 'portal-tag-mac' }, cleanMac),
				' 吗？拉黑后将阻止该设备访问外网。'
			]),
			E('div', { 'style': 'margin-bottom: 14px;' }, [
				E('label', { 'style': 'font-weight:600;' }, '拉黑原因（选填，留空审计记 "-"）:'),
				reasonInput
			]),
			E('div', { 'style': 'margin-bottom: 16px; padding: 10px; background: #f9fafb; border-radius: 4px;' }, [
				E('label', { 'style': 'font-weight:600; display:block; margin-bottom:6px;' }, '封禁级别选择:'),
				E('label', { 'style': 'display:block; margin-bottom:6px;' }, [
					levelL1Radio,
					' 普通拉黑：阻断设备网络访问，保留设备记录'
				]),
				E('label', { 'style': 'display:block;' }, [
					levelL2Radio,
					' 持久无线禁连：另加入无线黑名单；应用可能短暂影响同一无线网络'
				])
			]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.hideModal
				}, '取消'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-negative',
					'click': function() {
						var reason = (reasonInput.value || '').trim();
						var level = levelL2Radio.checked ? 'L2' : 'L1';
						ui.hideModal();
						return callPortalBlock(cleanMac, reason, level).then(function(res) {
							if (self.checkRpcResult(res, '设备 ' + cleanMac + ' 已成功拉黑 (' + level + ')')) {
								self.refreshUnidentifiedPool(true);
								self.refreshIdentitiesAndDevices();
								self.refreshAllStatus();
							}
						}).catch(function(err) {
							self.checkRpcResult(err);
						});
					}
				}, '确认拉黑')
			])
		]);

		ui.showModal('拉黑设备', modalContent);
	},

	// 弹窗：设备标签与备注修改 (setdevice)
	showNoteModal: function(dev) {
		var self = this;
		var mac = (dev.mac || '').toUpperCase();

		var labelInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'value': dev.label || '',
			'placeholder': '例如：工作笔记本、家庭NAS (可选，留空清除)',
			'style': 'width: 100%; margin-top: 4px;'
		});

		var noteInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'value': dev.note || '',
			'placeholder': '例如：2026采购、放置于书房等备注信息 (可选，留空清除)',
			'style': 'width: 100%; margin-top: 4px;'
		});

		var modalContent = E('div', {}, [
			E('p', {}, [
				'查看与修改设备 ',
				E('strong', { 'class': 'portal-tag-mac' }, mac),
				' 的标签与备注说明：'
			]),
			E('div', { 'style': 'margin-bottom: 12px;' }, [
				E('label', { 'style': 'font-weight:600; display:block;' }, '设备标签 (Label):'),
				labelInput,
				E('span', { 'style': 'font-size:12px; color:#6b7280;' }, '设备简短标识标签，如“服务器”、“工作手机”。留空提交将清除原标签。')
			]),
			E('div', { 'style': 'margin-bottom: 16px;' }, [
				E('label', { 'style': 'font-weight:600; display:block;' }, '备注说明 (Note):'),
				noteInput,
				E('span', { 'style': 'font-size:12px; color:#6b7280;' }, '设备的详细管理员备注。留空提交将清除原备注。')
			]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.hideModal
				}, '取消'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': function() {
						var label = (labelInput.value || '').trim();
						var note = (noteInput.value || '').trim();
						ui.hideModal();
						return callPortalSetdevice(mac, label, note).then(function(res) {
							if (self.checkRpcResult(res, '设备 ' + mac + ' 的标签与备注已成功更新')) {
								self.refreshUnidentifiedPool(true);
								self.refreshIdentitiesAndDevices();
							}
						}).catch(function(err) {
							self.checkRpcResult(err);
						});
					}
				}, '保存修改')
			])
		]);
		ui.showModal('修改设备备注与标签', modalContent);
	},

	// 弹窗：设备表中加白/取消白名单 (whitelist trusted=1 / trusted=0)
	showDeviceWhitelistModal: function(dev, targetTrusted) {
		var self = this;
		var mac = (dev.mac || '').toUpperCase();
		var hasIdentity = Boolean(dev.identity || dev.identity_name);

		var hintNodes = [];
		if (targetTrusted === 1) {
			if (hasIdentity) {
				hintNodes.push(E('div', { 'class': 'portal-hint-box', 'style': 'background:#fffbeb; border-left-color:#f59e0b; color:#92400e;' }, [
					E('strong', {}, '提示：'),
					'该设备已归属于「' + (dev.identity_name || dev.identity) + '」。',
					E('strong', {}, '加入白名单后仍保留身份登记'),
					'；以后解除身份归属时，白名单仍可免去登记。黑名单和指定出口限制继续生效。'
				]));
			} else {
				hintNodes.push(E('div', { 'class': 'portal-hint-box' }, [
					E('strong', {}, '白名单说明：'),
					'白名单允许设备免登记访问网络。黑名单优先，已有的指定出口限制继续生效。'
				]));
			}
		} else {
			if (!hasIdentity) {
				hintNodes.push(E('div', { 'class': 'portal-hint-box', 'style': 'background:#fff1f2; border-left-color:#e11d48; color:#9f1239;' }, [
					E('strong', {}, '警告：'),
					'该设备当前没有归属身份，',
					E('strong', {}, '取消白名单后按未登记设备处理'),
					'，使用管理员配置的未登记策略；在线时可在未识别池中查看。'
				]));
			} else {
				hintNodes.push(E('div', { 'class': 'portal-hint-box' }, [
					E('strong', {}, '状态提示：'),
					'该设备已归属于「' + (dev.identity_name || dev.identity) + '」，取消白名单后',
					E('strong', {}, '仍保留身份登记'),
					'。黑名单和指定出口限制继续生效。'
				]));
			}
		}

		var actionText = targetTrusted === 1 ? '加入白名单' : '取消白名单';
		var confirmBtnClass = targetTrusted === 1 ? 'btn cbi-button cbi-button-action' : 'btn cbi-button cbi-button-negative';

		var modalContent = E('div', {}, [
			E('p', {}, [
				'确定要对设备 ',
				E('strong', { 'class': 'portal-tag-mac' }, mac),
				(dev.label ? (' [' + dev.label + ']') : ''),
				' 执行',
				E('strong', {}, actionText),
				'操作吗？'
			]),
			E('div', {}, hintNodes),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.hideModal
				}, '取消'),
				' ',
				E('button', {
					'class': confirmBtnClass,
					'click': function() {
						ui.hideModal();
						return callPortalWhitelist(mac, targetTrusted).then(function(res) {
							if (self.checkRpcResult(res, '设备 ' + mac + ' 已成功' + actionText)) {
								self.refreshIdentitiesAndDevices();
								self.refreshUnidentifiedPool(true);
								self.refreshAllStatus();
							}
						}).catch(function(err) {
							self.checkRpcResult(err);
						});
					}
				}, '确认' + actionText)
			])
		]);

		ui.showModal(actionText + '确认', modalContent);
	},

	// =====================================================================
	// 3. 身份表 (Identities)
	// =====================================================================
	renderIdentitiesSection: function() {
		var self = this;
		var table = E('table', { 'class': 'table cbi-section-table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, '身份名称'),
				E('th', { 'class': 'th' }, '设备数'),
				E('th', { 'class': 'th' }, '名下设备 (MAC 归并)'),
				E('th', { 'class': 'th' }, '备注'),
				E('th', { 'class': 'th' }, '创建时间'),
				E('th', { 'class': 'th right' }, '操作')
			])
		]);

		this.identitiesTableNode = table;
		this.updateIdentitiesTableRows();

		return E('div', { 'class': 'cbi-section', 'data-portal-section': 'identities' }, [
			E('div', { 'class': 'portal-header-row' }, [
				E('div', {}, [
					E('h3', { 'style': 'margin:0;' }, '已登记身份'),
					E('span', { 'style': 'font-size:12px; color:#6b7280;' },
						'人名与设备归属底账；同名多 MAC 自动归并展示。改名影响名下全部设备；合并将源身份归入目标；无设备引用时方可删除。'
					)
				]),
				E('div', {}, [
					E('button', {
						'class': 'btn cbi-button cbi-button-reset',
						'click': ui.createHandlerFn(self, 'refreshIdentitiesAndDevices')
					}, '刷新身份')
				])
			]),
			this.wrapTable(table)
		]);
	},

	// 更新身份表格内容
	updateIdentitiesTableRows: function() {
		if (!this.identitiesTableNode) return;
		var table = this.identitiesTableNode;

		while (table.childNodes.length > 1) {
			table.removeChild(table.lastChild);
		}

		if (!this.identitiesList || this.identitiesList.length === 0) {
			var emptyRow = E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td portal-table-empty', 'colspan': 6 }, '暂无已登记身份')
			]);
			table.appendChild(emptyRow);
			return;
		}

		for (var i = 0; i < this.identitiesList.length; i++) {
			var idObj = this.identitiesList[i];
			var row = this.renderIdentityRow(idObj);
			table.appendChild(row);
		}
	},

	// 渲染身份单行
	renderIdentityRow: function(idObj) {
		var self = this;

		// 归并展示名下全部 MAC
		var devicesNodes = [];
		if (Array.isArray(idObj.devices) && idObj.devices.length > 0) {
			for (var j = 0; j < idObj.devices.length; j++) {
				devicesNodes.push(E('span', {
					'class': 'portal-tag-mac',
					'style': 'margin-right: 4px; margin-bottom: 2px; display: inline-block;'
				}, idObj.devices[j]));
			}
		} else {
			devicesNodes.push(E('span', { 'style': 'color:#9ca3af;' }, '无关联设备'));
		}

		// 操作按钮
		var opsNode = E('div', { 'class': 'portal-table-ops right' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(self, function() { return self.showRenameModal(idObj); })
			}, '改名'),
			E('button', {
				'class': 'btn cbi-button',
				'title': '编辑身份备注',
				'click': ui.createHandlerFn(self, function() { return self.showIdentityNoteModal(idObj); })
			}, '编辑备注'),
			E('button', {
				'class': 'btn cbi-button',
				'click': ui.createHandlerFn(self, function() { return self.showMergeModal(idObj); })
			}, '合并'),
			E('button', {
				'class': 'btn cbi-button',
				'disabled': (!idObj.devices || idObj.devices.length === 0) ? 'disabled' : null,
				'click': ui.createHandlerFn(self, function() { return self.showSplitModal(idObj); })
			}, '拆分'),
			E('button', {
				'class': 'btn cbi-button cbi-button-negative',
				'click': ui.createHandlerFn(self, function() { return self.showDeleteIdentityModal(idObj); })
			}, '删除')
		]);

		return E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td' }, E('strong', {}, idObj.name || idObj.id)),
			E('td', { 'class': 'td' }, E('span', { 'class': 'portal-badge portal-badge-info' }, (idObj.device_count || 0) + ' 台')),
			E('td', { 'class': 'td' }, devicesNodes),
			E('td', { 'class': 'td' }, (idObj.note && idObj.note.trim()) ? idObj.note : '—'),
			E('td', { 'class': 'td' }, this.formatTime(idObj.created_at)),
			E('td', { 'class': 'td right' }, opsNode)
		]);
	},

	// 弹窗：身份改名 (rename)
	showRenameModal: function(idObj) {
		var self = this;
		var nameInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'value': idObj.name || '',
			'style': 'width: 100%; margin-top: 6px;'
		});

		var modalContent = E('div', {}, [
			E('p', {}, [
				'修改身份 ',
				E('strong', {}, idObj.name),
				' 的名称：'
			]),
			E('div', { 'class': 'portal-hint-box', 'style': 'margin-bottom: 12px;' },
				'注意：改名将同时影响该身份下的全部关联设备 (' + (idObj.device_count || 0) + ' 台)。新名称长度限 1–32 字符且全局唯一。'
			),
			E('div', { 'style': 'margin-bottom: 16px;' }, [
				E('label', { 'style': 'font-weight:600;' }, '新身份名称:'),
				nameInput
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, '取消'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': function() {
						var newName = (nameInput.value || '').trim();
						if (!newName) {
							self.notify('身份名称不能为空', 'warning');
							nameInput.focus();
							return;
						}
						if (newName.length > 32) {
							self.notify('名称不能超过 32 字符', 'warning');
							return;
						}
						ui.hideModal();
						return callPortalRename(idObj.id, newName).then(function(res) {
							if (self.checkRpcResult(res, '身份改名成功：' + newName)) {
								self.refreshIdentitiesAndDevices();
							}
						}).catch(function(err) {
							self.checkRpcResult(err);
						});
					}
				}, '确认改名')
			])
		]);
		ui.showModal('身份改名', modalContent);
	},

	// 弹窗：身份备注编辑 (setidentity)
	showIdentityNoteModal: function(idObj) {
		var self = this;
		var noteTextarea = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': 4,
			'placeholder': '身份备注（选填，留空清除）',
			'style': 'width: 100%; margin-top: 6px;'
		}, [idObj.note || '']);
		noteTextarea.value = idObj.note || '';

		var modalContent = E('div', {}, [
			E('p', {}, [
				'编辑身份 ',
				E('strong', {}, idObj.name || idObj.id),
				' 的备注说明：'
			]),
			E('div', { 'class': 'portal-hint-box', 'style': 'margin-bottom: 12px;' },
				'说明：备注长度限 256 字符以内；留空提交将清除该身份备注。'
			),
			E('div', { 'style': 'margin-bottom: 16px;' }, [
				E('label', { 'style': 'font-weight:600;' }, '身份备注:'),
				noteTextarea
			]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.hideModal
				}, '取消'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': function() {
						var rawVal = noteTextarea.value != null ? String(noteTextarea.value).trim() : '';
						if (rawVal.length > 256) {
							self.notify('身份备注长度不得超过 256 字符（当前 ' + rawVal.length + ' 字符）', 'warning');
							noteTextarea.focus();
							return;
						}
						var note = rawVal;
						ui.hideModal();
						return callPortalSetidentity(idObj.id, note).then(function(res) {
							if (self.checkRpcResult(res, '身份「' + (idObj.name || idObj.id) + '」备注已更新')) {
								self.refreshIdentitiesAndDevices();
							}
						}).catch(function(err) {
							self.checkRpcResult(err);
						});
					}
				}, '确认保存')
			])
		]);
		ui.showModal('编辑身份备注', modalContent);
	},

	// 弹窗：合并身份 (merge)
	showMergeModal: function(srcObj) {
		var self = this;
		var dstSelect = E('select', { 'class': 'cbi-input-select', 'style': 'width: 100%; margin-top: 6px;' });
		dstSelect.appendChild(E('option', { 'value': '' }, '-- 请选择目标身份 --'));

		for (var i = 0; i < this.identitiesList.length; i++) {
			var idCandidate = this.identitiesList[i];
			if (idCandidate.id !== srcObj.id) {
				dstSelect.appendChild(E('option', { 'value': idCandidate.id },
					idCandidate.name + ' (' + idCandidate.device_count + ' 台设备)'
				));
			}
		}

		var modalContent = E('div', {}, [
			E('p', {}, [
				'确定要将源身份 ',
				E('strong', {}, srcObj.name),
				' (含 ' + (srcObj.device_count || 0) + ' 台设备) 合并到其他身份吗？'
			]),
			E('div', { 'class': 'portal-hint-box', 'style': 'margin-bottom: 12px; background:#fff1f2; border-left-color:#e11d48; color:#9f1239;' },
				'二次确认警告：合并后，源身份名下的所有设备将全部归入目标身份，源身份将被永久删除。该操作不可撤销！'
			),
			E('div', { 'style': 'margin-bottom: 16px;' }, [
				E('label', { 'style': 'font-weight:600;' }, '目标身份:'),
				dstSelect
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, '取消'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-negative',
					'click': function() {
						var dstId = dstSelect.value;
						if (!dstId) {
							self.notify('请选择目标身份', 'warning');
							dstSelect.focus();
							return;
						}
						ui.hideModal();
						return callPortalMerge(srcObj.id, dstId).then(function(res) {
							if (self.checkRpcResult(res, '身份合并完成')) {
								self.refreshIdentitiesAndDevices();
							}
						}).catch(function(err) {
							self.checkRpcResult(err);
						});
					}
				}, '确认合并')
			])
		]);
		ui.showModal('合并身份', modalContent);
	},

	// 弹窗：拆分设备到新身份 (split)
	showSplitModal: function(idObj) {
		var self = this;
		var macSelect = E('select', { 'class': 'cbi-input-select', 'style': 'width: 100%; margin-top: 6px;' });
		if (Array.isArray(idObj.devices)) {
			for (var i = 0; i < idObj.devices.length; i++) {
				macSelect.appendChild(E('option', { 'value': idObj.devices[i] }, idObj.devices[i]));
			}
		}

		var newNameInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': '新身份名称 (1-32字符)',
			'style': 'width: 100%; margin-top: 6px;'
		});

		var modalContent = E('div', {}, [
			E('p', {}, [
				'从身份 ',
				E('strong', {}, idObj.name),
				' 拆分特定设备并建立新身份：'
			]),
			E('div', { 'style': 'margin-bottom: 12px;' }, [
				E('label', { 'style': 'font-weight:600;' }, '选择要拆出的设备 MAC:'),
				macSelect
			]),
			E('div', { 'style': 'margin-bottom: 16px;' }, [
				E('label', { 'style': 'font-weight:600;' }, '新建身份名称:'),
				newNameInput
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, '取消'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': function() {
						var mac = macSelect.value;
						var newName = (newNameInput.value || '').trim();
						if (!mac) {
							self.notify('请选择设备 MAC', 'warning');
							return;
						}
						if (!newName) {
							self.notify('请输入新身份名称', 'warning');
							newNameInput.focus();
							return;
						}
						if (newName.length > 32) {
							self.notify('名称不能超过 32 字符', 'warning');
							return;
						}
						ui.hideModal();
						return callPortalSplit(mac, newName).then(function(res) {
							if (self.checkRpcResult(res, '设备 ' + mac + ' 已成功拆分至新身份「' + newName + '」')) {
								self.refreshIdentitiesAndDevices();
							}
						}).catch(function(err) {
							self.checkRpcResult(err);
						});
					}
				}, '确认拆分')
			])
		]);
		ui.showModal('拆分设备到新身份', modalContent);
	},

	// 弹窗：删除身份 (delete)
	showDeleteIdentityModal: function(idObj) {
		var self = this;
		var devCount = idObj.device_count || (idObj.devices ? idObj.devices.length : 0);

		var warningNodes = [];
		if (devCount > 0) {
			warningNodes.push(E('div', { 'class': 'portal-hint-box', 'style': 'background:#fff1f2; border-left-color:#e11d48; color:#9f1239;' },
				'警告：该身份下当前仍有 ' + devCount + ' 台设备引用！依照契约后端将拒绝删除 (返回 E_CONFLICT)。请先将设备拆分或合并至其他身份。'
			));
		}

		var modalContent = E('div', {}, [
			E('p', {}, [
				'确定要删除身份 ',
				E('strong', {}, idObj.name),
				' 吗？'
			]),
			warningNodes,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, '取消'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-negative',
					'click': function() {
						ui.hideModal();
						return callPortalDelete(idObj.id).then(function(res) {
							if (self.checkRpcResult(res, '身份「' + idObj.name + '」已成功删除')) {
								self.refreshIdentitiesAndDevices();
							}
						}).catch(function(err) {
							self.checkRpcResult(err);
						});
					}
				}, '确认删除')
			])
		]);
		ui.showModal('删除身份确认', modalContent);
	},

	// =====================================================================
	// 4. 全量设备表 (Registered Devices)
	// =====================================================================
	renderDevicesSection: function() {
		var self = this;

		// 快捷筛选按钮组
		var filterBtnAll = E('button', {
			'class': 'btn cbi-button ' + (this.deviceFilter === 'all' ? 'cbi-button-action' : ''),
			'click': function() { self.setDeviceFilter('all'); }
		}, '全部设备');

		var filterBtnOnline = E('button', {
			'class': 'btn cbi-button ' + (this.deviceFilter === 'online' ? 'cbi-button-action' : ''),
			'click': function() { self.setDeviceFilter('online'); }
		}, '仅在线');

		var filterBtnUnidentified = E('button', {
			'class': 'btn cbi-button ' + (this.deviceFilter === 'unidentified' ? 'cbi-button-action' : ''),
			'click': function() { self.setDeviceFilter('unidentified'); }
		}, '未识别/未指派');

		var filterBtnBlock = E('button', {
			'class': 'btn cbi-button ' + (this.deviceFilter === 'blocked' ? 'cbi-button-action' : ''),
			'click': function() { self.setDeviceFilter('blocked'); }
		}, '黑名单');

		var searchInput = E('input', {
			'type': 'text',
			'value': this.deviceSearchText,
			'class': 'cbi-input-text',
			'placeholder': '按 MAC / 身份 / 主机名 / IP 搜索...',
			'style': 'min-width: 240px;',
			'input': function(ev) {
				self.deviceSearchText = (ev.target.value || '').trim().toLowerCase();
				self.updateDevicesTableRows();
			}
		});

		var filterBar = E('div', { 'class': 'portal-filter-bar' }, [
			E('strong', {}, '快捷筛选:'),
			filterBtnAll,
			filterBtnOnline,
			filterBtnUnidentified,
			filterBtnBlock,
			E('div', { 'style': 'margin-left: auto;' }, [
				searchInput
			])
		]);

		var table = E('table', { 'class': 'table cbi-section-table portal-devices-table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, 'MAC / 厂商'),
				E('th', { 'class': 'th' }, '主机名(来源)'),
				E('th', { 'class': 'th' }, '归属身份'),
				E('th', { 'class': 'th' }, '白名单 (Trusted)'),
				E('th', { 'class': 'th' }, '访问策略 / 出口'),
				E('th', { 'class': 'th' }, '标签 / 备注'),
				E('th', { 'class': 'th' }, '首次 / 最近观察'),
				E('th', { 'class': 'th' }, '在线状态 / IP'),
				E('th', { 'class': 'th right' }, '操作')
			])
		]);

		this.devicesTableNode = table;
		this.devicesFilterBarNode = filterBar;
		this.updateDevicesTableRows();

		return E('div', { 'class': 'cbi-section', 'data-portal-section': 'devices' }, [
			E('div', { 'class': 'portal-header-row' }, [
				E('div', {}, [
					E('h3', { 'style': 'margin:0;' }, '全量注册设备'),
					E('span', { 'style': 'font-size:12px; color:#6b7280;' },
						'当前地址直接显示，历史按需展开；点击 MAC 查看完整信息。授权操作仍在右侧。'
					)
				]),
				E('div', {}, [
					E('button', {
						'class': 'btn cbi-button cbi-button-reset',
						'click': ui.createHandlerFn(self, 'refreshIdentitiesAndDevices')
					}, '刷新设备')
				])
			]),
			filterBar,
			this.wrapTable(table)
		]);
	},

	// 切换设备表快捷筛选
	setDeviceFilter: function(filter) {
		this.deviceFilter = filter;
		var newDevicesSection = this.renderDevicesSection();
		this.devicesSectionNode.parentNode.replaceChild(newDevicesSection, this.devicesSectionNode);
		this.devicesSectionNode = newDevicesSection;
	},

	// 更新全量设备表格行
	updateDevicesTableRows: function() {
		if (!this.devicesTableNode) return;
		var table = this.devicesTableNode;

		while (table.childNodes.length > 1) {
			table.removeChild(table.lastChild);
		}

		var filteredList = [];
		for (var i = 0; i < this.devicesList.length; i++) {
			var dev = this.devicesList[i];

			if (this.deviceFilter === 'online' && dev.online_state !== 'online') continue;
			if (this.deviceFilter === 'unidentified' && (dev.identity || dev.identity_name)) continue;
			if (this.deviceFilter === 'blocked') {
				var isBlocked = (dev.policy === 'block' || (dev.block_reason && dev.block_reason !== ''));
				if (!isBlocked) continue;
			}

			// 2. 文本搜索过滤 (MAC / 身份 / IP)
			if (this.deviceSearchText) {
				var macStr = (dev.mac || '').toLowerCase();
				var idStr = (dev.identity_name || dev.identity || '').toLowerCase();
				var addresses = (dev.ipv6 || []).concat(dev.ipv6_history || []);
				var ipStr = ((dev.ip || '') + ' ' + JSON.stringify(addresses) + ' ' + addresses.map(function(x) { return this.formatIPv6(x.address); }, this).join(' ') + ' ' + (dev.hostname || '')).toLowerCase();
				if (macStr.indexOf(this.deviceSearchText) === -1 &&
					idStr.indexOf(this.deviceSearchText) === -1 &&
					ipStr.indexOf(this.deviceSearchText) === -1) {
					continue;
				}
			}

			filteredList.push(dev);
		}

		if (filteredList.length === 0) {
			var emptyRow = E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td portal-table-empty', 'colspan': 9 }, '没有匹配条件的设备数据')
			]);
			table.appendChild(emptyRow);
			return;
		}

		for (var k = 0; k < filteredList.length; k++) {
			table.appendChild(this.renderDeviceRow(filteredList[k]));
		}
	},

	// 渲染设备表单行
	renderDeviceRow: function(dev) {
		var self = this;
		var mac = (dev.mac || '').toUpperCase();
		var isBlocked = (dev.policy === 'block' || (dev.block_reason && dev.block_reason !== ''));



		var hostnameDisplay = '—';
		if (dev.hostname && dev.hostname.trim()) {
			hostnameDisplay = E('div', { 'class': 'portal-host-info' }, [E('span', { 'class': 'portal-host-name', 'title': dev.hostname }, dev.hostname), E('small', { 'class': 'portal-muted' }, dev.hostname_source === 'dhcp' ? 'DHCP' : '历史记录')]);
		}

		// 归属身份
		var idNameNode = dev.identity_name ?
			E('strong', {}, dev.identity_name) :
			E('span', { 'style': 'color:#9ca3af; font-style:italic;' }, '未指派');

		// 白名单状态与派生状态提示
		var isDevTrusted = (dev.trusted === 1 || dev.trusted === '1' || dev.trusted === true);
		var trustedBadge;
		if (isDevTrusted) {
			if (dev.identity || dev.identity_name) {
				trustedBadge = E('span', {
					'class': 'portal-badge portal-badge-success',
					'title': '已登记且带白名单标记；解除归属后仍可免登记',
				}, '免登记');
			} else {
				trustedBadge = E('span', {
					'class': 'portal-badge portal-badge-success',
					'title': '白名单免登记，仍受黑名单和指定出口限制',
				}, '白名单');
			}
		} else {
			trustedBadge = E('span', { 'class': 'portal-badge portal-badge-neutral' }, '普通');
		}

		var policyBadge = E('span', { 'class': 'portal-badge portal-badge-neutral' }, dev.policy || '-');
		if (dev.policy === 'allow') {
			policyBadge = E('span', { 'class': 'portal-badge portal-badge-success' }, '放行');
		} else if (dev.policy === 'block') {
			policyBadge = E('span', { 'class': 'portal-badge portal-badge-danger' }, '封禁');
		} else if (dev.policy === 'drop') {
			policyBadge = E('span', { 'class': 'portal-badge portal-badge-warning' }, '阻断');
		}

		var egress = (dev.egress === 'wifi-only') ? 'wifi-only' : 'normal';
		var isWifiOnly = (egress === 'wifi-only');
		var policyNodes = [ policyBadge ];
		if (isWifiOnly) {
			policyNodes.push(E('br'));
			policyNodes.push(E('span', {
				'class': 'portal-badge portal-badge-orange',
				'style': 'margin-top:2px;',
				'title': '要求仅使用指定出口；Mihomo 不可用时阻断普通上网'
			}, '仅指定出口'));
		}


		// 行内操作
		var opsNode = E('div', { 'class': 'portal-table-ops right' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'title': '修改设备归属身份或解绑归属',
				'click': ui.createHandlerFn(self, function() { return self.showAssignModal(dev); })
			}, '改身份')
		]);

		if (isDevTrusted) {
			opsNode.appendChild(E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'title': '取消免登记白名单',
				'click': ui.createHandlerFn(self, function() { return self.showDeviceWhitelistModal(dev, 0); })
			}, '取消加白'));
		} else {
			opsNode.appendChild(E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'title': '设为免登记白名单',
				'click': ui.createHandlerFn(self, function() { return self.showDeviceWhitelistModal(dev, 1); })
			}, '加白'));
		}

		if (isBlocked) {
			opsNode.appendChild(E('button', {
				'class': 'btn cbi-button cbi-button-positive',
				'click': ui.createHandlerFn(self, function() { return self.showUnblockConfirmModal(mac); })
			}, '解黑'));
		} else {
			opsNode.appendChild(E('button', {
				'class': 'btn cbi-button cbi-button-negative',
				'click': ui.createHandlerFn(self, function() { return self.showBlockModal(mac); })
			}, '拉黑'));
		}

		// 拉黑状态设备（policy==='block'）禁用此按钮，避免策略冲突（后端会拒绝 E_CONFLICT）
		var isBlockedPolicy = (dev.policy === 'block' || (!dev.identity && String(dev.trusted) !== '1'));
		var egressBtn = E('button', {
			'class': 'btn cbi-button ' + (isBlockedPolicy ? 'cbi-button-disabled' : (isWifiOnly ? 'cbi-button-apply' : 'cbi-button-neutral')),
			'disabled': isBlockedPolicy ? 'disabled' : null,
			'title': isBlockedPolicy ?
				'请先解除封禁，并登记设备或加入白名单' :
				(isWifiOnly ? '恢复设备正常出口（默认路由）' : '设置为仅指定出口，分流不可用时阻断'),
			'click': isBlockedPolicy ? null : ui.createHandlerFn(self, function() { return self.showSetEgressModal(mac, egress); })
		}, isWifiOnly ? '恢复正常' : '降级出口');
		opsNode.appendChild(egressBtn);

		opsNode.appendChild(E('button', {
			'class': 'btn cbi-button',
			'title': '修改设备标签与备注',
			'click': ui.createHandlerFn(self, function() { return self.showNoteModal(dev); })
		}, '改备注'));

		opsNode.appendChild(E('button', {
			'class': 'btn cbi-button cbi-button-negative',
			'title': '取消设备登记，回到未识别状态',
			'click': ui.createHandlerFn(self, function() { return self.showForgetModal(mac); })
		}, '移除设备记录'));

		return E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td' }, this.renderMac(dev)),
			E('td', { 'class': 'td' }, hostnameDisplay),
			E('td', { 'class': 'td' }, idNameNode),
			E('td', { 'class': 'td' }, trustedBadge),
			E('td', { 'class': 'td' }, policyNodes),
			E('td', { 'class': 'td' }, this.renderNote(dev)),
			E('td', { 'class': 'td' }, this.renderObservedTimes(dev)),
			E('td', { 'class': 'td' }, this.renderAddresses(dev)),
			E('td', { 'class': 'td right' }, this.compactOperations(opsNode, dev))
		]);
	},

	// 弹窗：移除设备记录二次确认 (forget)
	showForgetModal: function(mac) {
		var self = this;
		var cleanMac = (mac || '').toUpperCase();

		var confirmText = '移除后设备将回到未识别状态，重新连接 WiFi 时会再次弹出门户登记页。观察历史保留，设备授权记录删除，身份条目不受影响。确认移除设备记录 ' + cleanMac + '？';

		var modalContent = E('div', {}, [
			E('p', { 'style': 'max-width:440px;line-height:1.6;' }, confirmText),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.hideModal
				}, '取消'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-negative',
					'click': function() {
						ui.hideModal();
						return callPortalForget(cleanMac).then(function(res) {
							if (self.checkRpcResult(res, '设备 ' + cleanMac + ' 记录已移除（按未登记设备处理）')) {
								self.refreshIdentitiesAndDevices();
								self.refreshUnidentifiedPool(true);
								self.refreshAllStatus();
							}
						}).catch(function(err) {
							self.checkRpcResult(err);
						});
					}
				}, '确认移除设备记录')
			])
		]);

		ui.showModal('移除设备记录确认', modalContent);
	},

	showSetEgressModal: function(mac, currentEgress) {
		var self = this;
		var cleanMac = (mac || '').toUpperCase();
		var isWifiOnly = (currentEgress === 'wifi-only');
		var targetEgress = isWifiOnly ? 'normal' : 'wifi-only';

		var confirmText = isWifiOnly ?
			('恢复 ' + cleanMac + ' 的正常出口（默认路由）。确认？') :
			('将该设备交给 Mihomo 的指定出口策略。分流未就绪时阻断普通上网，旧连接可能断开。确认设置 ' + cleanMac + '？');

		var successMsg = isWifiOnly ? '已恢复正常出口' : '出口设置已保存，请查看分流就绪状态';

		var modalContent = E('div', {}, [
			E('p', { 'style': 'max-width:440px;line-height:1.6;' }, confirmText),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.hideModal
				}, '取消'),
				' ',
				E('button', {
					'class': 'btn cbi-button ' + (isWifiOnly ? 'cbi-button-action' : 'cbi-button-negative'),
					'click': function() {
						ui.hideModal();
						return callPortalSetegress(cleanMac, targetEgress).then(function(res) {
							if (self.checkRpcResult(res, successMsg)) {
								self.refreshIdentitiesAndDevices();
								self.refreshAllStatus();
							}
						}).catch(function(err) {
							self.checkRpcResult(err);
						});
					}
				}, isWifiOnly ? '确认恢复' : '确认降级')
			])
		]);

		ui.showModal(isWifiOnly ? '恢复正常出口确认' : '设备出口降级确认', modalContent);
	},

	// 弹窗：解除拉黑确认 (unblock)
	showUnblockConfirmModal: function(mac) {
		var self = this;
		var cleanMac = (mac || '').toUpperCase();

		var modalContent = E('div', {}, [
			E('p', {}, [
				'确定要解除对设备 ',
				E('strong', { 'class': 'portal-tag-mac' }, cleanMac),
				' 的黑名单限制吗？'
			]),
			E('div', { 'class': 'portal-hint-box' },
				'解除门户添加的封禁，按保留的身份、白名单和出口设置恢复权限。'
			),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, '取消'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': function() {
						ui.hideModal();
						return callPortalUnblock(cleanMac).then(function(res) {
							if (self.checkRpcResult(res, '设备 ' + cleanMac + ' 已成功解除拉黑')) {
								self.refreshIdentitiesAndDevices();
								self.refreshUnidentifiedPool(true);
								self.refreshAllStatus();
							}
						}).catch(function(err) {
							self.checkRpcResult(err);
						});
					}
				}, '确认解黑')
			])
		]);
		ui.showModal('解除拉黑确认', modalContent);
	},

	// 刷新身份与设备表
	refreshIdentitiesAndDevices: function() {
		var self = this;
		return Promise.all([
			callPortalIdentities(),
			callPortalInventory()
		]).then(function(results) {
			if (!self.checkRpcResult(results[0]) || !self.checkRpcResult(results[1])) return;
			if (results[0] && Array.isArray(results[0].identities)) {
				self.identitiesList = results[0].identities;
				self.updateIdentitiesTableRows();
			}
			if (results[1] && Array.isArray(results[1].devices)) {
				self.applyInventory(results[1]);
			}
			self.notify('身份与设备数据已同步更新', 'info');
		}).catch(function(err) {
			self.checkRpcResult(err);
		});
	},

	// =====================================================================
	// 5. 门户文案配置 (Portal Page Text)
	// =====================================================================
	renderPageConfigSection: function() {
		var self = this;
		var p = this.pageConfig || {};

		var titleInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'value': p.title || '',
			'placeholder': '例如：设备身份门户 (1-64 字符)',
			'style': 'width: 100%; max-width: 500px;'
		});

		var promptTextarea = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': 3,
			'placeholder': '例如：请输入您的姓名以完成 WiFi 登记 (1-256 字符)',
			'style': 'width: 100%; max-width: 600px;'
		}, [p.prompt || '']);

		var formNode = E('div', { 'class': 'cbi-section-node' }, [
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, '门户页面标题 (Title)'),
				E('div', { 'class': 'cbi-value-field' }, [
					titleInput,
					E('div', { 'class': 'cbi-value-description' }, '出现在热点登录重定向拦截页及探测页的主标题 (1–64 字符)')
				])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, '登记引导提示语 (Prompt)'),
				E('div', { 'class': 'cbi-value-field' }, [
					promptTextarea,
					E('div', { 'class': 'cbi-value-description' }, '表单输入框上方的提示与说明文案 (1–256 字符)')
				])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, ''),
				E('div', { 'class': 'cbi-value-field' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-apply',
						'click': function() {
							var newTitle = (titleInput.value || '').trim();
							var newPrompt = (promptTextarea.value || '').trim();

							if (!newTitle) {
								self.notify('门户标题不能为空 (1–64 字符)', 'warning');
								titleInput.focus();
								return;
							}
							if (newTitle.length > 64) {
								self.notify('门户标题不能超过 64 字符', 'warning');
								titleInput.focus();
								return;
							}
							if (!newPrompt) {
								self.notify('提示文案不能为空 (1–256 字符)', 'warning');
								promptTextarea.focus();
								return;
							}
							if (newPrompt.length > 256) {
								self.notify('提示文案不能超过 256 字符', 'warning');
								promptTextarea.focus();
								return;
							}

							return callPortalSetpage(newTitle, newPrompt).then(function(res) {
								if (self.checkRpcResult(res, '文案配置已保存：已重新生成，刷新登记页即可见')) {
									self.pageConfig.title = newTitle;
									self.pageConfig.prompt = newPrompt;
								}
							}).catch(function(err) {
								self.checkRpcResult(err);
							});
						}
					}, '保存文案并重新生成门户页面')
				])
			])
		]);

		return E('div', { 'class': 'cbi-section', 'data-portal-section': 'page' }, [
			E('div', { 'class': 'portal-header-row' }, [
				E('div', {}, [
					E('h3', { 'style': 'margin:0;' }, '门户配置'),
					E('span', { 'style': 'font-size:12px; color:#6b7280;' },
						'设置访客看到的标题和登记提示，保存后刷新门户页面即可查看。'
					)
				])
			]),
			formNode
		]);
	},

	// =====================================================================
	// 6. 审计日志 (Audit Log)
	// =====================================================================
	renderAuditSection: function() {
		var self = this;
		var audit = this.auditData || { lines: [], total: 0 };

		var grepInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': '过滤关键字 (grep)...',
			'style': 'min-width: 200px;',
			'value': this.auditGrepText || ''
		});

		var tailSelect = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 50, 'selected': (this.auditTailCount === 50 ? '' : null) }, '最近 50 条'),
			E('option', { 'value': 100, 'selected': (this.auditTailCount === 100 ? '' : null) }, '最近 100 条'),
			E('option', { 'value': 200, 'selected': (this.auditTailCount === 200 ? '' : null) }, '最近 200 条'),
			E('option', { 'value': 500, 'selected': (this.auditTailCount === 500 ? '' : null) }, '最近 500 条')
		]);

		var refreshBtn = E('button', {
			'class': 'btn cbi-button cbi-button-reset',
			'click': function() {
				self.auditGrepText = (grepInput.value || '').trim();
				self.auditTailCount = parseInt(tailSelect.value, 10) || 200;
				return self.refreshAuditLogs();
			}
		}, '查询 / 刷新');

		var logText = (audit.lines && audit.lines.length > 0) ?
			audit.lines.join('\n') :
			'暂无审计日志条目';

		var logBox = E('pre', { 'class': 'portal-log-viewer' }, [logText]);
		this.auditLogViewerNode = logBox;

		var totalInfo = E('span', { 'style': 'font-size:12px; color:#6b7280;' },
			'日志总数: ' + (audit.total || (audit.lines ? audit.lines.length : 0)) + ' 行 (存储于 tmpfs /var/run/identity-portal/audit.log)'
		);
		this.auditTotalInfoNode = totalInfo;

		return E('div', { 'class': 'cbi-section', 'data-portal-section': 'audit' }, [
			E('div', { 'class': 'portal-header-row' }, [
				E('div', {}, [
					E('h3', { 'style': 'margin:0;' }, '安全与审计日志'),
					totalInfo
				]),
				E('div', { 'style': 'display:flex; gap:8px; align-items:center;' }, [
					grepInput,
					tailSelect,
					refreshBtn
				])
			]),
			logBox
		]);
	},

	// 刷新审计日志
	refreshAuditLogs: function() {
		var self = this;
		return callPortalAudit(this.auditTailCount, 0, this.auditGrepText).then(function(res) {
			if (!self.checkRpcResult(res)) return;
			self.auditData = res || { lines: [], total: 0 };
			var text = (self.auditData.lines && self.auditData.lines.length > 0) ?
				self.auditData.lines.join('\n') :
				'暂无符合条件的审计日志条目';
			if (self.auditLogViewerNode) {
				dom.content(self.auditLogViewerNode, [text]);
				self.auditLogViewerNode.scrollTop = self.auditLogViewerNode.scrollHeight;
			}
			if (self.auditTotalInfoNode) {
				dom.content(self.auditTotalInfoNode, [
					'日志总数: ' + (self.auditData.total || (self.auditData.lines ? self.auditData.lines.length : 0)) + ' 行'
				]);
			}
			self.notify('审计日志已刷新', 'info');
		}).catch(function(err) {
			self.checkRpcResult(err);
		});
	}
});
