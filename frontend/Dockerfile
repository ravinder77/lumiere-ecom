FROM ubuntu:latest AS build
LABEL authors="ravinder"

WORKDIR /app

COPY package*.json .

RUN npm ci

COPY . .

CMD ["npm", "start"]
