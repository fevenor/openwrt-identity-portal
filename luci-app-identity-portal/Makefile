# LuCI 管理界面，与基础包使用相同的公开版本号。
include $(TOPDIR)/rules.mk

PKG_VERSION:=0.1.4
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
LUCI_TITLE:=设备身份门户
LUCI_DEPENDS:=+luci-base +identity-portal +uhttpd-mod-ubus
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=fevenor
LUCI_URL:=https://github.com/fevenor/openwrt-identity-portal

include $(TOPDIR)/feeds/luci/luci.mk

# 构建扫描入口：call BuildPackage（实际定义由 luci.mk 提供）
