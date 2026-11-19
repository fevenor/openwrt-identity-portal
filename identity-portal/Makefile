# 基础门户包：运行时只使用 OpenWrt 自带设施。
include $(TOPDIR)/rules.mk

PKG_NAME:=identity-portal
PKG_VERSION:=0.1.4
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only
PKG_MAINTAINER:=fevenor
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)

include $(INCLUDE_DIR)/package.mk

define Package/identity-portal
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=设备身份门户
  URL:=https://github.com/fevenor/openwrt-identity-portal
  DEPENDS:=+firewall4 +nftables +kmod-nft-bridge +uhttpd +jsonfilter +jshn +rpcd +conntrack +flock
  PKGARCH:=all
endef

define Package/identity-portal/description
 无密码设备归属登记、免登记白名单和黑名单管理。
 基础准入不依赖代理服务。可选分流由 Mihomo 执行，启用时另需 curl。
endef

define Package/identity-portal/conffiles
/etc/config/portal
/etc/portal/history.tsv
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/identity-portal/install
	$(INSTALL_DIR) $(1)/etc/config $(1)/etc/init.d $(1)/etc/portal $(1)/etc/uci-defaults
	$(INSTALL_CONF) ./files/etc/config/portal $(1)/etc/config/portal
	$(INSTALL_BIN) ./files/etc/init.d/* $(1)/etc/init.d/
	$(INSTALL_BIN) ./files/etc/portal/portal-* ./files/etc/portal/gen*.sh $(1)/etc/portal/
	$(INSTALL_DATA) ./files/etc/portal/oui.tsv $(1)/etc/portal/
	$(INSTALL_BIN) ./files/etc/uci-defaults/* $(1)/etc/uci-defaults/
	$(INSTALL_DIR) $(1)/usr/share/portal/tmpl $(1)/usr/share/portal/www/cgi-bin/portal
	$(INSTALL_DATA) ./files/usr/share/portal/tmpl/* $(1)/usr/share/portal/tmpl/
	$(INSTALL_BIN) ./files/usr/share/portal/www/cgi-bin/portal/* $(1)/usr/share/portal/www/cgi-bin/portal/
	$(INSTALL_DIR) $(1)/usr/bin $(1)/usr/libexec/portal $(1)/usr/libexec/rpcd
	$(INSTALL_BIN) ./files/usr/bin/* $(1)/usr/bin/
	$(INSTALL_BIN) ./files/usr/libexec/portal/*.sh $(1)/usr/libexec/portal/
	$(INSTALL_DATA) ./files/usr/libexec/portal/*.awk $(1)/usr/libexec/portal/
	$(INSTALL_BIN) ./files/usr/libexec/rpcd/portal $(1)/usr/libexec/rpcd/
endef

define Package/identity-portal/prerm
#!/bin/sh
[ -z "$${IPKG_INSTROOT}" ] || exit 0
[ "$${PKG_UPGRADE}" != 1 ] || exit 0
/etc/portal/portal-uninstall || exit 1
exit 0
endef

$(eval $(call BuildPackage,identity-portal))
