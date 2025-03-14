import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { execSync } from 'child_process';

// https://vite.dev/config/

export default defineConfig(({ mode }) => {
  return {
    plugins: [
      react(),
      mode === 'doc' && {
        name:'doc-copy',
        closeBundle: () => {
          execSync('rm -rf docs/assets');
          execSync('cp -r dist/assets docs/');
          execSync('cp dist/index.html dist/favicon.png dist/manifest.json docs/');
          execSync(`sed -i 's/="\\//="/' docs/index.html`);
        }
      }
    ],
    resolve: {
      alias: {
        './@SampleDat.ts':  (mode === "production") ? "./@SampleDat.ts" : "./@SampleDat_dev.ts", //ビルド時は空データを使う
      },
    },
  };
});