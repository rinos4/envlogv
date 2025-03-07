import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vite.dev/config/

export default defineConfig(({ mode }) => {
  return {
    plugins: [react()],
    resolve: {
      alias: {
        './@SampleDat.ts':  (mode === "development") ? "./@SampleDat_dev.ts" : "./@SampleDat.ts", //ビルド時は空データを使う
      },
    },
  };
});