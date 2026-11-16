# 降级出口配置：Mihomo 与 Nikki 专题

## 先了解“降级出口”

页面上的“降级出口”不是限速，也不是自动检测备用线路。它把**这台已登记或已加白的设备**改为只使用管理员指定的 Mihomo 策略；界面恢复正常后，设备继续遵守原网络的路由/代理规则，不一定直接联网。

安装 Nikki 或 Mihomo 本身还不够，必须同时完成：

1. 定义可用的目标出口（已有代理/策略组，或绑定备用网卡的 direct 出站）。
2. 加载门户动态源地址规则文件，并把对应规则放到**最终配置第一条**。
3. 配置门户的本机控制器、密钥与同名目标策略。
4. 保证文件安全路径、启动顺序与双栈 TCP/UDP 透明接管都正确。

仅切换个别设备时，保留 `unauth_policy=drop`，不要为了使用“降级出口”把全部未登记设备也改成指定出口。后面的“按设备启用”只改测试设备，不改全局策略。

本教程适用于管理员控制的小型 OpenWrt 网络，沿用现有 Nikki/Mihomo，不另装路由引擎。包管理器按固件选择 apk 或 opkg；先安装门户及 curl、保存原配置并保留有线/串口恢复入口。所有示例的 `wlan-sta`、`降级出口`、控制器端口和密钥均为占位值，不是任何设备的现场配置。

## 责任范围

门户负责“哪个设备可以访问、哪个设备必须指定出口”。Mihomo 负责“将其连接交给哪个策略、代理或接口”。Nikki 负责生成最终 Mihomo 配置、进程管理与透明代理接管，可以替换为其他服务管理方式。

基础门户依赖中不包含 Nikki、Mihomo 或 curl。需要指定出口时单独安装 curl，并准备本机 Mihomo。若不用 Mihomo，将 `unauth_policy` 保持 `drop`，设备出口保持 `normal`。

本版只支持本机 HTTP 控制器 `http://127.0.0.1:端口` 或 `http://localhost:端口`，不支持远端控制器。密钥允许英文字母、数字及 `_.~-`，从 curl 标准输入配置传递，不出现在 curl 进程参数和 RPC 只读输出中。配置文件权限为 0600。

## 配置约定

门户生成 `/var/run/identity-portal/unauth-src.yaml`。文件在 tmpfs，内容是两类当前在线设备源地址的并集：未登记且启用指定出口的 IPv4 地址，以及已登记/白名单且设置指定出口的 IPv4、IPv6 地址。黑名单不进入集合。

`unauth-src` 是规则集合名，沿用历史命名，现已覆盖全部指定出口设备。管理员不要复用该名称或手动编辑生成文件。

将下面片段合并到**最终生效的** Mihomo 配置，不要覆盖原有完整配置：

```yaml
mode: rule
rule-providers:
  unauth-src:
    type: file
    behavior: classical
    format: yaml
    path: /var/run/identity-portal/unauth-src.yaml
rules:
  - RULE-SET,unauth-src,指定出口
  # 原有规则放在此条之后。
```

“指定出口”必须替换为管理员已经定义、能正常使用的策略或代理名。门户不会生成该策略，也不会自动选择物理接口。若要求固定出口，不应让这个策略在不可用时回落到默认出口。

编辑 `/etc/config/portal`，在 `global` 节中设置：

```uci
    option mihomo_api 'http://127.0.0.1:9090'
    option mihomo_secret ''
    option mihomo_target '指定出口'
    option sync_interval '15'
```

密钥须与本机控制器一致；以上空值只是展示字段。管理员可选择全局 `unauth_policy=wifi-only`，或仅对部分已登记/白名单设备设置 `egress=wifi-only`，两种用途可以共存。

Mihomo 对工作目录外的规则文件执行安全路径检查。应在**配置预检进程和实际运行进程**中都传入 `SAFE_PATHS=/var/run/identity-portal`；若已有其他安全路径，按操作系统路径分隔符追加。OpenWrt 的 `/var` 常指向 `/tmp`，需要确认服务环境及路径解析后的许可范围。

Nikki 各版本的环境变量注入方式可能不同。检查安装版本的配置测试和 procd 启动代码，不要只给启动进程传变量，也不要通过关闭配置预检来规避错误。门户不自动打补丁或修改 Nikki 的订阅、覆写、启动脚本；这些归管理员维护。

门户 init 的启动序号为 95，会提前准备不匹配实际设备的占位规则文件；默认同步服务启动序号为 99。接入服务若启动更早，需要调整依赖顺序。启用门户的开机服务后，先启动门户准备文件，再让 Mihomo 读取配置；检查进程对私有运行目录的读取权限。本版默认假设两者以 root 运行。

## 方案一：直接运行 Mihomo

### 1. 选择或创建目标策略

若已有代理或策略组，例如一个确定不会回落到默认出口的代理，可直接用其名称。以下只是**固定备用网卡直连**示例，合并到已有 Mihomo 配置的 `proxies` 列表，不替换原列表：

```yaml
proxies:
  - name: 降级出口
    type: direct
    interface-name: wlan-sta
```

`wlan-sta` 必须替换为系统实际运行的备用接口名，从 `ip link` 或 `iw dev` 查询。不要写 SSID、UCI 网络节名，或无条件照搬某台路由器的物理接口名。普通 `DIRECT` 表示现有默认路由，并不能保证避开移动数据出口。若采用策略组，不能包含会偷偷回落默认线路的成员；备用接口断开时也必须实际验证没有换用默认出口，绑定字段不等于已完成故障验收。

### 2. 加载门户规则并置于首条

合并下列片段；若已有相同节，添加相应项而非重复 YAML 顶级键：

```yaml
mode: rule
rule-providers:
  unauth-src:
    type: file
    behavior: classical
    format: yaml
    path: /var/run/identity-portal/unauth-src.yaml
rules:
  - RULE-SET,unauth-src,降级出口
  # 原有规则继续保留在此条之后，不替换原列表。
```

`unauth-src` 是门户拥有的动态源地址集合名，不要手工上传一份同名旧文件。`降级出口` 三处名称（出口、首条规则、门户 target）必须完全一致。

### 3. 预检和正式服务使用同一安全路径

门户先启动准备占位文件，再检查实际配置。下面只运行预检，不另起第二个 Mihomo 进程；把路径换成你服务实际使用的目录/配置：

```sh
SAFE_PATHS=/var/run/identity-portal mihomo -t -d /已有工作目录 -f /已有配置目录/config.yaml
```

之后将 `SAFE_PATHS` 持久加入**现有服务的环境变量**，再通过原服务管理方式重新启动/加载。不要只在交互终端 `export`，也不要运行另一个前台 Mihomo 代替既有服务。已有 SAFE_PATHS 时在 OpenWrt/Linux 用冒号追加并保留原许可；密钥不放进命令参数。

## 方案二：通过 Nikki 管理 Mihomo（推荐使用覆写来源）

Nikki 通常从订阅/配置文件、覆写选项和覆写文件生成最终配置。只编辑 `/etc/nikki/run/config.yaml` 会在重启或订阅更新后丢失，必须维护生成来源。菜单名称和字段可能随 Nikki 版本变化，以下先描述页面操作，再说明相应文件约定。

### 1. 准备目标与规则覆写

在 Nikki 的覆写文件编辑页，把下面内容**合并**到原覆写文件，然后在覆写设置中启用“覆写文件内容”。不要覆盖已有代理、DNS 或规则。此方式使用 Nikki 专用的追加键，避免普通 `rules`/`proxies` 列表覆盖整个订阅：

```yaml
# 已有同名目标时不重复添加 nikki-proxies，直接引用其名称。
nikki-proxies:
  - name: 降级出口
    type: direct
    interface-name: wlan-sta
mode: rule
rule-providers:
  unauth-src:
    type: file
    behavior: classical
    format: yaml
    path: /var/run/identity-portal/unauth-src.yaml
nikki-rules:
  - RULE-SET,unauth-src,降级出口
  # 原有本地追加规则放在此条之后。
```

支持此机制的 Nikki 通常将覆写文件保存在 `/etc/nikki/mixin.yaml`，开关为 `nikki.mixin.mixin_file_content`。原有同名 `nikki-proxies`、`nikki-rules`、`rule-providers` 要在各自列表/映射中合并，不重复定义键。LuCI 覆写选项通常比覆写文件优先：若已有一个同名 unauth-src 提供者指向旧文件，需同步修正或移除这个冲突；若 LuCI 自定义规则也有内容，需要确保门户规则最终位于第一条，而不是只在文件里看起来排第一。

也可以用 Nikki 的“追加规则提供者”和“追加规则”界面配置：提供者 name=unauth-src、type=file、behavior=classical、file_format=yaml、file_path=/var/run/identity-portal/unauth-src.yaml；规则 type=RULE-SET、matcher=unauth-src、node=降级出口，拖到首条。**部分版本的文件选择器限定 Nikki 自有目录**，无法选门户 tmpfs 路径；遇到此限制优先用上面的覆写文件，而不是上传静态副本或关闭安全检查。已有出口直接引用，不必为了此功能新增代理。

### 2. 增加安全目录

在 Nikki 的运行设置 → 环境变量配置 → 安全路径（Safe Paths）添加：

```text
/var/run/identity-portal
```

保留所有原有路径。支持此字段的 Nikki 将其写入 `nikki.procd.env_safe_paths`，多个路径用冒号连接。例如：

```uci
config procd 'procd'
    option env_safe_paths '/原有安全目录:/var/run/identity-portal'
```

这段只说明字段，不能用来覆盖已有 procd 节。路径值需要实际存在并正确解析；OpenWrt `/var` 经常指向 `/tmp`。

### 3. 检查配置预检环境，再应用

确认当前 `/etc/init.d/nikki` 的正式运行路径传入 SAFE_PATHS，配置测试命令也拿到同一值。部分版本只给 procd 正式进程设置环境，预检裸执行 Mihomo，这种情况下管理员需要在**实际预检那一行**局部增加环境前缀：

```sh
# 仅为使用这些变量名的 Nikki 版本展示，先备份/对账脚本。
if SAFE_PATHS="$env_safe_paths" $PROG -d "$RUN_DIR" -t >> "$CORE_LOG_PATH" 2>&1; then
    # 保留原有成功/失败分支。
fi
```

不要全文替换未知版本脚本，也不要关闭预检绕过错误。若你的版本已正确传入，无需再补。**Nikki 包升级可能覆盖本地适配**，升级后重新核对；本教程不是通用自动补丁。

先让已正确配置的门户运行，准备文件，再在 Nikki 保存应用并重启一次以更新进程环境，代理连接可能重连。有安全路径变更时，仅热加载规则文件通常不足以改变进程环境。不要同时重载全机网络、停用 IPv6 或清空全机连接表。

### 4. 核对最终配置

查看 Nikki 的最终配置页面或实际运行配置，必须看到：

- `mode: rule`。
- file/classical 的 `unauth-src`，路径为 `/var/run/identity-portal/unauth-src.yaml`。
- 第一条规则为 `RULE-SET,unauth-src,降级出口`。
- 名为“降级出口”的实际出站/策略存在，接口绑定或代理选择符合要求。
- 配置预检与运行进程都许可门户目录；订阅更新后上述设置仍在。

不要把某个普通用户的整份最终配置、订阅、密码或设备清单贴到公开 issue。门户维护的是源地址文件；Nikki 的配置生成和透明接管仍由管理员负责。

## 两种方案共用：配置门户并按设备启用

### 1. 配置门户控制器与目标

在 `/etc/config/portal` 的**已有** global 节补齐字段，不能覆盖身份和设备记录：

```uci
    option mihomo_api 'http://127.0.0.1:9090'
    option mihomo_secret '替换为控制器实际密钥'
    option mihomo_target '降级出口'
    option sync_interval '15'
    option unauth_policy 'drop'
```

端口须匹配实际本机控制器；仅支持 HTTP 回环地址。控制器未启用 secret 时门户也留空；有密钥时两边完全一致，并且本版允许的密钥字符为英文字母、数字和 `_.~-`，不要把上面的中文占位文字当作实际值。用编辑器或受保护文件配置，保持 `/etc/config/portal` 权限 0600，不在 shell 命令、日志或截图中输出密钥。TLS 不能代替控制器调用方鉴权；控制器不得为此直接暴露到公网。

### 2. 仅让一台测试设备降级

先用正常已登记/白名单无线设备测试。LuCI → 设备身份门户 → 全量注册设备 → 对应 MAC 的“更多操作” → “降级出口”。被拉黑或既未登记也未加白的设备不能按设备降级，先处理资格。命令行等价操作如下，MAC 仅为示例：

```sh
/etc/portal/portal-admin setegress 02:00:00:00:00:01 wifi-only
ubus call portal status
```

`wifi-only` 是历史兼容字段，实际含义是“仅指定出口”，不强制目标一定是 Wi-Fi。等待一轮同步（默认 15 秒），查看中文就绪/故障提示，并用客户端实际访问验证出口。不要手工往 nft 的许可集合写设备，绕过同步验证。

恢复：LuCI 同一位置 → “恢复正常”，或：

```sh
/etc/portal/portal-admin setegress 02:00:00:00:00:01 normal
```

最后一个受限设备恢复正常后，同步服务按需停止，显示“未要求指定出口”是正常状态。不要为消除这个提示而把全局未登记策略改成 wifi-only。

### 3. 最小验收清单

1. 正常出口设备不受影响，原有登记不变；目标设备实际经预期出口，而非只看页面“就绪”。
2. 分别测 IPv4、IPv6 TCP 和 UDP；被现有透明代理排除的流量不能证明通过指定出口。
3. 在独立管理通道下模拟目标出口不可用、Mihomo 不可用、同步停止，观察普通上网阻断及许可到期；不允许静默回落移动数据/默认线路。
4. 测重连、IP/IPv6 变化、恢复正常和 Nikki 订阅更新/重启，确认规则来源持久且首条优先级正确。
5. 若承诺更严格的旧连接撤销，需先关闭并应用系统的软件/硬件卸载，再选择页面底部“要求关闭流量卸载”；默认允许卸载不能保证旧连接立即停止。

## 常见故障速查

| 页面提示/现象 | 优先检查 |
| --- | --- |
| 未配置 Mihomo 目标策略名 | portal.global.mihomo_target 非空，与实际策略和首条规则名称一致 |
| 规则文件更新失败：检查文件路径与 SAFE_PATHS | 最终 provider 路径、文件是否已准备、root/进程读取权限、预检和运行环境；不要上传旧副本替代动态文件 |
| 规则数与生成文件不同 | 是否仍在读取旧路径、覆写被更高优先级来源覆盖、文件更新是否成功 |
| 规则必须位于首条并指向配置的目标 | 最终 rules 的第一条，而不是某个覆写片段中的第一条 |
| 控制器不可访问或鉴权失败 | 本机端口、控制器是否运行、两端 secret 一致和字符限制；不把密钥输出排查 |
| 必须处于规则模式 | 将实际运行模式切到 rule，而非 global/direct |
| 同步许可已过期 | 同步服务是否运行、最近错误、配置是否有受限设备；许可默认 40 秒不是旧卸载连接寿命上限 |
| 页面就绪但出口不对 | 核验 TCP/UDP 双栈透明接管、排除规则、策略组回落和绑定接口，而不只检查 API |
| 没有设备要求指定出口，显示未启用 | 正常的按需停止；选择测试设备后才需要同步 |

只读查看 `ubus call portal status`、`logread -e identity-portal` 和既有控制器界面即可先定位。日志包含 MAC，发布问题前脱敏；不要输出完整 `/etc/config/portal` 或控制器配置。

## 透明代理的必要条件

控制器可访问不等于设备流量已经被接管。管理员必须保证受控设备的 IPv4、IPv6 TCP/UDP 进入 Mihomo，且其源地址规则排在其他分流规则之前。只配置 TCP 重定向、只接管 IPv4，或启用会绕过代理的目的地址/源地址排除规则，都不满足指定出口约定。

门户不接管 Nikki 的路由、DNS、TUN 或 TProxy 配置。本版不自动检测所有插件组合下的透明代理链是否完整，也不保证任意 Nikki 版本兼容。启用前须用测试终端实际验证两个 IP 协议族、UDP、目标出口不可用、Mihomo 停止与重启场景。

防火墙中门户预留包标记位 `0x40000000`，在 bridge prerouting 标记，在 inet prerouting 的 -160/-155 优先级执行捕获与准入。正常放行进入分流前清除此位。其他插件不得覆盖该位、抢先接受被拦截流量或绕过此路径。

门户默认允许保留系统流量卸载，以免影响整机转发性能。软件/硬件卸载可能让已建立连接绕开这些链；API 检查通过也不能证明旧卸载连接会在故障时停止。用户若要求更严格的故障阻断，需关闭并应用系统卸载设置，再选择门户的“要求关闭流量卸载”。门户不修改 firewall4 的卸载规则，也不自动排除个别网络。

## 同步与故障行为

每轮更新源地址文件，并通过控制器执行规则集合更新、检查规则模式、文件型 classical 集合和条目数、检查首条规则名称及目标。通过后原子更新内核 MAC+IP 许可集合。地址变化先撤销旧许可；规则重建后从无许可开始。文件路径一致性、实际出口和透明接管正确性仍属上面的部署约定，API 条目数检查不是对真实流量的验证。

许可期限为 `2 × sync_interval + 10` 秒，默认 40 秒。API 超时、规则未加载或优先级错误会触发收回许可；同步进程意外终止则由内核到期清理。已卸载的连接可能继续传输，不受这个到期检查的约束。API 每次请求最多等待 3 秒，远端查询不持有注册表写锁。状态检测有周期延迟，不能保证 Mihomo 故障瞬间零泄漏，尤其是接管规则被外部删除但 API 仍正常的情况。

改变设备策略会尝试删除该设备的 IPv4/IPv6 conntrack 和 Mihomo 连接，包括已知的全局地址与 ULA。连接清理是尽力执行，有时间预算；尚未被邻居表观察到的地址无法据此定位。已有连接可能断开，客户端需要重连。恢复最后一个设备的正常出口也会撤销生成文件中的旧源地址项。

正常停止门户保留已生成文件，Mihomo 已有规则可能继续影响设备；tmpfs 文件在重启后重新准备。完全退出集成时，先恢复设备正常出口，再在 Mihomo 配置中删除对应规则和规则集合、重新加载配置，最后卸载门户。不要留下一个指向已卸载程序生成目录的启动依赖。

## 参考依据

- [Mihomo 规则集合文档](https://wiki.metacubex.one/config/rule-providers/)：文件提供者、行为格式、安全路径。
- [Mihomo 控制器规则集合接口源码](https://github.com/MetaCubeX/mihomo/blob/Meta/hub/route/provider.go)：更新接口及查询响应结构。
- [Mihomo 提供者类型定义](https://github.com/MetaCubeX/mihomo/blob/Meta/constant/provider/interface.go)：文件型与 classical 类型标识。

以上用于核对接口约定，运行时仍以所安装版本的实际行为为准。

## 运行状态与按需进程

运行状态返回中文 `integration_message`，分别说明目标缺失、更新失败（包含路径/安全目录检查）、规则类型或数量不符、规则顺序/目标错误、许可到期等；不返回控制器地址、密钥或原始错误响应。`ext_ok` 仍只表示同步许可有效，不是安全路径或真实流量验证，因此旧 `safepaths_ok` 字段不再用许可期限冒充已通过路径检查。

最后一个设备恢复正常出口后，管理入口显式停止同步服务并撤销旧源地址集合；守护进程在暂时无任务时等待显式停止，不把正常退出误报为崩溃循环。部署仍须对齐最终 provider 文件路径与预检/运行 SAFE_PATHS，门户不自动修改外部订阅或启动脚本。
