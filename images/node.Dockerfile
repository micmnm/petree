FROM node:26-bookworm
RUN npm install -g @anthropic-ai/claude-code
RUN useradd -m dev
USER dev
WORKDIR /work
