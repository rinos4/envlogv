///////////////////////////////////////////////////////////////////////////////
// IoTデータJSON受信用
///////////////////////////////////////////////////////////////////////////////
export type WattName = [number, string];

// AiSEG2
export type AisegObj = {
	gen:	WattName[];	// 発電リスト
	use:	WattName[];	// 消費リスト
};

// SwitchBot温湿度計シリーズ
type MeterObj = {
	name:	string;		// デバイス名
	sq:		number;		// シーケンス番号
	dcE1:	number;		// 摂氏*10°
	rh:		number;		// 相対湿度%	
	bt?:	number;		// バッテリ容量%
	ts?:	number;		// 温度アラート (0:no alart 1:low-temp, 2:high-temp, 3:temp-alart)
	hs?:	number;		// 湿度アラート (0:no alart 1:low-humi, 2:high-humi, 3:humi-alart)
};

// SwitchBot CO2センサ
type CO2Obj = {
	name:	string;		// デバイス名
	sq:		number;		// シーケンス番号
	dcE1:	number;		// 摂氏*10°
	rh:		number;		// 相対湿度%	
	CO2:	number;		// CO2濃度ppm
};

// SwitchBotスマート電球
type BulbObj = {
	name:	string;		// デバイス名
	sq:		number;		// シーケンス番号
	on:		number;		// 電源ON状態
	br:		number;		// 明るさ
};

// SwitchBotプラグ(ミニ)
type PlugObj = {
	name:	string;		// デバイス名
	sq:		number;		// シーケンス番号
	on:		number;		// 電源ON状態
	pwrE1:	number;		// 消費電力摂氏*10
};

// SwitchBot開閉センサー
type ContactObj = {
	name:	string;		// デバイス名
	bt:		number;		// バッテリ容量%
	dr:		number;		// ドア状態 (0:door close 1:door open 2:timeout not close)
	lux:	number;		// 明暗 (0:dark 1:light)
	pir:	number;		// PIR時間
	hal:	number;		// HAL時間
};

// 共通シグネチャ
type CommonData = {
	[key: string]: { // 各デバイス名がキー名
		dat:	AisegObj | MeterObj | CO2Obj | BulbObj | PlugObj | ContactObj;
		ut:		number; // 該当データの更新時刻
	}
};

// 集計時刻付きレコード
export type EnvRecord = [number, CommonData];

// アーカイブのキャッシュ
export type ArcCache = {
	[key: string]: { 		// キャッシュファイル名のYYYYMMDDがキー
		dat: EnvRecord[];	// デコード済データ (圧縮状態のまま保持すべきか?)
		ut:   number; 		// キャッシュ追加時刻(古いものから消していく)
	}
};

///////////////////////////////////////////////////////////////////////////////
// Rechart表示用
///////////////////////////////////////////////////////////////////////////////
// 空気線図もどき用
export type PsyChart = {
	dc:		number;		// X軸:摂氏℃
	vh:		number;		// Y軸:容積絶対湿度g/㎥
	idx:	[string, number];// プロット名、ソートID
	rhAL:	number[];	// 相対湿度補助線用
	zone:	number[];	// 快適領域
};

// 電力グラフ用
export type PwrChart = {
	ut:		number;		// X軸(UnixTime)
	pwr:	number[];	// AiSEG計測電力
	plg:	number[];	// SwitchBotプラグ電力
};

// 温湿度グラフ用
export type TRVChart = {
	ut:		number;		// X軸(UnixTime)
	dc:		number[];	// SwitchBot 摂氏
	rh:		number[];	// SwitchBot 相対湿度
	vh:		number[];	// 容積絶対湿度(dcとrhから算出)
};

// CO2グラフ用
export type CO2Chart = {
	ut:		number;		// X軸(UnixTime)
	CO2:	number[];	// SwitchBot CO2濃度
};
