# Base image ships Chromium + its exact matching driver, pinned to the same
# @playwright/test version resolved in the repo's package-lock.json - a
# mismatch between the npm package and the browser binary is a hard failure,
# not a warning, so keep this tag in sync when @playwright/test is bumped.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# sirosid-tests' own deps - the specs/helpers this image runs need them.
COPY package*.json ./
RUN npm ci

# Full repo: specs/, helpers/, configs/, playwright.config.ts, etc.
COPY . .

# conformance-runner's own (much smaller) deps.
WORKDIR /app/conformance-runner
RUN npm ci

WORKDIR /app
EXPOSE 3001
CMD ["node", "conformance-runner/server.mjs"]
