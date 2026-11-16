#!/bin/sh
# 兼容旧入口；所有规则文件更新都由同一个同步程序负责。
exec /etc/portal/portal-sync-unauth --force
