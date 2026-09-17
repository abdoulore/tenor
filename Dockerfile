# Collector image: the sampler and the prediction logger, one container, one volume.
#
# Node 24 for built in fetch and native TypeScript type stripping, so there is no build
# step and no dependencies to install. The whole thing is source plus a runtime.
FROM node:24-slim

WORKDIR /app

# The collected history is copied in so a fresh volume can be seeded with it on first boot,
# keeping one continuous series rather than splitting the record between laptop and cloud.
COPY . .

ENV DATA_DIR=/data/samples \
    PRED_DIR=/data/predictions \
    SEED_FROM=/app \
    NODE_ENV=production

CMD ["node", "ops/run-all.mjs"]
