FROM mcr.microsoft.com/dotnet/sdk:8.0
RUN apt-get update && apt-get install -y curl git ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
RUN useradd -m dev
USER dev
WORKDIR /work
