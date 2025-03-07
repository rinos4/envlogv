#!/usr/bin/env python  # -*- coding: utf-8 -*-
#
# スイッチボット(BLE式)情報収集
# Copyright (c) 2024 rinos4u, released under the MIT open source license.
#
# 2024.10.20 rinos4u	new

# インストールモジュール
# pip install bluepy

################################################################################
# import
################################################################################
from bluepy.btle import Scanner, DefaultDelegate, BTLEDisconnectError
from logging import config, getLogger
import os
import time
import datetime
import json
import copy

################################################################################
# const
################################################################################
LOG_CONF		= 'log.conf'
LOG_KEY			= 'switchbot'

DEV_CONF		= 'device.json'
DEV_SWITCHBOT	= 'switchbot'

SWEEP_TIME		= 3600	# 1時間以上古いデータは消していく

################################################################################
# globals
################################################################################
# ロガー(SDカード寿命を考慮して原則stdoutのみ)
config.fileConfig(LOG_CONF)
g_logger = getLogger(LOG_KEY)

# SwitchBot温湿度計のデータ
# 過去のデータを保持したまま、最新に更新していく
g_lastconf = 0
g_target_map = {}
g_target_dat = {}

################################################################################
# util funcs
################################################################################
# 動的にconf変更する可能性を考慮して、設定は定期的(default:1分毎)に更新チェック
def read_conf():
	global g_lastconf
	# JSON設定が更新されているか確認
	t = os.path.getmtime(DEV_CONF) #必ず0以上
	if t <= g_lastconf:
		return #変更なし

	g_lastconf = t
	g_logger.info("Config: %s", datetime.datetime.fromtimestamp(t))

	# JSON設定を読んで設定変数を上書き
	for v in json.load(open(DEV_CONF, encoding="utf-8"))[DEV_SWITCHBOT]:
		g_target_map[v['addr']] = {
			'key'	: v['key'],
			'type'	: v['type'],
			'name'	: v['name'],
		}
		g_target_dat[v['key']] = {
			'dat'	: {},
			'ut'	: 0,
		}

# 一定時間が経過した古いデータを削除
def sweep_old(dat):
	sweep = time.time() - SWEEP_TIME
	print ( "DEL", dict(filter(lambda v: v[1]['ut'] <= sweep, dat.items())))
	return dict(filter(lambda v: v[1]['ut'] > sweep, dat.items()))

################################################################################
# Switchbot BLE AD parser
################################################################################
# データのコンパクト化のため、使わない属性はコメントしてパース対象外にする

# メータ系共通Manufacturer data情報
def parse_meter_mnf(v):
	return {
		#'type'	: 'meter',
		'sq'	: v[0],						# シーケンスNo. 0-255 (HEMS機器から取得した温湿度データとの区別にも使う)
		#'RFU1'	: v[1],
		#'RFU2'	: v[2] & 0xf0,
		'dcE1'	: (1 if v[3] & 0x80 else -1) * ((v[3] & 0x7f) * 10 + (v[2] & 0xf)), # -127.9～+127.9[℃]
		'rh'	: v[4] & 0x7F,				# 相対湿度 0-99[%]
	}

# メータ付加サービスデータ
def parse_meter_srv(s):
	return {
		#'grp'	: s[2] & 0x0f,				# Group A-D
		'bt'	: s[4] & 0x7f,				# バッテリ残量 0-100[%]
		'ts'	: s[5] >> 6,				# 0:no alart 1:low-temp, 2:high-temp, 3:temp-alart
		'hs'	: s[5] >> 4 & 3,			# 0:no alart 1:low-humi, 2:high-humi, 3:humi-alart
	}

# CO2センサ
def parse_CO2(mnf, srv, size):
	if len(mnf) != size:
		g_logger.error("CO2: size error %s(%d)", mnf.hex(), len(mnf))
		return

	ret = parse_meter_mnf(mnf) | {
		#'type'	: 'CO2',
		'CO2'	: mnf[7] * 0x100 + mnf[8],	# 0-65535 [ppm]
	}

	#if len(srv) > 5: # CO2はmeterと書式が違う
	#	ret |= parse_meter_srv(srv) # オプショナル追加

	return ret

# 温湿度計(標準、Outdoor, Plus共通)
def parse_meter(mnf, srv, size):
	if len(mnf) != size:
		g_logger.debug("Meter: size error %s(%d)", mnf.hex(), len(mnf))
		return

	# メータ共通データ追加
	ret = parse_meter_mnf(mnf)
	if len(srv) > 5:
		ret |= parse_meter_srv(srv) # オプショナル追加
	return ret

# Bulb(スマート電球)
def parse_bulb(mnf):
	if len(mnf) != 5:
		g_logger.error("Bulb: size error %s(%d)", mnf.hex(), len(mnf))
		return

	ret = {
		#'type'	: 'bulb',
		'sq'	: mnf[0],					# シーケンスNo. 0-255
		'on'	: mnf[1] >> 7,				# 0:power off, 1:power on
		'br'	: mnf[1] & 0x7F,			# 1～100[%]
		#'delay': mnf[2] >> 7,				# 0:no delay，1:has delay
		#'net'	: mnf[2] >> 4 & 3,			# 0:Wi-Fi Connecting 1:IoT Connecting 2:IoT Connected
		#'pres'	: mnf[2] >> 3 & 1,			# 0:not preset，1:preset
		#'color': mnf[2] & 0x7,				# 1:white, 2:color, 3:dynamic
		#'rssiQ': mnf[3] >> 7,				# 0:normal；1:Bad
		#'dyn'	: mnf[3] & 0x3F,			# 1～100%
		#'loop'	: mnf[4] >> 2,				# Loop Index
	}
	return ret

# プラグミニ
def parse_plug(mnf):
	if len(mnf) != 6:
		g_logger.error("plug: size error %s(%d)", mnf.hex(), len(mnf))
		return

	ret = {
		#'type'	: 'plug',
		'sq'	: mnf[0],					# シーケンスNo. 0-255
		'on'	: mnf[1] >> 7,				# 0x00 - power off 0x80 - power on
		#'delay': mnf[2] & 1,				# 0:no delay, 1:has delay
		#'timer': mnf[2] >> 1 & 1,			# 0:no timer, 1:has timer
		#'sync'	: mnf[2] >> 2 & 1,			# 0:no sync time, 1:already sync time
		#'rssi'	: mnf[3],					# wifi rssi
		#'over'	: mnf[4] >> 7,				# Whether the Plug Mini is overloaded, more than 15A current overload
		'pwrE1'	:(mnf[4] & 0x7f) * 256 + mnf[5]# 0.0-127.9[W]
	}
	return ret

# 開閉センサ (例:cb23ffffe1b9c0 3dfd640000c4ffffe1bac0)
def parse_contact(mnf, srv):
	if len(mnf) != 7:
		g_logger.error("Contact: size error %s", mnf.hex())
		return

	# サービスデータが無ければ有効なデータが取得できない
	if len(srv) < 11:
		return  {}

	ret = {
		#'type'	: 'contact',
		#'sq'	: mnf[2],						# contactはシーケンスNoではない?
		'bt'	: srv[4] & 0x7f,				# 0-100%
		'dr'	: srv[4] >> 1 & 3,				# 0:door close 1:door open 2:timeout not close
		'lux'	: srv[4] & 1,					# 0:dark 1:light
		'pir'	: (srv[5] >> 7    ) * 0x10000 + srv[6] * 0x100 + srv[7], # Since the last trigger PIR time
		'hal'	: (srv[5] >> 6 & 1) * 0x10000 + srv[8] * 0x100 + srv[9], # Since the last trigger HAL time
		#'enter': srv[10] >> 6 & 3,				# Number of entrances The number of door entry actions (cycle)
		#'goout': srv[10] >> 4 & 3,				# Number of Go out Counter The number of times to go out (cycle)
		#'btn'	: srv[10]      & 7,				# Button push counter Each time the button is pressed (cycle)
	}

	return ret

# ハブmini
def parse_hub(mnf):
	ret = {
		#'type'	: 'hub',
		'sq'	: mnf[0],						# シーケンスNo. 0-255
	}
	return ret

################################################################################
# SwitchBotDelegate
################################################################################
class SwitchBotDelegate(DefaultDelegate):
	def __init__(self):
		DefaultDelegate.__init__(self)

	def handleDiscovery(self, dev, isNewDev, isNewData):
		# 対象アドレス確認
		if dev.addr not in g_target_map:
			g_logger.debug("Unknown addr %s", dev.addr)
			return # 対象アドレスにない
		
		target = g_target_map[dev.addr]

		# Manufactureデータ有無確認
		scandat = dev.scanData
		if 255 not in scandat:
			g_logger.warning("Format error %s", dev.addr)
			return # Manufactureデータが無い

		# サービスデータでデバイスタイプのチェック
		srv = b""
		if 22 in scandat: # Serviceデータあり
			srv = scandat[22]
			if len(srv) > 2:
				if srv[2] != target['type']:
					g_logger.error("Device type mismatch %x!=%x (%s)", srv[2], target['type'], dev.addr)
					return
			else:
				g_logger.warning("Service data too short %d", len(srv))
		else:
			g_logger.debug("No Service Data")

		# デバイス別パーサ処理
		mnf = scandat[255][8:] # 先頭8byte(UID+MAC)は除く
		dat = 0
		#g_logger.debug(f"{dev.addr}:{len(mnf)}-{len(srv)}")
		match target['type']: # bit:7=1の場合は暗号化されている(除外)
			case 0x35: dat = parse_CO2  (mnf, srv, 10)	# CO2センサ
			case 0x54: dat = parse_meter(mnf, srv, 5)	# 温湿度計
			case 0x64: dat = parse_contact(mnf, srv)	# 開閉センサ
			case 0x67: dat = parse_plug (mnf)			# Plug Mini
			case 0x69: dat = parse_meter(mnf, srv, 5)	# 温湿度計プラス
			case 0x6a: dat = parse_plug (mnf)			# Plug Mini2
			case 0x6d: dat = parse_hub  (mnf)			# Hub mini
			case 0x75: dat = parse_bulb (mnf)			# Color Bulb
			case 0x77: dat = parse_meter(mnf, srv, 6)	# 防水温湿度計
			case _:										# 該当なし?
				g_logger.warning("Unknown device type=%x addr=%s", target['type'], dev.addr)

		# 有効データがあったか？
		if not dat:
			g_logger.debug("parse error %s(%s)", dev.addr, mnf.hex())
			return

		# 最新のボット名を設定(動的に設定が変更される想定で毎回更新)
		dat['name'] = target['name']

		# データに更新があるか？
		bot = g_target_dat[target['key']]
		merge = bot['dat'] | dat
		if bot['dat'] == merge:
			g_logger.debug("same data %s", dev.addr)
			return

		# 更新あり
		bot['dat'] = merge # 有効データでのみ更新
		ut = int(time.time()) # unix time
		diff = ut - bot['ut'] if bot['ut'] else -1
		bot['ut'] = ut
		g_logger.info("%s %+ds", dat, diff)

################################################################################
# Get SwitchBot data
################################################################################
def get_switchbot(sec):
	g_logger.info(f"get_switchbot {sec}")
	read_conf()
	scanner = Scanner().withDelegate(SwitchBotDelegate())
	try:
		scanner.scan(sec, passive=False)
	except BTLEDisconnectError as e:
		g_logger.error(f"scan error:{e}")

	return sweep_old(copy.deepcopy(g_target_dat))

################################################################################
# main for debug
################################################################################
if __name__ == "__main__":
	print("Result:\n", json.dumps(get_switchbot(10), sort_keys=False, indent=2, ensure_ascii=False))
