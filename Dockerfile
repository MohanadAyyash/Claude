FROM node:22-alpine
# Chromium + Arabic fonts are used only to render PDFs (invoices, letters, e-mail attachments)
RUN apk add --no-cache chromium font-noto font-noto-arabic
WORKDIR /app
COPY . .
ENV PORT=3000 DATA_DIR=/data TRUST_PROXY=1 CHROME_PATH=/usr/bin/chromium-browser
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
