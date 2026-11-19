# OpenWrt 设备身份门户

为 OpenWrt 提供无需密码的设备归属登记、免登记白名单、黑名单，以及可选的指定出口策略。包含基础包 `identity-portal` 与 LuCI 管理包 `luci-app-identity-portal`。

姓名由使用者自行填写，相同姓名归入同一身份。这是设备管理工具，不是实名验证、账号认证或抗 MAC 仿冒系统。适合管理员控制的小型无线网络。

当前正式版本为 **0.1.3**，发布标签为 [`v0.1.3`](https://github.com/fevenor/openwrt-identity-portal/tree/v0.1.3)。这是首次对外发布，包含无密码设备归属登记、免登记白名单、黑名单、可选指定出口、离线观察历史，以及双栈设备信息和紧凑管理页面。默认关闭，不带现场配置、身份记录或控制器密钥。

源码下载：[ZIP](https://github.com/fevenor/openwrt-identity-portal/archive/refs/tags/v0.1.3.zip) / [TAR.GZ](https://github.com/fevenor/openwrt-identity-portal/archive/refs/tags/v0.1.3.tar.gz)。本次发布提供源码；请在匹配固件的 OpenWrt SDK/构建树中打包，不提供特定设备的私有依赖适配包或恢复资料。发布不表示已经验证所有驱动、Nikki 版本和故障组合；已完成检查及部署环境仍需验证的范围见 [验证记录](docs/验证记录.md) 和 [发布说明](docs/发布说明/0.1.3.md)。

当前源码包含 **0.1.4 候选**，新增 [中立设备只读接口](docs/设备只读接口.md)。候选尚未公开发布，当前正式发布仍为 v0.1.3；不能把测试运行版本等同于公开标签。

## 功能与分工

- 门户维护设备登记和准入，普通模式独立运行，不依赖 Nikki 或 Mihomo。
- 黑名单优先于身份和白名单。白名单只免登记，不绕过黑名单或指定出口限制。
- Mihomo 执行分流；Nikki 可选，用于管理 Mihomo 与透明代理接管。门户不实现另一套策略路由。
- 指定出口未就绪时，门户规则收回相关设备的访问许可；正常出口的已登记、白名单设备不依赖 Mihomo 就绪。已卸载连接的例外见下方兼容策略。
- LuCI 提供指派身份、改名、合并、拆分、白名单、拉黑、解封、出口设置和有限操作日志。登记表与未识别历史共用一次快照，每 15 秒刷新。
- 后台记录未登记设备的关联/断开与地址观察，离线仍可管理；历史与准入注册表独立。主机名和地址区分当前观察及最后记录。IPv6 后缀仅作辅助查找，冲突不自动合并身份。

完整行为和操作影响见 [设备状态与操作](docs/设备状态与操作.md)，按步骤配置降级出口见 [Mihomo/Nikki 专题教程](docs/Mihomo与Nikki.md)，包括直接运行、Nikki 覆写与安全目录、按设备启用和故障排查。

## 使用前提

使用 firewall4、nftables **1.0.8 或更新版本**、支持 bridge nft 的内核、rpcd、hostapd ubus 和 procd。软件包声明基础依赖。运行环境还需具备 OpenWrt 默认 BusyBox 的 `hexdump` 文本转储命令，姓名及页面文本校验使用它读取 UTF-8 字节。接口和桥名必须按本机配置填写，当前支持一个桥上的多个 AP 接口。

流量卸载由用户决定。默认 `offload_policy=allow`，允许系统开启软件/硬件卸载并正常启动门户，不改动全机加速设置。已卸载连接可能绕过逐包准入检查，因此拉黑、切换出口或分流许可到期不保证及时作用于这些旧连接；UI 会显示这一限制。

如果更重视访问撤销的一致性，可在 LuCI 选择“要求关闭流量卸载”（`offload_policy=require-off`），并先在系统防火墙中关闭软件与硬件卸载、保存应用。此模式会拒绝在卸载开关开启时启用或重建门户规则，但不会自动关闭系统卸载。运行中把严格策略改成允许卸载，不会开启卸载；反过来也不会替用户关闭卸载。配置缺少该选项时按默认允许卸载处理，升级后应检查所需策略。

其他快速转发、驱动内转发和同 AP 客户端互访须由网络配置隔离；推荐专用访客网络并启用 AP 客户端隔离。不要将本工具当作二层安全隔离的替代品。

当前要求 IPv4 管理地址；登记入口监听该地址的 8081 端口，并在 IPv6 8081 提供同一页面。需由现有 firewall4 区域策略允许受控网络访问本机 DHCP、DNS 和门户端口；门户规则不会覆盖其他防火墙的拒绝。不支持纯 IPv6 管理网络。

## 构建

在匹配设备固件的 OpenWrt SDK 或构建树中，将本仓库接入 feed。以下在构建树根目录执行：

```sh
printf '\nsrc-git identity_portal https://github.com/fevenor/openwrt-identity-portal.git;v0.1.3\n' >> feeds.conf
./scripts/feeds update identity_portal
./scripts/feeds install -p identity_portal identity-portal luci-app-identity-portal
make menuconfig
make package/feeds/identity_portal/identity-portal/compile V=s
make package/feeds/identity_portal/luci-app-identity-portal/compile V=s
```

以上示例固定使用正式发布标签 `v0.1.3`。需要在本地开发时，可替换为 `src-link identity_portal /绝对路径/openwrt-identity-portal`；开发工作树不等于发布版本。两个包的 `PKG_VERSION` 均为 0.1.3，构建修订号分别保留为基础包 r2、LuCI r4，避免已安装测试包升级时被当成旧版本。

选择两个门户包，并使用与当前固件匹配的 feeds。仓库不包含固件或内核模块，不建议跨固件版本直接混用软件包。LuCI 包依赖构建树中的 LuCI feed。

## 首次配置

安装前保存网络、防火墙、无线及门户配置，并保留独立的有线或串口管理通道。安装包不会修改主 uhttpd 监听、网络地址、无线接口或代理配置；会登记自身的 firewall4 include 和每五分钟一次的缺表恢复任务。安装或升级时已有的启用配置可能触发服务启动，迁移旧版本前请先停用。

先从 `ubus list 'hostapd.*'` 和 `ip -4 addr` 确认 AP 运行接口、桥设备和主 IPv4 地址。编辑 `/etc/config/portal`：

```uci
config global 'global'
    option enabled '0'
    option unauth_policy 'drop'
    option lan_device 'br-guest'
    option listen_ipv4 '192.0.2.1'
    list wifi_ifaces 'wlan0'
    option capture_mode 'redirect'
    option sync_interval '15'
    option offload_policy 'allow'

config page 'page'
    option title '设备身份门户'
    option prompt '请输入姓名以登记设备归属'
```

`192.0.2.1` 是文档示例地址，必须换成本机已经配置的桥主 IPv4 地址；`wlan0` 也须替换。默认 `redirect` 模式将未放行设备的 HTTP 请求转到 8081，将 DNS 请求转到本机 53，不劫持 HTTPS。客户端是否自动弹出门户由系统探测行为决定；也可手动访问 `http://桥地址:8081/`。

在有管理恢复通道的情况下，确认接口和卸载兼容策略符合自己的需求，再启用：

```sh
chmod 600 /etc/config/portal
/etc/init.d/portal enable
/etc/portal/portal-admin setenabled 1
```

LuCI 菜单位于“服务 → 设备身份门户”。首次配置仍使用 UCI 文件；UI 不提供完整网络配置向导。

LuCI 页面底部可以保存卸载兼容策略；命令行也可使用 `/etc/portal/portal-admin setoffload allow` 或 `setoffload require-off`。门户已经启用且系统仍配置了卸载时，切换到严格模式会明确拒绝，保留原有策略。

可选 `alias` 模式需要管理员预先配置额外 IPv4 地址 `alias_ipv4`，避免与主 uhttpd 的 80 端口监听冲突，并安装 dnsmasq。门户启动独立 dnsmasq 实例监听 5353，为普通域名返回额外地址。专属 DNS 同时接收受控网络的 IPv4/IPv6 DNS，为 AAAA 返回正常的空结果而不是转发失败；不继承系统 dnsmasq 配置，不影响主 53 端口。此模式不会自动增加 IP 或修改管理服务，也不劫持 HTTPS；客户端弹窗时延仍需真机验证。优先使用默认 `redirect` 模式。

## 检查与恢复

```sh
ubus call portal status
ubus call portal devices
ubus call portal inventory
nft list table inet portal
nft list table bridge portal_mark
logread -e identity-portal
```

`status.enabled` 表示配置开关，须同时检查监听和规则；RPC 错误会带 `error`、`message`。写入成功统一返回 `{"ok":true}`。若报告“已保存，但规则应用失败”，配置已经保存，当前规则可能还是旧版：修正原因后重试该操作或重启门户，不要把配置值当成实际生效证明。

```sh
# 紧急解除门户的运行时拦截，保留记录；不会刷新全机防火墙。
/etc/init.d/portal stop
# 持久关闭配置开关。
/etc/portal/portal-admin setenabled 0
```

停止门户会删除自己的 nft 表、停止自己的 HTTP/DNS/同步进程；无线持久禁连记录和已经加载的 Mihomo 分流可能仍在。先解封、恢复正常出口，再停止，可显式撤销这些限制。完整停用、升级与卸载边界见 [维护与安全边界](docs/维护与安全边界.md)。

## 资源占用

启用门户后，后台观察器订阅受控 AP 的关联/断开事件，并每 15 秒补采一次无线、邻居与 DHCP 快照。只读请求加载一次注册表，复用请求快照和 MAC 索引；身份查询不逐设备调用 UCI。UI 每 15 秒同步登记表、未识别历史和运行状态，页面隐藏时暂停前端刷新，不暂停后台观察。

设备历史最多 512 个 MAC、每台 16 个 IPv6 地址，运行期在 tmpfs 原子更新，每 15 分钟合并保存，正常停止主动保存。异常断电可能丢失最近 15 分钟；容量上限不是完整接入审计或断电零丢失保证。操作审计最多两份约 128 KiB 文件，重启丢失。

可选出口同步间隔默认 15 秒，可设为 5–120 秒，仅在启用且有指定出口需求时运行。规则、页面、许可状态与操作审计保存在 tmpfs。没有新增数据库或独立路由引擎，但历史记录需要上述轻量后台进程和有限持久写入。

未承诺通用吞吐量、512 台规模下的查询延迟或任意插件组合的资源上限。实际开销受硬件、注册表规模、Mihomo 和卸载关闭影响；部署前按实际规模验证。

## 许可

`identity-portal/` 和 `tests/` 使用 [GPL-2.0-only](LICENSES/GPL-2.0-only.txt)；`luci-app-identity-portal/` 使用 [Apache-2.0](LICENSES/Apache-2.0.txt)。项目文档使用 GPL-2.0-only。许可证保留正式英文原文，避免翻译改变法律含义。

## 设备观察与离线历史

观察器随门户运行，后台事件订阅加 15 秒快照补采；最多 512 台设备、每台 16 个 IPv6 地址。历史每 15 分钟合并保存，正常停止主动保存，异常断电可能丢失最近 15 分钟。字段、后缀定义及在线证据见 [设备观察与历史](docs/设备观察与历史.md)。不增加数据库，也不以历史记录或后缀授予准入权限。
