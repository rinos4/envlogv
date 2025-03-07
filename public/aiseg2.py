#!/usr/bin/env python  # -*- coding: utf-8 -*-
#
# AiSEG2(HEMS)情報収集
# Copyright (c) 2024 rinos4u, released under the MIT open source license.
#
# 2024.10.20 rinos4u	new

# インストールモジュール
# pip install requests
# pip install lxml

################################################################################
# import
################################################################################
from logging import config, getLogger
import requests
from lxml import html
import time
import json
import copy

################################################################################
# const
################################################################################
LOG_CONF	= 'log.conf'
LOG_KEY		= 'aiseg2'

DEV_CONF	= 'device.json'
DEV_AISEG2	= 'aiseg2'

AISEG_GEN	= 'page/electricflow/111'
AISEG_USE	= 'page/electricflow/1113?id=%d&request_by_form=1'
AISEG_CON	= 'page/airenvironment/43'

GET_RETRY	= 2

ERROR_FILE	= 'aisegerr.txt'

################################################################################
# globals
################################################################################
# ロガー(SDカード寿命を考慮して原則stdoutのみ)
config.fileConfig(LOG_CONF)
g_logger = getLogger(LOG_KEY)

# AiSEG定義リスト(基本的に家に１つだけなので、DEV_AISEG2キーに限定して参照)
g_conf = json.load(open(DEV_CONF, encoding="utf-8"))[DEV_AISEG2]

################################################################################
# AiSEG Parser
################################################################################
def update_aiseg2():
	ret = {}
	for v in g_conf:
		# 発電量取得(電気の流れページ)
		retry = GET_RETRY
		while True:
			try:
				res   = requests.get('http://%s/%s' % (v['addr'], AISEG_GEN), auth=requests.auth.HTTPDigestAuth(*v['sec']))
				xml   = html.fromstring(res.content)
				gen_t = xml.xpath('//div[@id="g_d_1_capacity"]')[0].text[:-1]
				gen_w = int(gen_t) if gen_t and gen_t[0] != '-' else 0	#発電量[W]
				dat   = {'gen': [[gen_w, xml.xpath('//div[@id="g_d_1_title"]')[0].text]]} # 太陽光発電は基本1つのため固定

				# 未接続回路の集計用に総使用量[kW]値を取得しておく
				use_t  = xml.xpath('//div[@id="u_capacity"]')[0].text
				useall = float(use_t) if use_t and use_t[0] != '-' else 0 #総使用量[kW]
				break

			except requests.exceptions.RequestException as e:
				g_logger.error('request.get err1 http://%s/%s' % (v['addr'], AISEG_GEN))

			except ValueError as e: # 恐らくxml.pathで予期しないフォーマットのデータを取得
				g_logger.error('ValueError 1 http://%s/%s' % (v['addr'], AISEG_GEN))
				# 異常HTMLを記録しておく
				with open(ERROR_FILE, 'wb+') as f:
					f.write(res.content)

			retry -= 1
			if retry < 0:
				return {}

		# 消費量の回路別集計 (詳細ページに消費電力が大きい順に並んでいる)
		idx = 1
		detail = []
		usesum = 0
		while idx: # 一括で取得しないと多重/抜けが発生するリスクあるが、やむを得ず順に走査
			retry = GET_RETRY
			while True:
				try:
					res = requests.get('http://%s/%s' % (v['addr'], AISEG_USE % idx), auth=requests.auth.HTTPDigestAuth(*v['sec']))
					xml = html.fromstring(res.content)
					val = xml.xpath('//div[@class="c_value"]')
					dev = xml.xpath('//div[@class="c_device"]')
					for j in range(min(len(val), len(dev))):
						cat = ''.join(dev[j].xpath('.//text()'))
						num = val[j].text
						num = int(num[:-1]) if num and num[0] != '-' else 0
						if num == 0:
							idx = 0
							break # 以降は省略
						# 有効データのみ追加
						detail.append([num, cat])
						usesum += num
					else:
						idx += 1
					break

				except requests.exceptions.RequestException as e:
					g_logger.error('request.get err2 http://%s/%s' % (v['addr'], AISEG_USE % idx))
					return {}

				except ValueError as e: # 恐らくxml.pathで予期しないフォーマットのデータを取得
					g_logger.error('ValueError2 http://%s/%s' % (v['addr'], AISEG_USE % idx))
					# 異常HTMLを記録しておく
					with open(ERROR_FILE, 'wb+') as f:
						f.write(res.content)

				retry -= 1
				if retry < 0:
					return {}

		# もし四捨五入されたuseallよりusesumが小さければ、モニタ外の回路分として計上
		if v['difcalc']:
			useall = int(useall * 1000)
			if usesum < useall: # 小数２桁で切り上げされている可能性を考慮
				detail.append([useall - usesum,  v['difname']])

		# 消費電力取得
		dat |= {
			'use': detail
		}
		
		# 指定キーでオブジェクトにマージ
		ret[v['key']] = {
			'dat':	dat,
			'ut' :int(time.time()), #unix time
		}
		g_logger.info('%s', dat)

		# エアコンの温湿度がHEMSで取得可能ならデータ追加
		retry = GET_RETRY
		while True:
			try:
				res = requests.get('http://%s/%s' % (v['addr'], AISEG_CON), auth=requests.auth.HTTPDigestAuth(*v['sec']))
				xml = html.fromstring(res.content)
				val = [	xml.xpath('//div[@class="num_ond"]'),\
		   				xml.xpath('//div[@class="num_shitudo"]'), \
						xml.xpath('//div[@class="txt_name"]')] #温度/湿度/名前
				if len(val[0]) == len(val[1]) == len(val[2]):
					for i in range(len(val[0])):
						dat = { # デフォルト無効値にしておく
							'dcE1'	: 999,
							'rh'	: 999
						}
						for j in range(2):
							nums = ""
							for v in val[j][i].getchildren():
								item = v.items()
								if len(item) == 2:
									last = item[1][1][-1]
									if '0' <= last <= '9':
										nums += last
									elif last == 't':
										nums += '.'
									else:	# 想定外の文字
										break
							else:
								try:
									flt = float(nums)
								except ValueError as e: #数値フォーマット異常ならスキップ
									break
								if j:
									dat['rh']   = int(flt)
								else:
									dat['dcE1'] = int(flt * 10)
						
						# 温湿度とも有効データが取得できたら追加する
						if dat['dcE1'] < 999 and dat['rh'] < 999:
							dat |= {'name': val[2][i].text}
							ret['zzAS%d' % i] = { #リスティング時の順位を下げるためデバイス名は先頭"zz"にしておく
								'dat':	dat,
								'ut' :int(time.time()), #unix time
							}
							g_logger.info('%s', dat)
				break
						

			except requests.exceptions.RequestException as e:
				g_logger.error('request.get err3 http://%s/%s' % (v['addr'], AISEG_GEN))

			except ValueError as e: # 恐らくxml.pathで予期しないフォーマットのデータを取得
				g_logger.error('ValueError 3 http://%s/%s' % (v['addr'], AISEG_GEN))
				# 異常HTMLを記録しておく
				with open(ERROR_FILE, 'wb+') as f:
					f.write(res.content)

			retry -= 1
			if retry < 0:
				return ret

	return ret

################################################################################
# Get AiSEG2 data
################################################################################
def get_aiseg2():
	return copy.deepcopy(update_aiseg2())

################################################################################
# main (for debug)
################################################################################
if __name__ == '__main__':
	print('Result:\n', json.dumps(get_aiseg2(), sort_keys=False, indent=2, ensure_ascii=False))
