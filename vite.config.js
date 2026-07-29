import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,                        // 외부 접속 허용
    port: 8080,                        // Cloud Shell 기본 미리보기 포트
    allowedHosts: ['.cloudshell.dev'], // 미리보기 프록시 도메인 허용
    hmr: { clientPort: 443 },          // HTTPS 프록시 뒤에서 핫리로드 동작
  },
});
