# 本機圖片辨識系統 - 靜態網站部署（給 Zeabur 用）
# 這是一個純前端（HTML/CSS/JS + TensorFlow.js 模型檔）應用，
# 用 nginx 提供靜態檔案即可，不需要 Node.js / Python 執行環境。
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html

EXPOSE 80
