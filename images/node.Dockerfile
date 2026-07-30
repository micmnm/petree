FROM node:22-bookworm
RUN npm install -g @anthropic-ai/claude-code
RUN useradd -m dev
USER dev
WORKDIR /work
