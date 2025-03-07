#!/usr/bin/env python  # -*- coding: utf-8 -*-
#
# EnvLogサーバ
# Copyright (c) 2024 rinos4u, released under the MIT open source license.
#
# 2024.10.20 rinos4u	new

# インストールモジュール
#pip install flask
#pip install Flask-HTTPAuth

# 外部アクセス＆HTTPS化 → https://ngrok.com/   ([Sign Up for free]で無料アカウント利用可)
# インストール(ngrokサイトから取得)：[Securty Tunnel] - [Agents] - [Download an Agent] - [RasberryPi] - [Download] - [ARM64(ARMv8)]
# $ sudo mv ngrok /usr/local/bin/
# 認証トークン取得(ngrokサイトで設定)：[Getting Started] - [Your Authtoken]
# $ ngrok config add-authtoken XXXX

# ドメインを固定化(ngrokサイトで設定)：[Univresal GateWay] - [Domains] - [Create Domain]
# $ ngrok http --url=XXXX.ngrok-free.app 8080

################################################################################
# import
################################################################################
from flask import Flask, send_from_directory, jsonify, make_response
from flask_httpauth import HTTPBasicAuth
from datetime import datetime, timedelta
import threading
import time
import json

import os
import gzip
import shutil

import aiseg2
import switchbot

################################################################################
# const
################################################################################
MAX_DATA = 60 * 24	# 1日分
REC_FILE = 'record.txt'
ARC_PATH = 'archive'
ARC_FILE = 'rec%s.txt.gz'

HTTP_AUTH = 'httpauth.json'
HTTP_PORT = 8080

################################################################################
# globals
################################################################################
app  = Flask(__name__)
auth = HTTPBasicAuth()
app.config['JSON_AS_ASCII'] = False
app.config['SECRET_KEY'] = 'secret key'

# ダイジェスト認証のuser/passリスト読み込み（平文‥）
g_httpauth = json.load(open(HTTP_AUTH, encoding="utf-8"))
# メモリ上でデータを保持するリスト
g_data = []

# SwditchBot(Bluetooth)とAiSEG(WiFi)の干渉を防ぐため順にポーリング
def collect_iot():
	# 1分間隔でデータを収集
	global g_data
	while True:
		# スイッチボットキャプチャ(BLEスキャン)
		left = 60 - datetime.now().second
		if left > 0:
			bot = switchbot.get_switchbot(left)
		else:
			bot = {}
		
		# AiSEG取得(HTTPパース)
		as2 = aiseg2.get_aiseg2()

		# データ更新
		next = [int(time.time()), bot | as2]
		g_data.append(next)

		# 最大数を超えたら古いデータを削除
		if len(g_data) > MAX_DATA:
			g_data.pop(0)

		# 強制終了を考慮してRAM disk保存 (定期的にアーカイブしたら削除)
		with open(REC_FILE, 'a') as f:
			if  f.tell(): # 継続ならJSON整形用にコンマ追加
				f.write(',\n')
			f.write(json.dumps(next, ensure_ascii=False))
			f.flush()
		
		# 24時間毎に圧縮してアーカイブを作る(途中から始めた場合も23:59分時点でアーカイブ)
		now = datetime.now()
		if now.hour == 23 and now.minute == 59:
			with open(REC_FILE, 'rb') as fin:
				os.makedirs(ARC_PATH, exist_ok=True)
				with gzip.open(ARC_PATH + '/' + ARC_FILE % now.strftime('%Y%m%d'), mode='wb') as fout:
					shutil.copyfileobj(fin, fout)
					fout.flush()
			os.remove(REC_FILE)

@auth.get_password
def get_pw(username):
    return g_httpauth.get(username)

@app.route('/')
@auth.login_required
def index():
	return send_from_directory('.', 'index.html')
	#return render_template('index.html')

@app.route('/<path:path>')
@auth.login_required
def send_static_root(path):
    return send_from_directory('.', path)

@app.route('/static/js/<path:path>')
@auth.login_required
def send_static_js(path):
    return send_from_directory('static/js', path)

@app.route('/static/css/<path:path>')
@auth.login_required
def send_static_css(path):
    return send_from_directory('static/css', path)

@app.route('/chk/<int:year>')
@auth.login_required
def get_available(year):
	return jsonify([])

@app.route('/arc/<int:dt>')
@auth.login_required
def get_archive(dt):
	# 圧縮アーカイブされた指定日のデータを返す
	print("XHR ARC %d" % (dt))
	if dt: # 指定あり
		try:
			with open(ARC_PATH + '/' + ARC_FILE % str(dt), mode='rb') as f:
				# 効率のためにjsonifyせず素のアーカイブで返す(クライアントで考慮)
				# ファイル前後にJSON配列にするための括弧("[", "]")が必要なことに留意
				return make_response(f.read()) 
		except Exception as e:
			print("get_archive error")

	return make_response('', 204) #No Content

@app.route('/list/<int:year>')
@auth.login_required
def get_list(year):
	# 圧縮アーカイブが存在する年月日を返す
	print("XHR list %d" % (year))
	try:
		valid = [v[3:11] for v in os.listdir(ARC_PATH)]
		if year:
			valid = filter(lambda v: int(v[:4]) == year)
		jsondat = jsonify(valid).data
		compdat = gzip.compress(jsondat)
		#headers['Content-Encoding'] = 'gzip' #暗黙の圧縮固定
		return make_response(compdat)

	except Exception as e:
		print("get_list error")

	return make_response('', 204) #No Content

@app.route('/dif/<int:ut>')
@auth.login_required
def get_latest(ut):
	# 指定時刻以降のデータのみを返す
	global g_data
	dt = datetime.fromtimestamp(ut)
	print("XHR Latest %d(%s) %d" % (ut, dt, len(g_data)))
	start = len(g_data)
	while start > 0:
		if g_data[start - 1][0] <= ut: #送信済みのデータを見つけた
			break
		start -= 1

	# start以降のデータを圧縮して返す
	print("ret %d %d" % (start, len(g_data) - start))
	jsondat = jsonify(g_data[start:]).data
	compdat = gzip.compress(jsondat)
	#headers['Content-Encoding'] = 'gzip' #暗黙の圧縮固定
	return make_response(compdat)

################################################################################
# main
################################################################################
if __name__ == '__main__':
	# 保存されたアクティブデータを読み込んでおく
	with open(REC_FILE, 'r') as fin:
		g_data = json.loads('[' + fin.read() + ']')
	
	# バックグラウンドでデータ生成を開始
	data_thread = threading.Thread(target=collect_iot, daemon=True)
	data_thread.start()

	# Webサーバを起動
	app.run(debug=False, host='0.0.0.0', port=HTTP_PORT, threaded=True)
	data_thread.join()
