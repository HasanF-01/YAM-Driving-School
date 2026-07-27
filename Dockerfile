# YAM — صورة تشغيل الخادم. لا اعتماديات، فلا حاجة لمرحلة build.
FROM node:22-alpine

WORKDIR /app

# الخادم يستمع على كل الواجهات داخل الحاوية؛ المنفذ يأتي من الاستضافة
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8777

# ملفات التشغيل فقط — أدوات الفحص و .github مستثناة في .dockerignore
COPY serve.js quiz.js style.css ./
COPY *.html ./
COPY *.json ./
COPY assets ./assets

# node:alpine يوفّر مستخدم "node" غير جذر
USER node

EXPOSE 8777

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8777)+'/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "serve.js"]
