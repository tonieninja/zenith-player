#!/bin/sh
# reguła udev działa dopiero od następnego zdarzenia, więc już podłączony pad nie dostałby uaccess
udevadm control --reload-rules >/dev/null 2>&1 || :
udevadm trigger --subsystem-match=hidraw --action=change >/dev/null 2>&1 || :
exit 0
