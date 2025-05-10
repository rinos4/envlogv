///////////////////////////////////////////////////////////////////////////////
// import
///////////////////////////////////////////////////////////////////////////////
import React, { useState, useEffect, useRef } from 'react';
import DatePicker from 'react-datepicker';
import {
  XAxis, YAxis,
  Legend,
  //Tooltip, オリジナルで代替
  CartesianGrid,
  ComposedChart,
  AreaChart, Area,
  Line,
  PieChart, Pie, Cell,
  Scatter,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { AisegObj, PsyChart, PwrChart, TRVChart, CO2Chart, EnvRecord, ArcCache } from './types.ts';
import { testdat } from './@SampleDat.ts'; //　dev時は開発用テストデータにエイリアスで切り替え
import './App.css';
import 'react-datepicker/dist/react-datepicker.css';

///////////////////////////////////////////////////////////////////////////////
// 定数
///////////////////////////////////////////////////////////////////////////////
// アプリバージョン(画面表示用)
const ENVLOG_VER = '0.9';

// AiSEG関連設定
const AISEG_KEY     = 'aiseg';  // 電力データ検索用キー（サーバ側と合わせる事）
const FIX_TOP_SOLAR = true;     // 発電無しでも電力グラフの先頭を太陽光にする

// データfetch(画面リフレッシュ) 間隔[ms]
const POLLING_INTERVAL =  60 * 1000;  // アクティブデータ用。1分間隔で継続フェッチ。
const LIST_FETCH_FIRST =   3 * 1000;  // アーカイブリスト用。3秒後開始。
const LIST_FETCH_RETRY = 180 * 1000;  // アーカイブリスト用。3分間隔でエラーリトライ。
const ARC_FETCH_RETRY  =  30 * 1000;  // アーカイブデータ用。オンデマンドで取得。エラー時に30秒間隔で再フェッチ。

// データ保持期間(データに欠落がある場合は、そのぶん古いデータが残る)
const DATA_HOLD_TIME = 7 * 24 * 60;  // 1週間分のデータを保持

// オプションのデフォルト値
const DEF_ANGLE   = 0;          // デフォルト回転なし(ローカルストレージ保存対象)
const DEF_RANGE   = 24 * 60;    // デフォルトの表示期間24H 
const DEF_DATESEL = 0;          // デフォルトは最新情報
const DEF_DATETIME= new Date(new Date().setHours(0, 0, 0, 0)); // デフォルトで当日00:00を選択
const DEF_DELOUT  = 0;          // 外気を除外しない
const DEF_TVRSEL  = 0;          // 全ての温湿度データを使う

// オプションのローカルストレージに保存された値 (日時設定は保存対象としない)
const LS_ANGLE_KEY    = 'angle';    // 角度設定
const LS_DELOUT_KEY   = 'delOut';   // 温湿度グラフの外気除外設定
const LS_TVRSEL_KEY   = 'tvrSel';   // 温湿度のソース種設定
const LS_ANGLE_VAL    = localStorage.getItem(LS_ANGLE_KEY);
const LS_DELOUT_VAL   = localStorage.getItem(LS_DELOUT_KEY);
const LS_TVRSEL_VAL   = localStorage.getItem(LS_TVRSEL_KEY);

// アニメーション速度。画面内のチャートが多くデフォルトだとモッサリするので短めにしておく。
const ANIMATION_DURATION = 200;

// 快適ゾーン定義 ⇒ 「室温:20℃～26℃　かつ 相対湿度:40%～60% かつ 絶対湿度:8g/m³～14g/m³」とした
const PC_ZONE_TMIN = 20;
const PC_ZONE_TMAX = 26;
const PC_ZONE_RMIN = 40;
const PC_ZONE_RMAX = 60;
const PC_ZONE_VMIN = 8;
const PC_ZONE_VMAX = 14;

// 湿り空気線図のグラフ範囲設定。縦軸が容積絶対湿度g/m³であることに注意。
// ※一般的には縦軸に重量絶対湿度[g/kg]をとるが、気積が分かる住宅ではg/m³の方が水分量を把握しやすい
const PC_X_BEGIN  =-10; // X軸最小値-10℃　 (東京なら十分だが…)
const PC_X_END    = 40; // X軸最大値 40℃　 (真夏に越えるか…？)
const PC_Y_BEGIN  = 0;  // y軸最小値 0 g/m³
const PC_Y_END    = 32; // y軸最大値 32g/m³ (真夏に越えるか…？)

// CO2の警告値 WHO基準で設定(SwitchBotのデバイスもWHO基準でアラートを出している)
const CO2_WARNING = 1400;// WHO基準 (厚生省なら1000ppm)
const CO2_CAUTION = 1000;// WHO基準 (厚生省なら 800ppm)

// 対応する表示回転モード
const VIEW_ANGLES = [0, 90, 180, 270]; // 4方向回転サポート
const VIEW_RANGES = [1, 2, 3, 4, 6, 12, 24, 48, 72, 96, 120, 168];

// アーカイブのキャッシュ設定
const ARC_CACHE_SIZE = 20;        // 最大20日分をキャッシュする。(メモリ肥大を避けるため、古いデータは順次削除)

// X軸(時刻)の切れの良い間隔
const DAYTICK_STEP = [1, 5, 10, 15, 20, 30, 60, 60 * 2, 60 * 3, 60 * 4, 60 * 6, 60 * 8, 60 * 12]; // 分単位
const DAY_TIMEZONE = new Date().getTimezoneOffset(); // 日本なら-540分(9時間、分単位)
const ONEDAY_M     = 24 * 60;   // 分退院良く使うので変数にしておく

///////////////////////////////////////////////////////////////////////////////
// Util funcs
///////////////////////////////////////////////////////////////////////////////
// 容積絶対湿度計算
const CalcVH = (t: number, rh: number): number => {
  return 13.253926 * Math.pow(10, (7.5 * t) / (237.3 + t)) * rh / (t + 273.15);
};

// 絶対湿度と相対湿度から温度を計算 (eps=許容誤差：デフォルト0.5 ※補助線用なのでざっくりで良い)
const CalcTFromVH = (vh: number, rh: number = 100, eps: number = 0.5): number => {
  // 二分探索で近似解を求める (空気線図のグラフ範囲で簡易計算)
  let lo = PC_X_BEGIN;
  let hi = PC_X_END;
  
  for(;;) {
    const mid = (lo + hi) / 2;
    if (hi - lo < eps) return mid;

    if (CalcVH(mid, rh) > vh) hi = mid;
    else                      lo = mid;
  }
};

// 小数点桁固定で出力（デフォルト小数点1桁）
const MyRound = (v: number, keta: number = 1): string => {
  return v.toFixed(keta);
};
// 多様する%表記専用
const MyRoundP = (v: number, keta: number = 0): string => {
  return MyRound(v * 100, keta) + '%'
};

// 固定長文字列(先頭に空白を詰める or 小数点以下をカット)
const MyFixStr = (s:string, keta: number = 4, spc:string = '\u2002'): string => {// u2002空白は1/2em (=&nbsp;&nbsp;)
  if (keta < s.length) {
    const dot = s.indexOf('.');
    if (dot > 0) s = s.slice(0, keta > dot? keta : dot);
  }
  if (keta > s.length) return spc.repeat(keta - s.length) + s;
  return s;
};

// Dateから年月日(YYYYMMDDフォーマット)を得る（アーカイブデータ操作用）
const GetYYYYMMDD = (dt: Date): string => {
  return (dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate()).toString();
};
const GetArcUTMfromUTM = (utm: number): number => {
  return ((utm - DAY_TIMEZONE) / ONEDAY_M | 0) * ONEDAY_M;
};
const GetArcNamefromUTM = (ut: number): string => {
  return GetYYYYMMDD(new Date(ut * 60000));
};

// 秒単位UnixTimeから年月日(YYYYMMDDフォーマット)を得る（アーカイブデータ操作用）
const GetDateFromYYYYMMDD = (d: string): Date => {
  return new Date(d.slice(0, 4) + '/' + d.slice(4, 6) + '/' + d.slice(6));
};


// 秒単位UnixTimeから年月日フォーマットを得る(toLocaleStringの「YYYY/M?/D? H?:mm:ss」からの切り出し)
// 月,日,時はゼロ詰めでないことに注意(固定長が必要な場合はGetYYYYMMDDを使う)
const DATE_FMT = [
  [ 0, -3], // 0: YYYY/M?/D? H?:mm
  [-8, -3], // 1: H?:mm
  [ 5],     // 2: M?/D? H?:mm:ss
  [ 5, -3], // 3: M?/D? H?:mm
  [ 5, -8]  // 4: M?/D?
];
const DateFromUT = (ut: number, fmt: number = 0): string => {
  return new Date(ut * 1000).toLocaleString().slice(...DATE_FMT[fmt]);
};
// MM/DD hh:mmレンジ文字列。MM/DDが同じ場合は2番手はhh:mmのみ表示
const DateRageFromUT = (ut1: number, ut2:number): string => {
  const d1 = DateFromUT(ut1, 3);
  const d2 = DateFromUT(ut2, 3);
  const s1 = d1.split(' ');
  const s2 = d2.split(' ');
  return d1 + '～' + (s1[0] === s2[0]? s2[1] : d2);
};

// 0:00なら日付を、それ以外は時刻を返す(X軸の日付代わりを分かりやすくする)
const DateFromUTX = (ut: number): string => {
  const ret = DateFromUT(ut, 1);
  return (ret === ' 0:00')? DateFromUT(ut, 4) : ret;
};

// ドメイン(軸範囲)指定用。データMin/Maxおよび要求Upper/Lowerに適度なアライメントを付けて算出
const MyDomain = (min: number, max: number, scale: number, lower: number, upper: number): [number, number] => {
  return [Math.min(Math.floor(min / scale) * scale, lower), Math.max(Math.ceil(max / scale) * scale, upper)];
};

// ドメインに応じたtickを算出。(最上位桁を1 or 2 or 5ステップにする)
const MyTicks = (min: number, max: number, scale: number, lower: number, upper: number, n: number = 4): number[] => {
  const [lo, hi] = MyDomain(min, max, scale, lower, upper);
  const p = ((hi - lo) / n).toPrecision(1); // 1以下にならないmin/max, nを選択すること！
  let step = parseInt(p[0]);
  let keta = (p.length > 3)? parseInt(p.slice(3)) : 0;
  if (step > 5) {
    step = 1;
    keta += 1;
  } else if (step > 2) {
    step = 5;
  }
  step *= 10 ** keta;
  const ret = [];
  for (let i = Math.ceil(lo / step) * step; i <= hi; i += step) ret.push(i);
  return ret;
};

// レコードの前後をカット(startは含む、endMは含まない)
const CutRecord = (dat: EnvRecord[], startM: number, endM: number) :EnvRecord[] => {
  //　最初にカット不要かチェック
  if (dat.length && startM <= (dat[0][0] / 60 | 0) && (dat[dat.length - 1][0] / 60 | 0) < endM) return dat;

  const s = dat.findIndex(v => (v[0] / 60 | 0) >= startM);
  if (s < 0) return []; // スタート以降のデータが無い

  const e = dat.findLastIndex(v => (v[0] / 60 | 0) <  endM);
  if (e < 0) return []; // end以前のデータが無い

  return dat.slice(s, e + 1); // 範囲外をカットして返す
};

// 表示する範囲のデータを切り出し
const SliceViewData = (active: EnvRecord[], cache:ArcCache, rangeM:number, startM:number):  EnvRecord[] => {
  let endM = 0;
  if (startM) {
    // 日付選択モード
    endM = startM + rangeM;
  } else {
    // 最新モード
    if (active.length < 1) return []; // 空データは最初に弾く
    endM   = (active[active.length - 1][0] / 60 + 1) | 0; // 最終データ時刻の分単位
    startM = endM - rangeM;
  }
  // アクティブデータの先頭(無ければ∞)
  const activeM = active.length? active[0][0] / 60 | 0: Infinity;

  let merge:EnvRecord[] = [];
  // 最初にキャッシュを結合
  let cache_startM = GetArcUTMfromUTM(startM);
  let cache_endM   = GetArcUTMfromUTM(Math.min(endM, activeM) - 1);
  for (; cache_startM <= cache_endM; cache_startM += ONEDAY_M) {
    // キャッシュがあればマージに追加
    const arcdata = cache[GetArcNamefromUTM(cache_startM)];
    if (arcdata) merge = merge.concat(arcdata.dat);
  }
  merge = CutRecord(merge, startM, endM); // 不要部分をカットしておく
  
  // アーカイブデータを結合して返す
  if (merge.length) startM = merge[merge.length - 1][0] / 60 + 1 | 0;
//  return merge.concat(CutRecord(active, startM, endM));
  merge = merge.concat(CutRecord(active, startM, endM));

  // 万が一データが空(範囲外で)なら、最後のアクティブデータを入れておく。
  if (merge.length < 1) merge = active.slice(-1);
  return merge;
};

// gzip展開
const TEXT_DECODER = new TextDecoder();
export async function decompress(buffer: ArrayBuffer): Promise<string> {
  const dec = new DecompressionStream('gzip');
  const blb = new Blob([buffer]).stream().pipeThrough(dec);
  const res = await new Response(blb).arrayBuffer();
  return TEXT_DECODER.decode(res);
};

///////////////////////////////////////////////////////////////////////////////
// Stryle関連定義
///////////////////////////////////////////////////////////////////////////////
// 色はHSV色空間の離れた色味を算出。プリセットテーブルもよいが最大回路数等が読めないので計算で算出することにした。
const HSV_TABLE = [[0, 3, 1], [2, 0, 1], [1, 0, 3], [1, 2, 0], [3, 1, 0], [0, 1, 2]];
function HsvToRgb(h: number, s: number, v: number): string {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const a = [v, v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)];
  return '#' + HSV_TABLE[i % 6].map((n) => Math.round(a[n] * 255).toString(16).padStart(2, '0')).join('');
};
// ライン用パレット。白地で読み取れるよう少し暗めの色味にする。
const LineColor = (n: number): string => {
  return n-- ? HsvToRgb(n * 0.18 % 1, 1, 0.8 * 0.97 ** n) : '#000';
};
// 塗りつぶし用パレット。FillはLineより識別しやすいので、色は明るめ。
const FillColor = (n: number): string => {
  return n-- ? HsvToRgb(n * 0.27 % 1, 1, 0.95 * 0.94 ** n) : '#bbb';
};

// ツールチップ用フォーマット
const ToolFormat = (name:string, dat:string, color:string = '#444'): string => {
  return '<font color="' + color +'">' + name + '<span style="float: right">' + dat + '</span></font><br/>' 
};

///////////////////////////////////////////////////////////////////////////////
// React.memo グラフ描画は重いのでメモ化する
///////////////////////////////////////////////////////////////////////////////
// メモ化に必要な型定義
type GraphProp = {
  // 表示レンジの項目名(総消費電力和やキー名でソート済み)
  pwrlist:        string[];   // AiSEG2回路
  plglist:        string[];   // SBプラグ名
  trvlist:        string[];   // 温湿度計名
  co2list:        string[];   // CO2 濃度計

  // 最も新しい有効な消費電力データ
  latest_pwr_ary: [number, [string, number], number][]; // 外周: 消費割合
  latest_pwr_dir: [number, [string, number], string][]; // 内周: 買電or売電比率
  gensum:         number;     // 発電合計
  usesum:         number;     // 消費合計
  dirsum:         string;     // 買電or売電 差分W
  dirmsg:         string;     // 買電or売電 文言
  dircol:         string;     // 買電or売電 色味 (売電なら黒字、買電は赤字っぽくする。消費/発電とも0Wのときはグレー)

  // チャート用のデータ
  psychart:       PsyChart[]; // 空気線図
  pwrchart:       PwrChart[]; // 消費電力 線グラフ
  trvchart:       TRVChart[]; // 温湿度計 線グラフ
  co2chart:       CO2Chart[]; // CO２濃度 線グラフ

  // 統計データ用
  selfC:          number,     // 自家消費W
  divuse:         number[],   // 回路ごとの消費量
  divbuy:         number[],   // 回路ごとの買電の按分
  plguse:         number[],   // Botごとの消費量
  dcmin :         number[],   // Botごとの温度のMin
  dcmax :         number[],   // Botごとの温度のMax
  rhmin :         number[],   // Botごとの相対湿度のMin
  rhmax :         number[],   // Botごとの相対湿度のMax
  vhmin :         number[],   // Botごとの絶対湿度のMin
  vhmax :         number[],   // Botごとの絶対湿度のMax
  co2min:         number[],   // BotごとのCO2のMin
  co2max:         number[],   // BotごとのCO2のMax
  dcminA:         number,     // 全体の温度Min
  dcmaxA:         number,     // 全体の温度Max
  rhminA:         number,     // 全体の相対湿度Min
  rhmaxA:         number,     // 全体の相対湿度Max
  vhminA:         number,     // 全体の絶対湿度Min
  vhmaxA:         number,     // 全体の絶対湿度Max
  co2minA:        number,     // 全体のCO2のMin
  co2maxA:        number,     // 全体のCO2のMax
  pwrminA:        number,     // 全体のPwrのMin
  pwrmaxA:        number,     // 全体のPwrのMax
  vecstart:       number,     // 線グラフの開始インデックス(上記min/maxのレンジ)

  // 付加情報
  psylegend:      [number, number, number, number, string][]; //空気線図の独自Legend用
  lastCO2:        number;     // 最も新しい有効なCO2力データ
  lastCO2col:     string;     // 最も新しい有効な警告色
  firstaiseg_ut:  number;     // 最初ににAiSEGから情報取得した時刻(UnixTime)
  lastaiseg_ut:   number;     // 最後にAiSEGから情報取得した時刻(UnixTime)
  lastswitchbot_ut:number;    // 最後にSwitchBotから情報取得した時刻(UnixTime)
  sigmahour:      string;     // 集計した積算時間(四捨五入後の文字列)
};

type ScaleProp = {
    // 表示サイズ（90° or 270°回転時はinW/inHがswapされる）
    inW: number,
    inH: number,

    // 各Div/フォントサイズ比率を算出
    topdivH        : number,
    leftdivH       : number,
    totalH         : number,
    pwrdivH        : number,
    tvrdivH        : number,
    co2divH        : number,
    rh_div_y       : number,
    dc_div_y       : number,
    vh_div_y       : number,
    co2_div_y      : number,
    title_font     : number,
  
    pcircle_in1R   : number,
    pcircle_out1R  : number,
    pcircle_in2R   : number,
    pcircle_out2R  : number,
  
    pcircle_cfont1 : number,
    pcircle_cfont2 : number,
    pcircle_cfont3 : number,
    pcircle_cfont4 : number,
    pcircle_cfont5 : number,
  
    psy_top        : number,
    psy_left       : number,
    psy_bottom     : number,
    psy_right      : number,
  
    psy_tickfont   : number,
    psy_yaxsis     : number,
    psy_ticksize   : number,
    psy_unit_x     : number,
    psy_unit_y     : number,
    psy_font       : number,
    psy_plot       : number,
  
    psy_rh_x       : number,
    psy_rh_vx      : number,
    psy_rh_y       : number,
    psy_rh_vy      : number,
  
    psy_legend_x   : number,
    psy_legend_font: number,
  
    psy_out_font   : number,
    psy_out_x1     : number,
    psy_out_y1     : number,
    psy_out_x2     : number,
    psy_out_y2     : number,
  
    x_axsis_font   : number,
    y_axsis_font   : number,
    y_axsisW       : number,
  
    legendW        : number,
    legend_font    : number,
    minmax_font    : number,
    tooltip_font   : number,
    tooltipW       : number,
  
    pwr_bottom     : number,
    pwr_right      : number,
  
    limit_font     : number,
    dat_font       : number,
  
    tvrlegend_y    : number,
    tvrminmax_y    : number,
    co2legend_y    : number,

    linegraphW     : number,
    daytick        : number[],

    // Div回転・位置設定
    divrot:	        string,
    divorg:         string,
    divtop:         number,
};

// 円グラフのラベル用
type LabelProps = {
  cx:           number;
  cy:           number;
  midAngle:     number;
  innerRadius:  number;
  outerRadius:  number;
  percent:      number;
  index:        number;
  name:         [string, number];
};

// 重いグラフオブジェクトをメモ化。グラフデータとスケーリングに依存
const GraphMemo = React.memo((props: {graph:GraphProp, scale:ScaleProp}) => {
  console.log('Render GraphMemo'); // この再描画を最小限にしたい
  const graph = props.graph;
  const scale = props.scale;

  // 円グラフのカスタムインナーレベル (文字が被らないように、必要に応じてY座標をシフトする小細工)
  const circleinfoRef = useRef({
    prev_x:   0, // 1つ前のラベルのX座標
    prev_y:   0, // 1つ前のラベルのy座標
    prev_s:   0, // 1つ前のラベルのシフト

    // ラベルが多すぎて文字が入りきらない場合はotherにまとめる
    other_w:  0, // その他合計用[W] 
    other_p:  0, // その他合計用[%]
    other_n:  0, // その他件数
  });
  
  const renderCustomizedInnerLabel = (props: any) => {
    const p: LabelProps = props;
    const circleinfo = circleinfoRef.current
    if (!p.index) { // 0番目が呼ばれたときに初期化
      circleinfo.prev_x = 0;
      circleinfo.prev_y = 0;
      circleinfo.prev_s = 0;
      circleinfo.other_w  = 0;
      circleinfo.other_p  = 0;
      circleinfo.other_n　= 0;
    }

    // テキストのカラーエフェクトは共通なのでここで設定しておく
    const clabel_style = {fontSize: scale.pcircle_cfont2, fill: '#fff', textShadow: '1px 1px 3px #000, 0 0 0.3em #000,0 0 3px #000'};
    // 'その他'が1以上ならなら、もはや座標計算は不要なので加算のみ
    if (circleinfo.other_w) {
      circleinfo.other_w += p.name[1];
      circleinfo.other_p += p.percent;
      circleinfo.other_n++;
      if (p.index < graph.latest_pwr_ary.length - 1) return; // 最後じゃなければ加算継続
      // 最後ならその他として合計値を表示
      return (
        <text x={p.cx - scale.pcircle_cfont2 / 2} y={circleinfo.prev_y / 2} textAnchor='middle' style={clabel_style}>{'他x' + circleinfo.other_n + ': ' + circleinfo.other_w + 'W-' + MyRoundP(circleinfo.other_p)}</text>
      );
    } else {
      // ラベルは原則はpieの中心に表示する。ただし、直前のラベルに被る場合は上下にずらす
      const near_x = scale.pcircle_cfont2 * 8;   // 8文字程度で被る?
      const near_y = scale.pcircle_cfont2 * 1.9; // 行間兼用
      const radius = p.innerRadius + (p.outerRadius - p.innerRadius) / 2;
      let x = p.cx + radius * Math.cos(-p.midAngle * Math.PI / 180);
      let y = p.cy + radius * Math.sin(-p.midAngle * Math.PI / 180) + circleinfo.prev_s;

      //前のラベルと被る場合は、表示位置をずらす
      if (p.index && Math.abs(circleinfo.prev_x - x) < near_x && Math.abs(circleinfo.prev_y - y) < near_y) {
        circleinfo.prev_s = circleinfo.prev_y + near_y * Math.sign(x - p.cx) - y;// 円グラフの右側なら下方向にシフト、左側なら上方向にシフト
        y += circleinfo.prev_s;
      }

      // ずらし量が多くて2行表示しきれなくなった？
      if (y < near_y) {
        if (p.index === graph.latest_pwr_ary.length - 1) {
          // 最後の１つなら”その他”っではなく回路名で1行表示
          return (
            <text x={p.cx - scale.pcircle_cfont2 / 2} y={circleinfo.prev_y / 2} textAnchor='middle' style={clabel_style}>{p.name[0] + ' ' + p.name[1] + 'W-' + MyRoundP(p.percent)}</text>
          );
        }
        // 後続がいるなら'その他 x個'でまとめて表示
        circleinfo.other_w = p.name[1];
        circleinfo.other_p = p.percent;
        circleinfo.other_n = 1;
        return;
      }

      // 通常ラベルで表示できる場合は2段表示
      circleinfo.prev_x = x;
      circleinfo.prev_y = y;

      return (
        <>
          <text x={x} y={y             } textAnchor='middle' style={{...clabel_style, fontSize: scale.pcircle_cfont1}}>{p.name[0]}</text>
          <text x={x} y={y + near_y / 2} textAnchor='middle' style={clabel_style}>{p.name[1] + 'W-' + MyRoundP(p.percent)}</text>
        </>
      );
    }
  };

  // 共通のスタイルを事前定義
  const pie_style    : React.CSSProperties = {fontSize: scale.pcircle_cfont3, fill: graph.dircol, textShadow: '1px 1px 3px #fff, 0 0 1em #fff, 0 0 0.2em ' + graph.dircol};
  const solar_style  : React.CSSProperties = {position: 'absolute', textAlign: 'center', fontSize: scale.pcircle_cfont5 * 1.7, left: 0, top: 0, width: scale.pcircle_cfont5 * 3};
  const leghead_style: React.CSSProperties = {position: 'absolute', fontSize: scale.x_axsis_font, color: '#666', right: 1 };
  const version_style: React.CSSProperties = {position: 'absolute', fontSize: scale.dat_font,   top: scale.totalH - scale.dat_font * 3.3, right:0, color: '#bbb'};
  const title_style = (c: string):React.CSSProperties => {return {position: 'absolute', fontSize: scale.title_font, top: scale.topdivH,   margin: '2px', color: '#fff',  textShadow: '1px 1px 3px black, 0 0 1em grey, 0 0 0.3em #' + c }};

  // グラフ本体
  return (
    <>
      {/******************************* トップグラフ *******************************/}
      <div style={{ width: scale.inW, height: scale.topdivH, background: 'linear-gradient(to bottom right, #eee 0%, #fff 50%, #eee 100%)' }}>
        {/******************************* 電力サークル *******************************/}
        <div style={{ width: scale.topdivH, height: scale.topdivH, position: 'absolute', top: '0', left: '0' }}>
          <ResponsiveContainer>
            <PieChart>
              <Pie data={graph.latest_pwr_ary} innerRadius={scale.pcircle_in1R} outerRadius={scale.pcircle_out1R} startAngle={90} endAngle={-270} dataKey='0' nameKey='1' labelLine={false} isAnimationActive={false} label={renderCustomizedInnerLabel}>
                {
                  graph.latest_pwr_ary.map((v, i) => (
                    <Cell key={'LP' + i} fill={FillColor(v[2])} />
                  ))
                }
              </Pie>
              <Pie data={graph.latest_pwr_dir} innerRadius={scale.pcircle_in2R} outerRadius={scale.pcircle_out2R} startAngle={90} endAngle={-270} dataKey='0' nameKey='1' labelLine={false} animationDuration={ANIMATION_DURATION} label={false}>
                {
                  graph.latest_pwr_dir.map((v, i) => (
                    <Cell key={'LD' + i} fill={v[2]} />
                  ))
                }
              </Pie>
              <text style={pie_style                                     } textAnchor='middle' x='50%' y='46%'>{graph.dirmsg}</text>
              <text style={{...pie_style, fontSize: scale.pcircle_cfont4}} textAnchor='middle' x='50%' y='57%'>{graph.dirsum + 'W'}</text>
            </PieChart>
          </ResponsiveContainer>
        </div>
        {graph.gensum ? <div style={{...solar_style, color: '#fb9' }}>☀</div> : ''}
        {graph.gensum ? <div style={{...solar_style, color: '#fee', fontSize: scale.pcircle_cfont5, textShadow: '1px 1px 3px black,0 0 1em red,0 0 0.3em red' }}>{graph.gensum + 'W'}</div> : ''}

        {graph.gensum ? <div style={{...solar_style, color: '#cc2', top: scale.topdivH - scale.pcircle_cfont5 * 2.8}}>⏚</div> : ''}
        {graph.gensum ? <div style={{...solar_style, color: '#ffe', top: scale.topdivH - scale.pcircle_cfont5 * 1.2, fontSize: scale.pcircle_cfont5, textShadow: '1px 1px 3px black,0 0 1em #aa0,0 0 0.3em yellow'}}>{graph.usesum + 'W'}</div> : ''}

        <div style={{ position: 'absolute', fontSize: scale.psy_out_font, color: '#000', left:  0, top: scale.topdivH - scale.pcircle_cfont5 * 1.1, width: scale.topdivH, textAlign: 'center', textShadow: '0 0 5px #fff,0 0 5px #fff,0 0 5px #fff,0 0 5px #fff,0 0 5px #fff,0 0 5px #fff,0 0 5px #fff,0 0 5px #fff'}}>{DateFromUT(graph.lastaiseg_ut)}</div>

        {/******************************* 空気線図もどき *******************************/}
        <div style={{ width: scale.topdivH * 1.2, height: scale.topdivH, position: 'absolute', top: '0', right: '0' }}>
          <ResponsiveContainer>
            <ComposedChart data={graph.psychart} margin={{ top: scale.psy_top, right: scale.psy_right, left: scale.psy_left, bottom: scale.psy_bottom }}>
              <XAxis dataKey='dc' domain={() => { return [PC_X_BEGIN, PC_X_END] }} type='number' tickCount={6} interval='preserveStartEnd' tick={{ fontSize: scale.psy_tickfont }} tickSize={scale.psy_ticksize} allowDataOverflow={true} dy={-1} tickFormatter={(t) => (Math.round(t) + '℃')} minTickGap={-30}/>
              <YAxis dataKey='vh' domain={() => { return [PC_Y_BEGIN, PC_Y_END] }} type='number' tickCount={9} interval='preserveStart'    tick={{ fontSize: scale.psy_tickfont }} tickSize={scale.psy_ticksize} allowDataOverflow={true} orientation='right' width={scale.psy_yaxsis} minTickGap={0}/>

              {/* 快適ゾーン */}
              <Area type='monotone' dataKey='zone' stroke='none' fill='#fca' dot={false} activeDot={false} isAnimationActive={false} />
              {/* 絶対湿度補助線 */
                new Array(((PC_Y_END - PC_Y_BEGIN) / 2 | 0) + 1).fill(0).map((_zero, i) => (
                  <ReferenceLine key={'PCVH' + i} stroke={(i % 2) ? '#bbb' : '#888'} strokeDasharray={(i % 2) ?'2 2' : '1 1'} segment={[{ x: CalcTFromVH(i * 2), y: i * 2}, { x: PC_X_END, y: i * 2}]} />
                ))
              }
              {/* 温度補助線 */
                new Array((PC_X_END - PC_X_BEGIN) / 5 | 0).fill(0).map((_zero, i) => (
                  <ReferenceLine key={'PCDC' + i} stroke={(i % 2) ? '#bbb' : '#888'} strokeDasharray={(i % 2) ?'2 2': '1 1'} segment={[{ x: PC_X_BEGIN + i * 5, y: 0 }, { x: PC_X_BEGIN + i * 5, y: Math.min(CalcVH(PC_X_BEGIN + i * 5, 100), PC_Y_END) }]} />                ))
              }
              {/* 相対湿度補助線 */
                new Array(10).fill(0).map((_zero, i) => (
                  <Line key={'RHAL' + i} dataKey={'rhAL[' + i + ']'} type='monotone' strokeWidth={1} dot={false} isAnimationActive={false} stroke={((i + 1) % 5) ? '#ccc' : '#999'} />
                ))
              }
              {/* 相対湿度数値 0%と100%は明瞭なので含めない */
                new Array(9).fill(0).map((_zero, i) => {
                  const rh = (i + 1) * 10;
                  const vh = CalcVH(39   - i * 0.8, rh); // 38℃から28℃辺りへドリフトさせながら表示
                  const dv = CalcVH(39.7 - i * 0.8, rh); // 文字の角度計算用Δv
                  const x = scale.psy_rh_x - scale.psy_rh_vx * i;
                  const y = scale.psy_rh_y - scale.psy_rh_vy * vh;
                  return <text key={'RH' + i} style={{ fontSize: scale.psy_font, fill: '#444' }} x={x} y={y} textAnchor='left' transform={'rotate(' + Math.atan2(vh - dv, 0.5) * 180 / Math.PI + ', ' + (x) + ', ' + (y - scale.psy_font * 1) + ')'}>{(i + 1) * 10 + '%'}</text>
                })
              }
              {/* Y軸単位 */}
              <text style={{ fontSize: scale.psy_font, fill: '#111' }} x={scale.psy_unit_x} y={scale.psy_unit_y} textAnchor='middle' transform={'rotate(-90,' + scale.psy_unit_x + ',' + scale.psy_unit_y + ')'}>g/m³</text>

              {/* 温湿度をプロット  */
                <Scatter name='scat' shape='cross' animationDuration={ANIMATION_DURATION}>
                  {
                    graph.psychart.map((v, i) => (
                      /* @ts-ignore ※隠しパラメータのsizeを強制的に使うためWarning抑止。（ComposedChartはShapeサイズ変更にZAxisが使えない） */
                      <Cell key={'PSC' + i} fill={LineColor(v.idx[1])} size={scale.psy_plot} />
                    ))
                  }
                </Scatter>
              }
              {/* 代表絶対湿度とPPMも付帯情報として表示しておく */}
              <text x={scale.psy_out_x2} y={scale.psy_out_y2                     } style={{ fontSize: scale.psy_out_font, fill: '#000',           textShadow: '1px 1px 3px white, 0 0 1em grey, 0 0 0.2em white' }} textAnchor='end' >{graph.psychart.length? graph.psylegend[0][4]+ ': ' + MyRound(graph.psylegend[0][3]) + 'g/㎥' : ''}</text>
              <text x={scale.psy_out_x2} y={scale.psy_out_y2 + scale.psy_out_font} style={{ fontSize: scale.psy_out_font, fill: graph.lastCO2col, textShadow: '1px 1px 3px white, 0 0 1em grey, 0 0 0.2em white' }} textAnchor='end' >CO2{graph.lastCO2? ': ' + graph.lastCO2 + 'ppm' : ''}</text>
            </ComposedChart>
          </ResponsiveContainer>

          {/* 独自Legend書式 */
            graph.psylegend.map((v, i) => {
              const style: React.CSSProperties = {position: 'absolute', fontSize: scale.psy_legend_font, color: LineColor(i), top: i * scale.psy_legend_font};
              return (
                <React.Fragment key={'Leg1' + i}>
                  <div style={{...style, left:scale.psy_legend_x}}>{'✚' + v[4]}</div>
                  <div style={{...style, left:scale.psy_legend_x + scale.psy_legend_font * 6.3}}>{MyFixStr(MyRound(v[1]), 4) + '℃' + MyFixStr(v[2] + '', 3) + '%'}</div>
                </React.Fragment>
              )
            })
          }
        </div>
      </div>

      {/******************************* 電力消費グラフ *******************************/}
      <div style={{ width: '100%', height: scale.pwrdivH}}>
        <ResponsiveContainer>
          <ComposedChart data={graph.pwrchart} margin={{top:scale.y_axsis_font * 0.7, left: 0, right: scale.pwr_right + scale.legendW, bottom: scale.pwr_bottom}}>
            <CartesianGrid strokeDasharray='3 3' />
            <XAxis tick={{ fontSize: scale.x_axsis_font, textAnchor: 'end'}} dataKey='ut' domain={['dataMin', 'dataMax']} type='number' ticks={scale.daytick} minTickGap={-50} interval='equidistantPreserveStart' angle={-60} dy={-2} tickSize={scale.psy_ticksize} tickFormatter={(ut) => DateFromUTX(ut)} />
            <YAxis tick={{ fontSize: scale.y_axsis_font }} orientation='right' unit='W' width={scale.y_axsisW} domain={([min, max]) => { return MyDomain(min, max, 100, 0, 100) }} ticks={MyTicks(graph.pwrminA, graph.pwrmaxA, 500, 0, 500, 6)}　interval='preserveStartEnd' minTickGap={-50} />

            {/* AiSEG情報はAreaチャートで表示 */
              graph.pwrlist.map((v, i) => (
                <Area key={'AS' + i} dataKey={'pwr[' + i + ']'} unit='W' isAnimationActive={false} type='step' stroke={FillColor(i)} strokeWidth={0.2} fill={FillColor(i)} fillOpacity={0.9} name={v} stackId='1' />
              ))
            }
            {/* SwitchBot Plug情報は破線Lineチャートで表示 */
              graph.plglist.map((v, i) => (
                <Line key={'SB' + i} dataKey={'plg[' + i + ']'}  unit='W' isAnimationActive={false} type='basis' stroke={LineColor(i + 1)} strokeWidth={1} strokeDasharray='2 2' dot={false} name={v + '-Plug'} />
              ))
            }
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Legendもどき (消費電力と買電按分も表示しておく) */}
      <div style={{...leghead_style, top: scale.topdivH}} >
        {graph.sigmahour} 自給率, 自家消費率, 発電[kWh]
      </div>
      <div style={{...leghead_style, top: scale.topdivH + scale.legend_font * 2}}>
        {graph.sigmahour} 買電按分/消費[kWh] (計:{MyRound((graph.divbuy[0] - graph.selfC) / 60000) + '/' + MyRound(graph.divbuy[0] / 60000)})
      </div>
      { /* HEMSデータは塗りつぶし */
        graph.pwrlist.map((v, i) => {
          const style: React.CSSProperties = {position: 'absolute', fontSize: scale.legend_font, color: i? FillColor(i) : '#666', top: scale.topdivH + (i + (i && 1)) * scale.legend_font + scale.x_axsis_font};
          let txt = i? MyFixStr(MyRound(graph.divbuy[i] / 60000), 4) + '/' : '';
          if (!i && graph.divuse[0] && graph.divbuy[0]) txt = '⊼' + MyRoundP(graph.divuse[0] / graph.divbuy[0]) + ' ↺' + MyRoundP(graph.selfC / graph.divuse[0]);
          return (
            <React.Fragment key={'Leg3' + i}>
              <div style={{...style, left: scale.inW - scale.legendW}} >{'■' + (i? v : '太陽光')}</div>
              <div style={{...style, right: 2}} >{txt + MyFixStr(MyRound(Math.abs(graph.divuse[i]) / 60000))}</div>
            </React.Fragment>
          )
        })
      }
      { /* SwitchBotプラグは点線 */
        graph.plglist.map((v, i) => {
          const style: React.CSSProperties = {position: 'absolute', fontSize: scale.legend_font, color: LineColor(i + 1), top: scale.topdivH + (i + graph.pwrlist.length + 1) * scale.legend_font + scale.x_axsis_font};
          return (
            <React.Fragment key={'Leg4' + i}>
              <div style={{...style, left: scale.inW - scale.legendW }} >{'┉' + v}</div>
              <div style={{...style, right: 2 }} >{MyRound(Math.abs(graph.plguse[i]) / 60000)}</div>
            </React.Fragment>
          )
        })
      }

      {/******************************* 相対湿度グラフ *******************************/}
      <div style={{ width: '100%', height: scale.tvrdivH * 0.95, fontSize: scale.limit_font + 'px' }}>
        <ResponsiveContainer>
          <ComposedChart data={graph.trvchart} margin={{ top: scale.y_axsis_font * 0.7, left: 0, right: scale.pwr_right, bottom: scale.y_axsis_font / 2 }} >
            <defs>
              <linearGradient id='colorRH' x1='0' y1='0' x2='0' y2='1'>
                <stop offset='0' stopColor='#66a' stopOpacity={0.3} />
                <stop offset='1' stopColor='#abf' stopOpacity={0.1} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray='3 3' />
            <XAxis height={1} tickSize={scale.psy_ticksize} dataKey='ut' domain={['dataMin', 'dataMax']} type='number' ticks={scale.daytick} interval='equidistantPreserveStart' tickFormatter={() => ''}/>
            <YAxis tick={{ fontSize: scale.y_axsis_font }} domain={() => { return MyDomain(graph.rhminA, graph.rhmaxA, 5, PC_ZONE_RMIN, PC_ZONE_RMAX) }} ticks={MyTicks(graph.rhminA, graph.rhmaxA, 5, PC_ZONE_RMIN, PC_ZONE_RMAX)} minTickGap={-50} orientation='right' interval='preserveStartEnd' unit='%' width={scale.y_axsisW} />
            {
              graph.trvlist.map((v, i) => (
                i < graph.vecstart? '' : 
                i?  <Line key={'rh' + i} dataKey={'rh[' + i + ']'} name={v + '相対湿度'} unit='%' isAnimationActive={false} type='basis'    stroke={LineColor(i)} strokeWidth={1.5} dot={false} /> :
                    <Area key={'rh' + i} dataKey={'rh[' + i + ']'} name={v + '相対湿度'} unit='%' isAnimationActive={false} type='monotone' stroke='#000' fillOpacity={1} fill='url(#colorRH)' /> /*トップだけ塗りつぶし */
              ))
            }

            <ReferenceLine y={PC_ZONE_RMAX} label={'↓ 湿度上限' + PC_ZONE_RMAX + '%'} stroke='#f00' strokeDasharray='5 5' />
            <ReferenceLine y={PC_ZONE_RMIN} label={'↑ 湿度下限' + PC_ZONE_RMIN + '%'} stroke='#f00' strokeDasharray='5 5' />

            <Legend layout='vertical' width={scale.legendW} align='right' iconSize={0} formatter={() => ''} />

          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Legendもどき (温湿度の範囲も表示しておく) */}
      <div style={{...leghead_style, top: scale.tvrlegend_y + scale.x_axsis_font / 2}} >{graph.sigmahour}気温 最小～最大[℃]</div>
      <div style={{...leghead_style, top: scale.tvrminmax_y                         }} >{graph.sigmahour}湿度 最小～最大[g/m³], [%]</div>
      {
        graph.trvlist.map((v, i) => {
          const style1: React.CSSProperties = {position: 'absolute', fontSize: scale.legend_font, color: LineColor(i), top: scale.tvrlegend_y + (i + 1) * scale.legend_font};
          const style2: React.CSSProperties = {position: 'absolute', fontSize: scale.minmax_font, color: LineColor(i), top: scale.tvrminmax_y + (i + 1) * scale.minmax_font};
          return (
            <React.Fragment key={'Leg5' + i}>
              <div style={{...style1, left: scale.inW - scale.legendW}} >{(i?'━' : '■') + v}</div>
              <div style={{...style1, right: 2                       }} >{MyRound(graph.dcmin[i]) + '～' + MyFixStr(MyRound(graph.dcmax[i]))}</div>
              <div style={{...style2, left: scale.inW - scale.legendW}} >{v}</div>
              <div style={{...style2, right: 2                       }} >{MyRound(graph.vhmin[i]) + '～' + MyFixStr(MyRound(graph.vhmax[i])) + ',' + MyFixStr(graph.rhmin[i].toString(), 3) + '～' + MyFixStr(graph.rhmax[i].toString(), 3)}</div>
            </React.Fragment>
          )
        })
      }

      {/******************************* 温度グラフ *******************************/}
      <div style={{ width: '100%', height: scale.tvrdivH * 0.95, fontSize: scale.limit_font + 'px' }}>
        <ResponsiveContainer>
          <ComposedChart data={graph.trvchart} margin={{ top: scale.y_axsis_font * 0.7, left: 0, right: scale.pwr_right, bottom: scale.y_axsis_font / 2 }}>
            <defs>
              <linearGradient id='colorTH' x1='0' y1='0' x2='0' y2='1'>
                <stop offset='0' stopColor='#440' stopOpacity={0.3} />
                <stop offset='1' stopColor='#aa8' stopOpacity={0.1} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray='3 3' />
            <XAxis height={1} tickSize={scale.psy_ticksize} dataKey='ut' domain={['dataMin', 'dataMax']} type='number' ticks={scale.daytick} interval='equidistantPreserveStart' tickFormatter={() => ''}/>
            <YAxis tick={{ fontSize: scale.y_axsis_font }} domain={() => { return MyDomain(graph.dcminA, graph.dcmaxA, 5, PC_ZONE_TMIN, PC_ZONE_TMAX) }} ticks={MyTicks(graph.dcminA, graph.dcmaxA, 5, PC_ZONE_TMIN, PC_ZONE_TMAX)} minTickGap={-50} orientation='right' interval='preserveStartEnd' unit='℃' width={scale.y_axsisW} />
            {
              graph.trvlist.map((v, i) => (
                i < graph.vecstart? '' : 
                i?  <Line key={'dc' + i} dataKey={'dc[' + i + ']'} name={v + '温度'} unit='℃' isAnimationActive={false} type='basis'    stroke={LineColor(i)} strokeWidth={1.5} dot={false}/> :
                    <Area key={'dc' + i} dataKey={'dc[' + i + ']'} name={v + '温度'} unit='℃' isAnimationActive={false} type='monotone' stroke='#000' fillOpacity={1} fill='url(#colorTH)' /> /*トップだけ塗りつぶし */
              ))
            }

            <ReferenceLine y={PC_ZONE_TMAX} label={'↓ 温度上限' + PC_ZONE_TMAX + '℃'} stroke='#f44' strokeDasharray='5 5' />
            <ReferenceLine y={PC_ZONE_TMIN} label={'↑ 温度下限' + PC_ZONE_TMIN + '℃'} stroke='#f44' strokeDasharray='5 5' />

            <Legend layout='vertical' width={scale.legendW} align='right' iconSize={0} formatter={() => ''} />

          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/******************************* 絶対湿度グラフ *******************************/}
      <div style={{ width: '100%', height: scale.tvrdivH * 1.1, fontSize: scale.limit_font + 'px' }}>
        <ResponsiveContainer>
          <ComposedChart data={graph.trvchart} margin={{ top: scale.y_axsis_font * 0.7, left: 0, right: scale.pwr_right, bottom: scale.pwr_bottom}}>
            <defs>
              <linearGradient id='colorVH' x1='0' y1='0' x2='0' y2='1'>
                <stop offset='0' stopColor='#66a' stopOpacity={0.3} />
                <stop offset='1' stopColor='#abf' stopOpacity={0.1} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray='3 3' />
            <XAxis tick={{fontSize: scale.x_axsis_font, textAnchor: 'end'}} dataKey='ut' domain={['dataMin', 'dataMax']} type='number' ticks={scale.daytick} minTickGap={-50} interval='equidistantPreserveStart' angle={-60} tickSize={scale.psy_ticksize} tickFormatter={(ut) => DateFromUTX(ut)} />
            <YAxis tick={{fontSize: scale.y_axsis_font}} domain={() => { return MyDomain(graph.vhminA, graph.vhmaxA, 2, PC_ZONE_VMIN, PC_ZONE_VMAX) }} ticks={MyTicks(graph.vhminA, graph.vhmaxA, 2, PC_ZONE_VMIN, PC_ZONE_VMAX)} minTickGap={-50} orientation='right' interval='preserveStartEnd' unit='g/m³' width={scale.y_axsisW} />
            {
              graph.trvlist.map((v, i) => (
                i < graph.vecstart? '' : 
                i? <Line key={'vh' + i} dataKey={'vh[' + i + ']'} name={v + '絶対湿度'} unit='g/m³' isAnimationActive={false} type='basis'    stroke={LineColor(i)} strokeWidth={1.5} dot={false} /> :
                   <Area key={'vh' + i} dataKey={'vh[' + i + ']'} name={v + '絶対湿度'} unit='g/m³' isAnimationActive={false} type='monotone' stroke='#000' fillOpacity={1} fill='url(#colorVH)' /> /*トップだけ塗りつぶし */
                ))
            }
            <ReferenceLine y={PC_ZONE_VMAX} label={'↓ 湿度上限' + PC_ZONE_VMAX + 'g'} stroke='#f44' strokeDasharray='5 5' />
            <ReferenceLine y={PC_ZONE_VMIN} label={'↑ 湿度下限' + PC_ZONE_VMIN + 'g'} stroke='#f44' strokeDasharray='5 5' />

            <Legend layout='vertical' width={scale.legendW} align='right' iconSize={0} formatter={() => ''} />

          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/******************************* CO2グラフ *******************************/}
      <div style={{ width: '100%', height: scale.co2divH, fontSize: scale.limit_font + 'px'}}>
        <ResponsiveContainer>
          <AreaChart data={graph.co2chart} margin={{ top: scale.y_axsis_font * 0.7, left: 0, right: scale.pwr_right, bottom: scale.pwr_bottom }}>
            <defs>
              <linearGradient id='CO2' x1='0' y1='0' x2='0' y2='1'>
                <stop offset='0' stopColor='#6a6' stopOpacity={1.0} />
                <stop offset='1' stopColor='#8f8' stopOpacity={0.2} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray='3 3' />
            <XAxis tick={{ fontSize: scale.x_axsis_font, textAnchor: 'end'}} dataKey='ut' domain={['dataMin', 'dataMax']} type='number' ticks={scale.daytick} minTickGap={-50} interval='equidistantPreserveStart' angle={-60} tickSize={scale.psy_ticksize} tickFormatter={(ut) => DateFromUTX(ut)} />
            <YAxis tick={{ fontSize: scale.y_axsis_font }} domain={([min, max]) => { return MyDomain(min, max, 100, 400, 1000) }} ticks={MyTicks(graph.co2minA, graph.co2maxA, 100, 400, 1000, 4)} minTickGap={-50} orientation='right' interval='preserveStartEnd' unit='ppm' width={scale.y_axsisW} />

            {
              graph.co2list.map((v, i) => (
                i?  <Line key={'co2' + i} dataKey={'co2[' + i + ']'} name={v} unit='ppm' isAnimationActive={false} type='basis'    stroke={LineColor(i)} strokeWidth={1.5} dot={false} /> :
                    <Area key={'co2' + i} dataKey={'CO2[' + i + ']'} name={v} unit='ppm' isAnimationActive={false} type='monotone' stroke='#000' fill='url(#CO2)' /> /*トップだけ塗りつぶし */
              ))
            }

            <ReferenceLine y={CO2_WARNING} label={'↑ CO2警告' + CO2_WARNING + 'ppm'} stroke='#f44' strokeDasharray='5 5' />
            <ReferenceLine y={CO2_CAUTION} label={'↑ CO2注意' + CO2_CAUTION + 'ppm'} stroke='#fa2' strokeDasharray='5 5' />

            <Legend layout='vertical' width={scale.legendW} align='right' iconSize={0} formatter={() => ''} />

          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Legendもどき (CO2濃度の範囲も表示しておく)*/}
      <div style={{...leghead_style, top: scale.co2legend_y}} >{graph.sigmahour} 最小～最大[ppm]</div>
      {
        graph.co2list.map((v, i) => {
          const style: React.CSSProperties = {position: 'absolute', fontSize: scale.legend_font, color: LineColor(i), top: scale.co2legend_y + (i + 1) * scale.legend_font};
          return (
            <React.Fragment key={'Leg6' + i}>
              <div style={{...style, left: scale.inW - scale.legendW}} >{(i?'━' : '■') + v}</div>
              <div style={{...style, right: 2}} >{graph.co2min[i] + '～' + graph.co2max[i]}</div>
            </React.Fragment>
          )
        })
      }

      {/* ライングラフのタイトル*/}
      <div style={{...title_style('fe0'), top: scale.topdivH  }} >電力    </div>
      <div style={{...title_style('22f'), top: scale.rh_div_y }} >相対湿度</div>
      <div style={{...title_style('f00'), top: scale.dc_div_y }} >温度    </div>
      <div style={{...title_style('00d'), top: scale.vh_div_y }} >絶対湿度</div>
      <div style={{...title_style('0f0'), top: scale.co2_div_y}} >CO2濃度 </div>

      {/* ライングラフの表示範囲　*/}
      <div style={{ position: 'absolute', fontSize: scale.legend_font,top: scale.topdivH,   margin: '2px', left:scale.title_font * 3, color: '#fff', textShadow: '1px 1px 3px #222, 0 0 1em #444, 0 0 0.3em #ccc'}}>{DateRageFromUT(graph.firstaiseg_ut, graph.lastaiseg_ut)}</div>

      <div style={{...version_style, top: scale.totalH - scale.dat_font * 3.3}}>EnvLog ver.{ENVLOG_VER}</div>
      <div style={{...version_style, top: scale.totalH - scale.dat_font * 2.2}}>AS:{DateFromUT(graph.lastaiseg_ut,     2)}</div>
      <div style={{...version_style, top: scale.totalH - scale.dat_font * 1.1}}>SB:{DateFromUT(graph.lastswitchbot_ut, 2)}</div>
    </>
  );
}, (pre, cur) => {
  // 簡易的に以下項目のみで等価チェックする
  return  pre.graph.pwrchart.length  === cur.graph.pwrchart.length  &&  // レンジ変更
          pre.graph.lastaiseg_ut     === cur.graph.lastaiseg_ut     &&  // データ内容変更
          pre.graph.lastswitchbot_ut === cur.graph.lastswitchbot_ut &&  // データ内容変更 (SwitchBotのみのケース)
          pre.scale.divrot           === cur.scale.divrot           &&  // 回転設定
          pre.scale.inW              === cur.scale.inW              &&  // リサイズ
          pre.scale.inH              === cur.scale.inH              &&  // リサイズ
          pre.graph.vecstart         === cur.graph.vecstart         ;   // 外気を範囲に含めるか切替
  // 上記はオブジェクト全体の厳密な比較ではないが、現UIの操作上は十分なチェックとなる(はず)
});

///////////////////////////////////////////////////////////////////////////////
// App
///////////////////////////////////////////////////////////////////////////////
const App = () => {
  const viewdatRef = useRef<EnvRecord[]>([]);

  // 描画トリガのコントロール用
  const [_viewCounter, setViewCounter] = useState(0); 

  // 画面回転 or リサイズ時の自動再調整用State (resolutionはオプションの回転設定ではなく、スマホ/タブレットの回転操作で動く)
  const resolutionRef = useRef({
    width:  document.documentElement.clientWidth, // window.innerHeight or window.screen.availWidthは使わない
    height: document.documentElement.clientHeight,
  });
  useEffect(() => {
    const handleResolutionChange = () => {
      resolutionRef.current = {
        width:  document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      };
      CalcScale();
    };

    // リサイズイベント（回転含む）の監視
    window.addEventListener('resize', handleResolutionChange);
    return () => {
      window.removeEventListener('resize', handleResolutionChange);
    };
  }, []);

  // ポップアップメニュー用State
  const [isPopupShown, setIsPopupShown] = useState(false);
  const handlePopupClick = () => {
    setIsPopupShown(true);
    setIsTooltipShown(false); // ツールチップと排他にする
  };
  const handlePopupClose = () => {
    setIsPopupShown(false);
  };

  // オプション設定用。ローカルストレージに保存した設定を優先し、なければデフォルトを使う
  const optionRef = useRef({
    rangeM:   DEF_RANGE, dateSel: DEF_DATESEL,
    datetimeM:DEF_DATETIME,
    angle:    (LS_ANGLE_VAL  != null)? Number(LS_ANGLE_VAL ) : DEF_ANGLE,
    delOut:   (LS_DELOUT_VAL != null)? Number(LS_DELOUT_VAL) : DEF_DELOUT,
    tvrSel:   (LS_TVRSEL_VAL != null)? Number(LS_TVRSEL_VAL) : DEF_TVRSEL
  });
  const pickDTRef = useRef(DEF_DATETIME);

  // アーカイブ取得のためのキューを設定
  const SetArcCacheQueue = () => {
    const opt = optionRef.current;
    let startM = 0;
    let endM   = 0;
    if (opt.dateSel) {
      // 日付指定モード
      startM = opt.datetimeM.getTime() / 60000 | 0;
      endM   = startM + opt.rangeM;
    } else {
      // 最新モード
      if (!activeDatRef.current.length) {
        // アクティブデータがなければ最新が辿れない
        arcQueueRef.current = [];
        return;
      }
      endM   = activeDatRef.current[activeDatRef.current.length - 1][0] / 60 | 0;
      startM = endM - opt.rangeM;
    }
    // アクティブデータがあれば、その時間のアーカイブデータは不要
    if (activeDatRef.current.length) endM = Math.min(endM, activeDatRef.current[0][0] / 60 | 0);
    if (startM >= endM) return; // キャッシュ不要

    // アーカイブファイルの日付はローカルタイムで切り替わるためTIMEZONEを加算してファイル列挙
    startM = GetArcUTMfromUTM(startM);
    endM   = GetArcUTMfromUTM(endM - 1);
    const queue:string[] = [];
    for(; startM <= endM; startM += ONEDAY_M) queue.push(GetArcNamefromUTM(startM));
    arcQueueRef.current = queue; // ダウンロード中のキューは削除して上書き
  }


  // スクロールオプション用（90°回転時に、自動でトップ(画面右端)にスクロール）
  const [viewAngle, setViewAngle] = useState(optionRef.current.angle);
  // HTMLSelectElement/HTMLInputElement共通
  type HTMLCommonEvent = {
    target: {
      name: string;
      value:string;
    }
  };
  const handleOptionChange = (e:HTMLCommonEvent) => {
    const name  = e.target.name;
    const value = Number(e.target.value);
    setIsPopupShown(false);   // 選択したらポップアップを自動で閉じておく
    optionRef.current = { ...optionRef.current, [name]: value}; 
    if (name === 'rangeM' || name === 'dateSel' || name === 'datetimeM') {
      SetArcCacheQueue();
      fetchArcData();
    } else if (name === 'angle') {
      localStorage.setItem(LS_ANGLE_KEY, e.target.value);
      setViewAngle(value); // 90°スクロール用
    } else if (name === 'delOut') {
      localStorage.setItem(LS_DELOUT_KEY, e.target.value);
      calcGraph();
    } else if (name === 'tvrSel') {
      localStorage.setItem(LS_TVRSEL_KEY, e.target.value);
      calcGraph();
    }
    CalcScale(); //スケールは無条件で再計算
  };

  // 日時指定に切り替え
  const ChangeDaySel = (dateSel: number, datetimeM: Date) => {
    optionRef.current = { ...optionRef.current, datetimeM: datetimeM, dateSel: dateSel};
    setIsPopupShown(false);

    // アーカイブの取得開始
    SetArcCacheQueue();
    fetchArcData();
  }

  // 独自ツールチップ用State
  const [isTooltipShown, setIsTooltipShown] = useState(false);
  const tooltopRef   = useRef<HTMLDivElement>(null);
  const tooltitleRef = useRef<HTMLDivElement>(null);
  const toolinfoRef  = useRef<HTMLDivElement>(null);
  const toollineRef  = useRef<HTMLDivElement>(null);
  const ShowTooltip: React.PointerEventHandler<HTMLDivElement> = (e) => {
    if(viewdatRef.current.length < 1) return; // データが無ければ表示しない
    if(!tooltopRef.current || !tooltitleRef.current || !toolinfoRef.current || !toollineRef.current) return; // ツールチップが無ければ計算不要

    let x = e.pageX;
    let y = e.pageY;
    const scale = scaleRef.current;
    switch(optionRef.current.angle){
      case 0:   break;
      case 90:  [x, y] = [            y, scale.totalH - x]; break;
      case 180: [x, y] = [scale.inW - x, scale.totalH - y]; break;
      case 270: [x, y] = [scale.inW - y,                x]; break;
    }
    y -= scale.topdivH;

    // 範囲外に出たら非表示にする
    if (x < - scale.y_axsis_font || y < 0 || scale.linegraphW + scale.y_axsis_font < x || scale.leftdivH < y) { // y_axsis_font分余分に入れて端を選びやすくする
      setIsTooltipShown(false);
      return;
    }
    // クリック箇所の時刻に近いデータをツールチップで表示する]
    // ※データ欠落を考慮すると、配列位置での簡易計算ができないことに留意 (時刻を走査)
    const viewdat = viewdatRef.current;
    const start_ut = viewdat[0][0];                           // 最古時刻
    const end_ut   = viewdat[viewdat.length - 1][0];  // 最新時刻
    const diff_ut  = end_ut - start_ut;               // 時刻レンジ
    const touch_ut = (x / scale.linegraphW) * diff_ut + start_ut; // タッチ位置の時刻
    let pos = 0;
    while(pos < viewdat.length - 1 && touch_ut > (viewdat[pos][0] + viewdat[pos + 1][0]) / 2) ++pos;

    // タイトルに時刻設定
    tooltitleRef.current.innerText = DateFromUT(viewdat[pos][0]);

    // 該当データの情報を表示(全情報を一括で表示する)
    let html = '';
    const graph = graphRef.current;
    if (y < scale.pwrdivH) {
      // 合計消費電力と買電按分を計算
      const pwrdat = graph.pwrchart[pos];
      const usesum = pwrdat.pwr.slice(1).reduce((s, w) => s += w);
      const buydiv = (pwrdat.pwr[0] && usesum)? Math.max((usesum + pwrdat.pwr[0]) / usesum, 0) : -1;// 買電按分は発電中のみ表示

      html = ToolFormat('電力 (回路計' + usesum + 'W)', '[W]');
      graph.pwrlist.forEach((v, i) => {
        const w = pwrdat.pwr[i] || 0; // undefinedもゼロ化
        html += ToolFormat('\u2000' + v, ((i && w && buydiv >= 0)? MyRound(buydiv * w, 0) + ' /' : '') + MyFixStr(Math.abs(w).toString()) + '', i? FillColor(i) : '#000');
      });
      graph.plglist.forEach((v, i) => {
        html += ToolFormat('\u2000' + v + ' (Plug)', (pwrdat.plg[i]? pwrdat.plg[i] : '---') + '', LineColor(i + 1));
      });
      if(usesum && pwrdat.pwr[0]) {
        //html += '<hr />' + ToolFormat('\u2006⊼\u2005自給率　　', '' + MyRoundP(-pwrdat.pwr[0] / usesum), '#000');
        //html += ToolFormat('↺自家消費率', '' + MyRoundP(Math.max(-usesum, pwrdat.pwr[0]) / pwrdat.pwr[0]), '#000');
        html += '<hr />' + ToolFormat('自給, 自消', '⊼' + MyRoundP(-pwrdat.pwr[0] / usesum) + ' ↺' + MyRoundP(Math.max(-usesum, pwrdat.pwr[0]) / pwrdat.pwr[0]), '#000');
      } 

      // ラインを移動
      toollineRef.current.style.top  = scale.topdivH + 'px';
      toollineRef.current.style.height = scale.pwrdivH + scale.pwr_bottom - scale.x_axsis_font + 'px';
    } else if(y < scale.pwrdivH + scale.tvrdivH * 3) {
      // 温湿度情報+CO2を表示
      const trvdat = graph.trvchart[pos];
  
      html = ToolFormat('温湿度', '[g/m³][℃][%]');
      graph.trvlist.forEach((v, i) => {
        html += ToolFormat('\u2000' + v, (trvdat.vh[i] !== undefined? MyRound(trvdat.vh[i]) : '---') + ', ' + (trvdat.dc[i] !== undefined? MyFixStr(MyRound(trvdat.dc[i])) : '----') + ', ' + (trvdat.rh[i] !== undefined? MyFixStr((trvdat.rh[i]) + '', 2) : '---'), LineColor(i));
      });
      // ラインを移動
      toollineRef.current.style.top  = (scale.topdivH + scale.pwrdivH) + 'px';
      toollineRef.current.style.height = scale.tvrdivH * 3 + scale.pwr_bottom - scale.x_axsis_font + 'px';
    } else {
      const co2dat = graph.co2chart[pos];
      html = ToolFormat('CO2濃度', '[ppm]');
      graph.co2list.forEach((v, i) => {
        const co2 = co2dat.CO2[i]? co2dat.CO2[i] : 0; // 0は無効値
        const col = co2 > CO2_WARNING? '#c00' : (co2 > CO2_CAUTION? '#d60': '#6a6');
        html += ToolFormat('\u2000' + v, (co2? co2 : '---') + '', col);
      });
      // ラインを移動
      toollineRef.current.style.top  = scale.topdivH + scale.pwrdivH + scale.tvrdivH * 3 + 'px';
      toollineRef.current.style.height = scale.co2divH + scale.pwr_bottom - scale.x_axsis_font + 'px';
    }
    toollineRef.current.style.left = x + 'px';
    toolinfoRef.current.innerHTML = html;
    
    // できるだけクリックした位置の近くにツールチップを移動
    const divH = tooltopRef.current.offsetHeight;
    tooltopRef.current.style.left = x + ((x < scale.inW / 2)? 10 : -tooltopRef.current.clientWidth - 10) + 'px';
    tooltopRef.current.style.top  = Math.min(y + scale.topdivH - divH / 2, scale.totalH - divH)  + 'px';
    setIsTooltipShown(true);
  }
  const handleTooltipDown: React.PointerEventHandler<HTMLDivElement> = (e) => {
    ShowTooltip(e);
    setIsPopupShown(false);// メニューと排他にする
  };
  const handleTooltipMove: React.PointerEventHandler<HTMLDivElement> = (e) => {
    if(e.pressure) ShowTooltip(e);
  }
  const handleTooltipClose = () => {
     setIsTooltipShown(false);
  };

  // アーカイブリストのフェッチ (取れるまでリトライする)
  const arcListRef = useRef<Set<string>>(new Set([]));
  useEffect(() => {
    const fetchArcList = async () => {
      let json:string[] = [];
      try {
        const response = await fetch('/list/0'); // 0=全ての年のリストを一括取得(10年分でも3650個程度)
        const arraybuf = await response.arrayBuffer();
        const restored = await decompress(arraybuf);
        json = JSON.parse(restored);
        console.log('Fetch List:', json.length, 'days, ', arraybuf.byteLength, '=>', restored.length, 'byte');
      } catch (e) {
        // 取得が失敗したらウェイト後にリトライ（asyncは一度抜けてタイマ駆動する）
        console.log('Fetch List: failed. Retry', LIST_FETCH_RETRY / 60000, 'min');
        setTimeout(fetchArcList, LIST_FETCH_RETRY);
        /*
        console.log('Add dummy sel date');
        json.push('20250216');//ZZZ
        arcListRef.current = new Set(json);
        */
        return;
      }

      // 当日はアクティブデータがあるので無条件に追加
      json.push(GetYYYYMMDD(new Date()));
      arcListRef.current = new Set(json); // 全体更新
    };

    // リストの初回フェッチはデータ取得/描画を優先して遅延実行させる(リストはオプション操作するまで不要なので後で良い)
    const timeoutlId = setTimeout(fetchArcList, LIST_FETCH_FIRST);
    return () => clearTimeout(timeoutlId);
  }, []);

  // アーカイブデータのフェッチ (ARC_CACHE_SIZE分まではキャッシュに貯めて再利用)
  const arcQueueRef = useRef<string[]>([]);
  const arcCacheRef = useRef<ArcCache>({});
  const fetchArcData = async () => {
    let limit = 9; // 一回でダウンロード可能なアーカイブ数(過剰に通信しすぎないためのリミット)
    while(limit--) {
      if(arcQueueRef.current.length < 1) {
        UpdateView(); // 全てDLできたところでview更新
        CalcScale();  // スケーリングして表示
        return; 
      }

      // キャッシュ不要なキューをスキップ
      const dt    = arcQueueRef.current[0];
      const cache = arcCacheRef.current[dt];
      if (cache !== undefined) {
        // 既にキャッシュ済みならタッチして終了
        cache.ut = Date.now();// キャッシュ利用時刻だけ更新
        arcQueueRef.current = arcQueueRef.current.slice(1);
        console.log('fetchArcData update cache', dt);
      } else if (arcListRef.current.has(dt)){
        // アーカイブリストにあればデータフェッチ
        try {
          // サーバは生のgzアーカイブファイルを投げてくるので、自前でJSON形式にしてパース
          const response = await fetch('/arc/' + dt);
          const arraybuf = await response.arrayBuffer();
          const restored = await decompress(arraybuf);
          const json: EnvRecord[] = JSON.parse('[' + restored + ']'); // 前後に'[...]'を入れて配列にしてパース
          console.log('Fetch Arc:', dt, json.length, 'min, ', arraybuf.byteLength, '=>', restored.length, 'byte');

          // 古いキャッシュの削除
          const items = Object.entries(arcCacheRef.current);
          if (items.length >= ARC_CACHE_SIZE) {
            let idx = 0;
            for(let i = items.length; --i > 0;) if (items[i][1].ut < items[idx][1].ut) idx = i;
            delete arcCacheRef.current[items[idx][0]];
            console.log('Del cache', items[idx][0]);
          }
  
          // キャッシュに追加してfetchキューから削除
          arcCacheRef.current[dt] = {dat:json, ut: Date.now()};
          arcQueueRef.current = arcQueueRef.current.slice(1);
        } catch (e) {
          console.log('Fetch Arc: failed', dt);
          break; // 残りがあっても中断しておく
        }
      } else {
        arcQueueRef.current = arcQueueRef.current.slice(1);
        console.log('fetchArcData not listed', dt);
      }
    }
    // limitを超える残存分はウェイト後にリトライ
    setTimeout(fetchArcData, ARC_FETCH_RETRY);
  };

  // アクティブ定期データフェッチ用
  const activeDatRef = useRef<EnvRecord[]>([]);;
  const lastFetchRef = useRef<number>(0);
  useEffect(() => {
    const fetchActiveData = async () => {
      try {
        // 初回は現在時刻 - DATA_HOLD_TIME分(デフォルト24H)以降を一括要求、2回目以降は最終データ時刻以降を要求(秒単位UnixTimeで指定)
        const response = await fetch('/dif/' + lastFetchRef.current); // 差分データ要求リクエスト
        const arraybuf = await response.arrayBuffer();
        const restored = await decompress(arraybuf);
        const json: EnvRecord[] = JSON.parse(restored);
        if (json.length) {
          // データを受信できたら配列末尾に結合し、必要に応じて古くなったデータを先頭から破棄
          lastFetchRef.current = json[json.length - 1][0];
          activeDatRef.current = activeDatRef.current.concat(json);
          const over = activeDatRef.current.length - DATA_HOLD_TIME;              // 余計なデータがあれば、
          if (over > 0) activeDatRef.current = activeDatRef.current.slice(over);  // カットしておく。
          console.log('Fetch Diff:', json.length, 'min, ', arraybuf.byteLength, '=>', restored.length, 'byte');

          // 最新データを更新
          UpdateView();
          CalcScale();

          // ArcListにも当日分を追加しておく　（アーカイブが無くてもアクティブデータから参照できる）
          arcListRef.current.add(GetYYYYMMDD(new Date(lastFetchRef.current * 1000)));
        }
      } catch (e) {
        console.log('Fetch Diff: failed'); // TODO なにか画面にエラー情報を出したほうがよいかな？
        // 開発用に、初回フェッチに失敗したらテスト用データを設定
        // ※正式ビルド時はエイリアスで@SampleDat.tsが空ファイルになる
        if(activeDatRef.current.length === 0 && testdat) {
          activeDatRef.current = JSON.parse(testdat); // .slice(0, 7 * 60 + 208)
          console.log('Use test data');
          UpdateView();
          CalcScale();
        }
        return;
      }
    };

    // 初回フェッチ＆定期監視設定
    if(!lastFetchRef.current) {
      // 2回マウントを考慮してlastFetchRefをフラグ代わりに使う
      lastFetchRef.current = (Date.now() / 1000 | 0) - DATA_HOLD_TIME * 60; // 最終データ時刻(初期値HOLD期間の開始時刻)
      fetchActiveData();
    }
    const intervalId = setInterval(fetchActiveData, POLLING_INTERVAL);
    return () => clearInterval(intervalId);
  }, []); // eslint-disable-line


  // View切り出し 
  // フェッチしたデータ(activeDatRef/arcCacheRef)、または表示レンジ(options.rangeM/options.dateSel/options.datetimeM)が変更されたときに更新
  const UpdateView = () => {
    const option = optionRef.current;
    viewdatRef.current = SliceViewData(activeDatRef.current, arcCacheRef.current, option.rangeM, option.dateSel? option.datetimeM.getTime() / 60000 | 0 : 0);
    calcGraph();
  };

  // グラフに表示するデータを集計(時間がかかる処理。表示範囲のデータが変わった時だけ再計算) 
  const graphRef = useRef<GraphProp>({
    pwrlist:  [], // AiSEG電力グラフ用
    plglist:  [], // SwitchBotミニプラグ用
    trvlist:  [], // 温湿度用
    co2list:  [], // CO2センサ用
    latest_pwr_ary: [], // 外周: 消費割合
    latest_pwr_dir: [], // 内周: 買電or売電比率
    gensum:   0,  // 発電合計
    usesum:   0,  // 消費合計
    dirsum:   '', // 買電or売電 差分W
    dirmsg:   '', // 買電or売電 文言
    dircol:   '#888', // 買電or売電 色味 (売電なら黒字、買電は赤字っぽくする。消費/発電とも0Wのときはグレー)

    // チャート用のデータ
    psychart: [],
    pwrchart: [],
    trvchart: [],
    co2chart: [],

    // 統計データ用
    selfC:    0,
    divuse:   [],
    divbuy:   [],
    plguse:   [],
    dcmin :   [],
    dcmax :   [],
    rhmin :   [],
    rhmax :   [],
    vhmin :   [],
    vhmax :   [],
    co2min:   [],
    co2max:   [],
    dcminA:   0,
    dcmaxA:   0,
    rhminA:   0,
    rhmaxA:   0,
    vhminA:   0,
    vhmaxA:   0,
    co2minA:  0,
    co2maxA:  0,
    pwrminA:  0,
    pwrmaxA:  0,
    vecstart: 0,

    psylegend:        [],
    lastCO2:          0,
    lastCO2col:       '#080',
    firstaiseg_ut:    0,
    lastaiseg_ut:     0,
    lastswitchbot_ut: 0,
    sigmahour:        '',
  });
  const calcGraph = () => {
    console.log('Calc graph', viewdatRef.current.length);
    if (viewdatRef.current.length < 1) return;// 無効データの時は更新しない

    // 温湿度のソースデータの選択
    const vecstart = optionRef.current.delOut; // TVRグラフの開始インデックス
    const tvrsel   = optionRef.current.tvrSel; // TVRグラフの対象範囲

    // 表示データの走査 /////////////////////////////////////////////////////////////////
    const pwrmap = new Map<string, [number, number]>(); // <AiSEG2回路, [電力和, ソートインデックス]>
    const plgmap = new Map<string, [number, number]>(); // <SBプラグ名, [電力和 、ソートインデックス]>
    const trvmap = new Map<string, [string, number]>(); // <温湿度計名, [KeyID 、ソートインデックス]>
    const co2map = new Map<string, [string, number]>(); // <CO2 濃度計, [KeyID 、ソートインデックス]>

    // 最新データの記録用
    let firstaiseg_ut = 0;
    let lastaiseg_ut = 0;
    let lastaiseg_dt: AisegObj = {use:[], gen:[]};
    const viewdat = viewdatRef.current;
    viewdat.forEach((envrecord) => {
      // AiSEG2の回路毎の消費電力和を算出
      const askey = envrecord[1][AISEG_KEY];
      const aiseg = askey && askey.dat;
      if (aiseg && 'use' in aiseg && 'gen' in aiseg) {
        // データがあればut/datを更新
        if(!firstaiseg_ut) firstaiseg_ut = askey.ut;
        lastaiseg_ut = askey.ut;
        lastaiseg_dt = aiseg;

        for (let i = 0; i < 2; ++i) {
          aiseg[i ? 'use' : 'gen'].forEach((watname) => {
            const wat = watname[0] * (i ? 1 : -1); // 発電は負、消費は正とする
            if (wat) { // 0Wでなければ追加
              const cur = pwrmap.get(watname[1]);
              if (cur) { // 既存加算
                cur[0] += wat;
              } else { // 新規追加(ソートインデックスは0にしておく)
                pwrmap.set(watname[1], [wat, 0]);
              }
            }
          });
        }
      }

      // 太陽光発電が無かった場合にもFIX_TOP_SOLAR設定時は強制で先頭を太陽光発電にする
      if (FIX_TOP_SOLAR && !pwrmap.get('太陽光発電')) pwrmap.set('太陽光発電', [-1, 0]);

      // SwitchBotのプラグ/温湿度計/CO2データがあるBotを列挙
      Object.entries(envrecord[1]).forEach(([id, v]) => {
        // SwitchBotプラグをセット（消費電力の大きい順に表示。未使用なら表示しない）
        //if (!plgmap.has(id) && 'pwrE1' in v.dat                 ) plgmap.set(v.dat.name, [id, 0]);
        if ('pwrE1' in v.dat) {
          const wat = v.dat.pwrE1 / 10;
          if (wat) {
            const cur = plgmap.get(v.dat.name);
            if (cur) { // 既存加算
              cur[0] += wat;
            } else { // 新規追加(ソートインデックスは0にしておく)
              plgmap.set(v.dat.name, [wat, 0]);
            }
          }
        }

        // 温湿度、CO2をセット（id名順に表示）
        if (!trvmap.has(id) && 'dcE1'  in v.dat && 'rh' in v.dat && (!tvrsel || 'sq' in v.dat)) trvmap.set(v.dat.name, [id, 0]);
        if (!co2map.has(id) && 'CO2'   in v.dat                                               ) co2map.set(v.dat.name, [id, 0]);
      });
    });

    // 発電量は小さい(大きな負数)順に、消費回路は電力和の大きい順にソート。温湿度はID名順にソート。
    const pwridx = [...pwrmap.entries()].sort((a, b) => (a[1][0] - b[1][0]) * ((a[1][0] > 0 && b[1][0] > 0) ? -1 : 1));
    const plgidx = [...plgmap.entries()].sort((a, b) => (a[1][0] > b[1][0]) ? -1 : 1);
    const trvidx = [...trvmap.entries()].sort((a, b) => (a[1][0] < b[1][0]) ? -1 : 1);
    const co2idx = [...co2map.entries()].sort((a, b) => (a[1][0] < b[1][0]) ? -1 : 1);
    pwridx.forEach((v, i) => v[1][1] = i);
    plgidx.forEach((v, i) => v[1][1] = i);
    trvidx.forEach((v, i) => v[1][1] = i);
    co2idx.forEach((v, i) => v[1][1] = i);

    // チャート用のデータ構築
    const pwrchart: PwrChart[] = [];
    const trvchart: TRVChart[] = [];
    const co2chart: CO2Chart[] = [];
    
    // 統計データ用
    let   selfC = 0; // 自家消費
    const divuse = new Array(pwridx.length).fill(0);    // 回路ごとの消費合計
    const divbuy = new Array(pwridx.length).fill(0);    // 回路ごとの買電の按分(#0は自家消費を入れる)
    const plguse = new Array(plgidx.length).fill(0);    // Botごとの消費合計
    const dcmin  = new Array(trvidx.length).fill(99);   // 温度のMin
    const dcmax  = new Array(trvidx.length).fill(-99);  // 温度のMax
    const rhmin  = new Array(trvidx.length).fill(100);  // 相対湿度のMin
    const rhmax  = new Array(trvidx.length).fill(0);    // 相対湿度のMax
    const vhmin  = new Array(trvidx.length).fill(99);   // 絶対湿度のMin
    const vhmax  = new Array(trvidx.length).fill(0);    // 絶対湿度のMax
    const co2min = new Array(trvidx.length).fill(9999); // CO2のMin
    const co2max = new Array(trvidx.length).fill(0);    // CO2のMax
    let pwrminA  = 0; // マイナス側に振れる
    let pwrmaxA  = 0; // プラス側に振れる

    viewdat.forEach((envrecord) => {
      // ソートした回路順にチャートに積む

      // AiSEG & SwitchBot-Plug用データバッファ確保(塗りつぶりグラフ用に値が無くても0埋めしておく)
      const pc: PwrChart = {
        ut: envrecord[0],
        pwr: new Array(pwridx.length).fill(0), // AiSEG用
        plg: new Array(plgidx.length).fill(0), // SwitchBot用
      };

      // AiSEG用のデータを積む
      const askey = envrecord[1][AISEG_KEY]
      const aiseg = askey && askey.dat;
      if (aiseg && 'use' in aiseg && 'gen' in aiseg) {
        // 消費電力の時系列グラフ用データ
        for (let i = 0; i < 2; ++i) {
          aiseg[i ? 'use' : 'gen'].forEach((watname) => {
            const idx = pwrmap.get(watname[1]);
            if (idx) {
              pc.pwr[idx[1]]  = watname[0] * (i ? 1 : -1);
              divuse[idx[1]] += watname[0];
            } 
          });
        }

        // 消費電力から太陽光分を引き、残りを按分した消費電力を算出
        let genall = 0; // 対象時間の発電量を合計
        let useall = 0; // 対象時間の消費量を合計
        aiseg.gen.forEach((watname) => { genall += watname[0]; });
        aiseg.use.forEach((watname) => { useall += watname[0]; });

        // 余剰あれば0、なければ消費量 - 発電量を按分
        const divmul = (useall > genall) ? (useall - genall) / useall : 0;
        aiseg.use.forEach((watname) => {
          const p = pwrmap.get(watname[1]);
          if (p) {
            const idx = p[1];
            if(idx) divbuy[idx] += watname[0] * divmul; // 買電按分
          }
        });

        // 太陽光の自給率/自家消費算出用　
        divbuy[0] += useall; // #0は自給率の算出用に消費合計を入れておく
        selfC     += Math.min(genall, useall); // 自家消費

        // グラフの最大最小を計算
        const sum = useall - genall;
        if (pwrminA > -genall) pwrminA = -genall;
        if (pwrmaxA < sum    ) pwrmaxA = sum; // 積み上げグラフなので上側は積算で算出
      }

      // SwitchBot温湿度 & CO2用データを積む
      const tc: TRVChart = {
        ut: envrecord[0],
        dc: [],
        rh: [],
        vh: [],
      };
      const cc: CO2Chart = {
        ut: envrecord[0],
        CO2: [],
      };
      Object.values(envrecord[1]).forEach((v) => {
        if ('dcE1' in v.dat && 'rh' in v.dat && 'name' in v.dat) {
          const idx = trvmap.get(v.dat.name);
          if (idx) {
            // 温湿度の時系列グラフ用データ
            const n = idx[1];
            const dc = v.dat.dcE1 / 10;
            const rh = v.dat.rh;
            const vh = CalcVH(dc, rh);
            tc.dc[n] = dc;
            tc.rh[n] = rh;
            tc.vh[n] = vh;

            // Min/Maxデータ更新
            if(dcmin[n] > dc) dcmin[n] = dc;
            if(dcmax[n] < dc) dcmax[n] = dc;
            if(rhmin[n] > rh) rhmin[n] = rh;
            if(rhmax[n] < rh) rhmax[n] = rh;
            if(vhmin[n] > vh) vhmin[n] = vh;
            if(vhmax[n] < vh) vhmax[n] = vh;
          }
        }
        if ('CO2' in v.dat) {
          const idx = co2map.get(v.dat.name);
          if (idx) {
            // CO2の時系列グラフ用データ
            const n = idx[1];
            const co2 = v.dat.CO2;
            cc.CO2[n] = co2;

            // Min/Maxデータ更新
            if(co2min[n] > co2) co2min[n] = co2;
            if(co2max[n] < co2) co2max[n] = co2;
          }
        }
        if ('pwrE1' in v.dat) {
          const idx = plgmap.get(v.dat.name);
          if (idx) {
            const w = v.dat.pwrE1 / 10;
            pc.plg[idx[1]] =  w;
            plguse[idx[1]] += w;

            // グラフ上の最大最小を更新
            if (pwrminA > w) pwrminA = w;
            if (pwrmaxA < w) pwrmaxA = w;
          }
        }
      });

      // グラフに積む
      pwrchart.push(pc);
      trvchart.push(tc);
      co2chart.push(cc);
    });

    // 消費電力の円グラフ用データ構築 (最新データのみ使用)
    const latest_pwr_ary: [number, [string, number], number][] = []; // 外周: 消費割合
    const latest_pwr_dir: [number, [string, number], string][] = []; // 内周: 買電or売電比率
    let gensum = 0;  // 発電合計
    let usesum = 0;  // 消費合計
    let dirsum = ''; // 買電or売電 差分W
    let dirmsg = ''; // 買電or売電 文言
    let dircol = '#888'; // 買電or売電 色味 (売電なら黒字、買電は赤字っぽくする。消費/発電とも0Wのときはグレー)

    // AiSEGデータが更新されているか確認できるようにするため、AiSEG2データの最終記録時刻をメモっておく
    if (lastaiseg_dt && 'gen' in lastaiseg_dt && lastaiseg_dt.gen.length) {
      // 発電量/消費量の合計を算出
      lastaiseg_dt.gen.forEach(v => {
        gensum += v[0];
      });
      lastaiseg_dt.use.forEach(v => {
        usesum += v[0]; // 消費はしっかり合計
        const p = pwrmap.get(v[1]);
        if (p) latest_pwr_ary.push([v[0], [v[1], v[0]], p[1]]); // 外周グラフに追加
      });
      if(usesum) {
        if (usesum <= gensum) { // 売電中 or イーブン
          // 売電中は自家消費率と余剰W数を表す
          const d= gensum - usesum; // 売電W
          dirsum = (d?'+' : '') + d;
          dirmsg = '↺' + MyRoundP(usesum / gensum);
          dircol = '#060'; //　黒字(グリーンも混ぜてみた)
          // 内側円グラフは自家消費率を表す
          latest_pwr_dir.push([usesum, ['', usesum], '#fb4']);
          latest_pwr_dir.push([d,      ['', d     ], '#ccb']);
        } else { // 買電中（自家消化率100%）
          // 買電中は自給率と不足W数を数値で表す
          const d = usesum - gensum; // 不足W
          dirsum = '' + d; // マイナスでも'-'は付けない。＋の有無で区別。
          dirmsg = '⊼\u2005' + MyRoundP(gensum / usesum);
          dircol = '#c00';//　赤字
          // 内側円グラフは自給率を表す
          latest_pwr_dir.push([gensum, ['', gensum], '#6c3']);
          latest_pwr_dir.push([d,      ['', d     ], '#ccb']);
        }
      }
    }

    // 湿り空気線図もどき用データ構築 (縦軸：容積絶対湿度[g/m³])
    const psychart: PsyChart[] = [];
    const psylegend: [number, number, number, number, string][] = [];
    let lastCO2     = 0;
    let lastCO2col  = '#080';
    let lastswitchbot_ut = 0;

    // まず空気線図の補助線の作成
    for (let x = PC_X_BEGIN; x <= PC_X_END; x += 0.5) {
      const pc: PsyChart = {
        dc: x,
        vh: NaN,        // 補助線では使用しない
        idx: ['', NaN], // 補助線では使用しない
        rhAL: [],
        zone: [],
      };
      for (let rh = 0; rh < 10; ++rh) { // 相対湿度補助線は10%刻み(10%～100%)
        pc.rhAL[rh] = CalcVH(x, (rh + 1) * 10);
      }
      // 快適ゾーン
      if (PC_ZONE_TMIN <= x && x <= PC_ZONE_TMAX) pc.zone = [Math.max(CalcVH(x, PC_ZONE_RMIN), PC_ZONE_VMIN), Math.min(CalcVH(x, PC_ZONE_RMAX), PC_ZONE_VMAX)];
      psychart.push(pc);
    }
    // 最新データで空気線図にプロット(SwitchBotの温湿度データはサーバ側で一定期間データ保持するため有効な最新値を探さず、無条件で終端を利用)
    Object.values(viewdat[viewdat.length - 1][1]).forEach((v) => {
      if ('dcE1' in v.dat && 'rh' in v.dat && 'name' in v.dat) {
        const idx = trvmap.get(v.dat.name);
        if (idx) {
          const dc = v.dat.dcE1 / 10;
          const vh = CalcVH(dc, v.dat.rh);
          psychart.push({
            dc: dc,
            vh: vh,
            idx: idx,
            rhAL: [], // プロットでは使用しない
            zone: [], // プロットでは使用しない
          });
          psylegend[idx[1]] = [idx[1], dc, v.dat.rh, vh, v.dat.name];

          //SwitchBotデータが更新されているか確認できるようにするため、温湿度データの最終記録時刻をメモっておく
          if (lastswitchbot_ut < v.ut) lastswitchbot_ut = v.ut;
        }
      }
      if ('CO2' in v.dat) {
        lastCO2 = v.dat.CO2;// CO2濃度情報があれば、これも表示しておく
        if      (lastCO2 > CO2_WARNING) lastCO2col = '#c00'; // 警告は赤字
        else if (lastCO2 > CO2_CAUTION) lastCO2col = '#d60'; // 注意は橙色
      }
    });

    // 描画に使うオブジェクトを設定
    graphRef.current = {
      pwrlist:  pwridx.map(v => v[0]),
      plglist:  plgidx.map(v => v[0]),
      trvlist:  trvidx.map(v => v[0]),
      co2list:  co2idx.map(v => v[0]),
      latest_pwr_ary: latest_pwr_ary,
      latest_pwr_dir: latest_pwr_dir,
      gensum:   gensum,
      usesum:   usesum,
      dirsum:   dirsum,
      dirmsg:   dirmsg,
      dircol:   dircol,

      psychart: psychart,
      pwrchart: pwrchart,
      trvchart: trvchart,
      co2chart: co2chart,

      selfC:    selfC,
      divuse:   divuse,
      divbuy:   divbuy,
      plguse:   plguse,

      dcmin :   dcmin,
      dcmax :   dcmax,
      rhmin :   rhmin,
      rhmax :   rhmax,
      vhmin :   vhmin,
      vhmax :   vhmax,
      co2min:   co2min,
      co2max:   co2max,
      dcminA:   Math.min(...dcmin.slice(vecstart)),
      dcmaxA:   Math.max(...dcmax.slice(vecstart)),
      rhminA:   Math.min(...rhmin.slice(vecstart)),
      rhmaxA:   Math.max(...rhmax.slice(vecstart)),
      vhminA:   Math.min(...vhmin.slice(vecstart)),
      vhmaxA:   Math.max(...vhmax.slice(vecstart)),
      co2minA:  Math.min(...co2min.slice(vecstart)),
      co2maxA:  Math.max(...co2max.slice(vecstart)),
      pwrminA:  pwrminA,
      pwrmaxA:  pwrmaxA,
      vecstart: vecstart,

      psylegend:        psylegend,
      lastCO2:          lastCO2,
      lastCO2col:       lastCO2col,
      firstaiseg_ut:    firstaiseg_ut,
      lastaiseg_ut:     lastaiseg_ut,
      lastswitchbot_ut: lastswitchbot_ut,
      sigmahour:        Math.round(viewdatRef.current.length / 6) / 10 + 'H',
    };
  };

  // 画面サイズ/回転に応じた座標・スケーリング計算
  const scaleRef = useRef<ScaleProp>({
      // 表示サイズ（90° or 270°回転時はinW/inHがswapされる）
    inW: 0,
    inH: 0,

    // 各Div/フォントサイズ比率を算出
    topdivH        : 0,
    leftdivH       : 0,
    totalH         : 0,
    pwrdivH        : 0,
    tvrdivH        : 0,
    co2divH        : 0,
    rh_div_y       : 0,
    dc_div_y       : 0,
    vh_div_y       : 0,
    co2_div_y      : 0,
    title_font     : 0,
  
    pcircle_in1R   : 0,
    pcircle_out1R  : 0,
    pcircle_in2R   : 0,
    pcircle_out2R  : 0,
  
    pcircle_cfont1 : 0,
    pcircle_cfont2 : 0,
    pcircle_cfont3 : 0,
    pcircle_cfont4 : 0,
    pcircle_cfont5 : 0,
  
    psy_top        : 0,
    psy_left       : 0,
    psy_bottom     : 0,
    psy_right      : 0,
  
    psy_tickfont   : 0,
    psy_yaxsis     : 0,
    psy_ticksize   : 0,
    psy_unit_x     : 0,
    psy_unit_y     : 0,
    psy_font       : 0,
    psy_plot       : 0,
  
    psy_rh_x       : 0,
    psy_rh_vx      : 0,
    psy_rh_y       : 0,
    psy_rh_vy      : 0,
  
    psy_legend_x   : 0,
    psy_legend_font: 0,
  
    psy_out_font   : 0,
    psy_out_x1     : 0,
    psy_out_y1     : 0,
    psy_out_x2     : 0,
    psy_out_y2     : 0,
  
    x_axsis_font   : 0,
    y_axsis_font   : 0,
    y_axsisW       : 0,
  
    legendW        : 0,
    legend_font    : 0,
    minmax_font    : 0,
    tooltip_font   : 0,
    tooltipW       : 0,
  
    pwr_bottom     : 0,
    pwr_right      : 0,
  
    limit_font     : 0,
    dat_font       : 0,
  
    tvrlegend_y    : 0,
    tvrminmax_y    : 0,
    co2legend_y    : 0,

    linegraphW    : 0,

    daytick       : [],

    // Div回転・位置設定
    divrot:	  '',
    divorg:   '',
    divtop:   0,
  });
  const CalcScale = () => {
    const viewdat = viewdatRef.current;
    if (viewdat.length < 1) return;
    const resolution = resolutionRef.current;
    console.log('Calc scaling (' + resolution.width + 'x' + resolution.height + ')', optionRef.current.angle, viewdat.length);

    // 縦持ちは、TOP1行(2列) + ログ4行(Pwr/Rh/DC/Vh/CO2) フル画面
    // 横持はタブレットは、TOP列(2行) + ログ列(Pwr/Rh/DC/Vh/CO2)の2列並びの フル画面
    // 横持はスマホは縦持ちと構成同じで、スクロール型
    const option = optionRef.current;
    const rot_yoko = option.angle === 90 || option.angle === 270;
    const inW = rot_yoko ? resolution.height : resolution.width;
    const inH = rot_yoko ? resolution.width  : resolution.height;
    const lands = inW > inH * 0.8; // 横画面？ (縦5:横4の比率より横が大きければ横画面とみなす)
    // トップDivの縦サイズ = 横サイズ/2(幅MAX) or 高さ(高さMAX)
    const halfW = Math.min(inW * 0.5, inH); // これが全体の基準のサイズ
  
    // ベースとなるDiv/フォントサイズ比率を算出
    const sc_leftdivH       = lands ? (halfW * 2) : (inH - halfW);
    const sc_totalH         = halfW + sc_leftdivH;
    const sc_pwrdivH        = sc_leftdivH * 0.30;
    const sc_tvrdivH        = sc_leftdivH * 0.18; // x3
    const sc_co2divH        = sc_leftdivH * 0.16;

    const sc_psy_ticksize   = halfW * 0.01;
  
    const sc_x_axsis_font   = halfW * 0.035;
    const sc_y_axsis_font   = halfW * 0.042;
    const sc_y_axsisW       = halfW * 0.19;
  
    const sc_legendW        = halfW * 0.63;
    const sc_legend_font    = halfW * 0.05;
    const sc_linegraphW     = inW - sc_legendW - sc_y_axsisW - sc_psy_ticksize;
    const graph = graphRef.current;
    const sc_tvrlegend_y    = Math.max(halfW + sc_pwrdivH, halfW + (graph.pwrlist.length + graph.plglist.length + 2) * sc_legend_font);

    // 線グラフのX軸の間隔はデータ数に応じて切れの良い間隔に設定
    const minut = viewdat[0                 ][0];
    const maxut = viewdat[viewdat.length - 1][0];
    const diff  = (maxut - minut) / 60;
    const space = sc_linegraphW / sc_x_axsis_font * 0.8; // ギチギチにならないように行間1/0.8を空けて計算
    const tick  = (DAYTICK_STEP.find(v => diff / v < space) || 60 * 24) * 60; // マッチしなければ1日間隔
    const ticks:number[] = [];
    for(let i = Math.ceil(minut / tick) * tick + (DAY_TIMEZONE * 60) % tick ; i <= maxut; i += tick) ticks.push(i);

    scaleRef.current = {
      inW            : inW,
      inH            : inH,
      topdivH        : halfW,
      leftdivH       : sc_leftdivH,
      totalH         : sc_totalH,
      pwrdivH        : sc_pwrdivH,
      tvrdivH        : sc_tvrdivH,
      co2divH        : sc_co2divH,

      rh_div_y       : halfW + sc_pwrdivH                        + halfW * 0.02,
      dc_div_y       : halfW + sc_pwrdivH + sc_tvrdivH * 0.95    + halfW * 0.02,
      vh_div_y       : halfW + sc_pwrdivH + sc_tvrdivH * 1.9     + halfW * 0.02,
      co2_div_y      : halfW + sc_pwrdivH + sc_tvrdivH * 3       + halfW * 0.02,
      title_font     : halfW * 0.06,
      
      pcircle_in1R   : halfW * 0.21,
      pcircle_out1R  : halfW * 0.50,
      pcircle_in2R   : halfW * 0.14,
      pcircle_out2R  : halfW * 0.18,
      
      pcircle_cfont1 : halfW * 0.040,
      pcircle_cfont2 : halfW * 0.047,
      pcircle_cfont3 : halfW * 0.075,
      pcircle_cfont4 : halfW * 0.090,
      pcircle_cfont5 : halfW * 0.075,
      
      psy_top        : halfW * 0.01,
      psy_left       : halfW * 0.05,
      psy_bottom     : halfW * 0.045 - 30, //fix!
      psy_right      : halfW * -0.05,
      
      psy_tickfont   : halfW * 0.04,
      psy_yaxsis     : halfW * 0.12,
      psy_ticksize   : sc_psy_ticksize,
      psy_unit_x     : halfW * 1.18,
      psy_unit_y     : halfW * 0.05,
      psy_font       : halfW * 0.04,
      psy_plot       : halfW * 0.25,
      
      psy_rh_x       : halfW * 1.035,
      psy_rh_vx      : halfW * 0.018,
      psy_rh_y       : halfW * 0.96,
      psy_rh_vy      : halfW * 0.026,
      
      psy_legend_x   : Math.max(halfW * 2.18 - inW, 0),
      psy_legend_font: halfW * 0.048,
      
      psy_out_font   : halfW * 0.065,
      psy_out_x1     : halfW * 0.21,
      psy_out_y1     : halfW * 0.50,
      psy_out_x2     : halfW * 1.13,
      psy_out_y2     : halfW * 0.885,
      
      x_axsis_font   : sc_x_axsis_font,
      y_axsis_font   : sc_y_axsis_font,
      y_axsisW       : sc_y_axsisW,
      
      legendW        : sc_legendW,
      legend_font    : sc_legend_font,
      minmax_font    : halfW * 0.043,
      tooltip_font   : inW * (lands ? 0.024 : 0.035),
      tooltipW       : inW * (lands ? 0.3   : 0.44),
      
      pwr_bottom     : halfW * 0.09 - 28, // fix!
      pwr_right      : halfW * 0.01,
      
      limit_font     : halfW * 0.040,
      dat_font       : halfW * 0.032,
      
      tvrlegend_y    : sc_tvrlegend_y,
      tvrminmax_y    : sc_tvrlegend_y + (graph.trvlist.length + 2) * sc_legend_font,
      co2legend_y    : halfW + sc_pwrdivH + sc_tvrdivH * 3 + sc_co2divH * 0.1,
      linegraphW     : sc_linegraphW,
      daytick        : ticks,
      
      // Div回転・位置設定
      divrot         : 'rotate(' + option.angle + 'deg)',
      divorg         : (rot_yoko? (option.angle === 90 ? 'bottom left' : 'top left') : 'center center'),
      divtop         : (rot_yoko? (option.angle === 90 ? -sc_totalH : inW) : 0),
    }
    setViewCounter(Date.now()); // スケールが確定した後に描画トリガを発動
    console.log('Update view counter')
  }

  // オプション回転(90°)設定時の自動右端スクロール用Ref
  const topDivRef = useRef<null | HTMLDivElement>(null); // トップDiv用Ref。これが見えるように回転時に自動スクロール。
  useEffect(() => {
    const scroll = () => {
      if (topDivRef.current){
        topDivRef.current.scrollIntoView(); // 90°回転以外も移動しておく
      } else {
        setTimeout(scroll, 500); // 画面が未作成ならウェイト後にスクロール
      }
    }
    const timeoutId = setTimeout(scroll, 1); // 他処理の完了後にスクロールさせる動かす
    return () => clearTimeout(timeoutId);
  }, [viewAngle]);

  // 空データの時はWaitメッセージを表示
  //console.log('View:', viewdatRef.current.length, scaleRef.current.inW, viewCounter);
  const scale = scaleRef.current;
  if (viewdatRef.current.length < 1) return (<div onClick={handlePopupClick} >データ待ち・・・</div>);
  if (scale.inW                 < 1) return (<div>・</div>);
  
  const graph  = graphRef.current;
  const option = optionRef.current;
  // DIV応答 ////////////////////////////////////////////////////////////////////
  return (
    <div style={{ position: 'absolute', left:0, top:scale.divtop, width: scale.inW, height: scale.totalH, transform: scale.divrot, transformOrigin: scale.divorg, background: 'linear-gradient(to bottom right, #ddd 0%, #fff 60%, #ddd 100%)'}}> {/* 回転制御Div */}
      {/******************************* オプションタッチ制御用Div ※この領域はフリックスクロール有効 *******************************/}
      <div style={{ order:9, position: 'absolute', left:0, top:0, width: scale.inW, height: scale.topdivH, background: '#00404000', zIndex: 4}} onClick={handlePopupClick} ref={topDivRef} />

      {/******************************* ツールチップタッチ制御用Div ※この領域はフリックスクロール無効 *******************************/}
      <div style={{ order:9, position: 'absolute', left:0, top:scale.topdivH, width: scale.linegraphW, height: scale.leftdivH, background: '#40004000', zIndex: 4, touchAction: 'none'}} onPointerDown={handleTooltipDown} onPointerMove={handleTooltipMove}/>
      <GraphMemo graph={graph} scale={scale}/>

      {/* 独自ツールチップ　※Rechartsの標準Tooltipは回転時に使えないため自作 */}
      <div className={`tooltip ${isTooltipShown ? 'shown' : ''}`} style={{ width: scale.tooltipW, fontSize:scale.tooltip_font}} onClick={handleTooltipClose} ref={tooltopRef}>
        <div style={{ width: scale.tooltipW, background: '#cfc8c0', borderRadius: '10px', textAlign: 'center', fontSize:scale.tooltip_font * 1.2}} ref={tooltitleRef}></div>
        <div style={{ textAlign:'left', lineHeight:1.1}}  ref={toolinfoRef}></div>
      </div>
      <div className={`toolline ${isTooltipShown ? 'shown' : ''}`} style={{ width: 2, height: scale.leftdivH}} ref={toollineRef} />

      {/* ポップアップメニュー ※DIVの回転に追従しない組み込みポップアップ系Inputが使えないことに注意 */}
      <div className={`popup-menu ${isPopupShown ? 'shown' : ''}`} style={{ width: scale.inW * 0.9, fontSize:scale.tooltip_font, left:scale.inW * 0.04, top: scale.inW * 0.01, textAlign: 'center' }}>
        <div style={{ width: scale.inW * 0.9, background: '#cfc8c0', borderRadius: '10px', fontSize:scale.tooltip_font * 1.2}}>オプション</div>
        <div>表示角度<br/>
          {
            VIEW_ANGLES.map(a => (
              <label key={'angL' + a}><input key={'angI' + a} type='radio' name='angle' value={a} checked={option.angle === a} onChange={handleOptionChange} /> {a}°　</label>
            ))
          }
        </div>
        <hr/>
        <div>表示期間<br/>
            {/*
              */
              VIEW_RANGES.map((r, i) => (
                <React.Fragment key={'rangeM' + i}>
                <label><input type='radio' name='rangeM' value={r * 60} checked={option.rangeM === r * 60} onChange={handleOptionChange} />{MyFixStr(r + '', 3)}時間 </label>
                {i % 4 < 3? '' : <br/>}
              </React.Fragment> 
              ))
            }
        </div>
        <hr/>
        <div>表示位置<br/>
          <label><input type='radio' name='dateSel' value={0} checked={option.dateSel === 0} onChange={handleOptionChange} />最新　</label>
          <DatePicker
            customInput={<label><input type='radio' name='dateSel' value={1} checked={option.dateSel === 1} onChange={() => {/*Close時にまとめて確定*/}}/>日時指定: {pickDTRef.current.toLocaleString().slice(0, -3)}</label>}
            /*showTimeSelect*/
            showTimeInput /* こちらの方がshowTimeSelectよりスマホで時刻選択しやすい(円形の時刻選択UIが使える) */
            timeInputLabel='スタート時刻:'
            dateFormat='yyyy/MM/dd HH:mm'
            popperPlacement={(option.angle===0)? 'bottom' : ((option.angle===90)? 'right' : 'left')}
            selected={pickDTRef.current}
            onCalendarClose={ () => { ChangeDaySel(1, pickDTRef.current); }}
            onChange={(v) => {if (v) pickDTRef.current = v; }}
            includeDates={Array.from(arcListRef.current).map(d=> GetDateFromYYYYMMDD(d))}
            timeIntervals={30}
            renderCustomHeader={({ date, decreaseMonth, increaseMonth }) => (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <button onClick={decreaseMonth} style={{ border: 'none'}}>＜</button>
                <span>{'\u2002\u2002\u2002\u2002' + date.toLocaleString('default', { month: 'long', year: 'numeric' }) + '\u2002\u2002'}
                <button onClick={() => { ChangeDaySel(1, pickDTRef.current); }}>OK</button>
                </span>
                <button onClick={increaseMonth} style={{ border: 'none'}}>＞</button>
              </div>
            )}
            formatWeekDay={(d) => {
              return {Su:'日', Mo:'月', Tu:'火', We:'水', Th:'木', Fr:'金', Sa:'土'}[d.slice(0, 2)] || '？';
            }}
          />
        </div>
        <hr/>
        
        <div>温湿度のY軸範囲<br/>
          <label ><input type='radio' name='delOut' value={0} checked={option.delOut === 0} onChange={handleOptionChange} />全データ</label>
          <label ><input type='radio' name='delOut' value={1} checked={option.delOut === 1} onChange={handleOptionChange} />#1以降(外気除外)　</label>
        </div>
        <hr/>
        <div>温湿度ソース<br/>
          <label ><input type='radio' name='tvrSel' value={0} checked={option.tvrSel === 0} onChange={handleOptionChange} />全データ</label>
          <label ><input type='radio' name='tvrSel' value={1} checked={option.tvrSel === 1} onChange={handleOptionChange} />スイッチボットのみ</label>
        </div>
        <hr/>
        <button style={{ width: scale.inW * 0.3, fontSize:scale.tooltip_font}}onClick={handlePopupClose}>閉じる</button>
      </div>
    </div>
  );
};

export default App;
