# 回归测试

使用真实 UCI、jsonfilter、jshn 和 OpenWrt shell 库，替换 nft、ubus、ip、curl、conntrack 与 init 服务命令。每项测试复制独立的临时文件系统，不修改真实 OpenWrt 配置或访问设备。测试覆盖状态组合、非法输入、并发登记、双栈连接清理、分流合并与故障、无线所有权、RPC 权限及一次 UCI 读取约束。

需要本机可执行的 UCI、jsonfilter、jshn、hexdump，以及目标版本的 `/lib/functions.sh` 和 `jshn.sh`。这些可由对应 OpenWrt 源码构建为 host 工具，不要把目标架构程序当成本机工具运行。

```sh
export UCI_BIN=/绝对路径/uci
export JSONFILTER_BIN=/绝对路径/jsonfilter
export JSHN_BIN=/绝对路径/jshn
# 系统没有 hexdump 时，指向启用该 applet 的 BusyBox hexdump 入口。
export HEXDUMP_BIN=/绝对路径/hexdump
export FUNCTIONS_SH=/绝对路径/functions.sh
export JSHN_SH=/绝对路径/jshn.sh
# 可选：指向与 OpenWrt 配置相近的 BusyBox ash，须启用内部 test/[[ 支持。
export PORTAL_TEST_SHELL=/绝对路径/ash
uv run --no-project --python /usr/bin/python3 --no-python-downloads tests/test_portal.py
```

不设置 `PORTAL_TEST_SHELL` 时使用 Bash。Python 仅用标准库。网络命令替身不会验证真实内核转发、Mihomo 的透明代理规则或 procd 生命周期；相应的实机检查见 [维护与安全边界](../docs/维护与安全边界.md)。

当前0.1.4候选回归共 64 项。新增地址优先级、离线租约/邻居、实际端口、AP 失败、未关联拒绝、历史持久化/并发/容量、短访问事件、主机名缓存、IPv6 规范化/冲突、快照复用、关联时长补取及同步退出生命周期。`HEXDUMP_BIN` 仅为测试环境指定真实命令路径；不指定时使用系统 PATH。无 `od` 场景会故意让任何 od 调用失败，避免开发机补齐了命令却掩盖目标设备缺失的问题。

## 管理页面隔离回归

`overview-fixture.js` 提供合成设备和模拟 RPC，加载真实 overview.js 后在浏览器执行 `createPortalOverviewFixture(source)`；夹具页面需有 `fixture-root` 和 `fixture-modal` 两个容器，加载现有 LuCI 主题即可，不依赖真实路由器。运行 `runPortalOverviewTests()` 返回 36 项检查，覆盖分区顺序、在线/历史互斥及迁移、合并列、当前 IPv6 逐行/压缩搜索、历史去重、HTML 安全、重复弹窗、底部卸载草稿与原写入口。

另外在桌面与手机视口对照 `scrollWidth/clientWidth`：桌面全量设备表不强制横向滚动，手机仅允许表格内部滚动、整页不溢出，表头保留。测试不安装新框架，也不操作现场登记或服务。

页面回归包含历史默认折叠/布局、展开状态跨刷新、MAC/备注只读详情、长备注和 16 个历史地址不撑默认行、四条当前地址全部可见及已删除设备状态清理。浏览器测试另验证原生 summary 的键盘 Enter 行为；行高测试是实际主题下合成样本，不代表任意地址数的固定高度承诺。

新增telemetry接口的只读/版本、全设备/地址证据、ACL隔离、历史不改写、单次快照、密钥不返回及失败语义测试；不改变既有36项页面回归。
