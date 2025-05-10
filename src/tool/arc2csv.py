#!/usr/bin/env python  # -*- coding: utf-8 -*-
# アーカイブデータのCSV変換ツール

################################################################################
# import
################################################################################
import json
import glob
import sys
import datetime

################################################################################
# const
################################################################################

################################################################################
# globals
################################################################################

def arc2csv(files):
    colA = set()
    colB = set()
    colC = set()
    for file in files:
        with open(file, 'r', encoding='utf-8') as f:
            for line in f:
                obj = json.loads(line.rstrip(',\n'))
                for key, value in obj[1].items():
                     dat = value['dat']
                     if 'dcE1' in dat:
                          colA.add(dat['name'] + '温度[℃]')
                     if 'rh' in dat:
                          colA.add(dat['name'] + '湿度[%]')
                     if 'CO2' in dat:
                          colA.add(dat['name'] + 'CO2濃度[ppm]')
                     if 'gen' in dat:
                          for ar in dat['gen']:
                            colB.add(ar[1] + '[W]')
                     if 'use' in dat:
                          for ar in dat['use']:
                            colC.add(ar[1] + '[W]')
                          
    print('%d件' % len(dat))
    collist = sorted(list(colA), reverse=True) + sorted(list(colB)) + sorted(list(colC))
    print('時刻,%s' % ','.join(collist))

    for file in files:
        with open(file, 'r', encoding='utf-8') as f:
            for line in f:
                cols = [''] * len(collist)
                obj = json.loads(line.rstrip(',\n'))
                for key, value in obj[1].items():
                     dat = value['dat']
                     if 'dcE1' in dat:
                          cols[collist.index(dat['name'] + '温度[℃]')] = dat['dcE1'] / 10
                     if 'rh' in dat:
                          cols[collist.index(dat['name'] + '湿度[%]')] = dat['rh']
                     if 'CO2' in dat:
                          cols[collist.index(dat['name'] + 'CO2濃度[ppm]')] = dat['CO2']
                     if 'gen' in dat:
                          for ar in dat['gen']:
                            cols[collist.index(ar[1] + '[W]')] = ar[0]
                     if 'use' in dat:
                          for ar in dat['use']:
                            cols[collist.index(ar[1] + '[W]')] = ar[0]
                print('%s,%s' % (datetime.datetime.fromtimestamp(obj[0]).strftime('%Y/%m/%d %H:%M'), ','.join([str(i) for i in cols])))
                        


################################################################################
# main (for debug)
################################################################################
if __name__ == '__main__':
	arc2csv(glob.glob(sys.argv[1]))
