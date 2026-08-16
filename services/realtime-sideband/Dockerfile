FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
# Every source module, not an enumerated list. The list silently fell behind the
# code once already: server.js gained an import of tool-schemas.js, the COPY
# lines did not, and the resulting image would have died on startup with
# ERR_MODULE_NOT_FOUND — a failure that only appears at deploy time, on a
# service whose whole job is to answer a call that is already ringing.
# Tests are .test.mjs and stay out of the image.
COPY *.js ./
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
